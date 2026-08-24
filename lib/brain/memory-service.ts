import { and, asc, desc, eq, inArray, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  memories,
  memoryTagMap,
  memoryTags,
  memoryVersions,
  type Memory,
  type MemoryTag,
  type MemoryVersion,
} from "@/lib/db/schema";
import { ftsMatchOn, ftsRankOn } from "@/lib/search/fts";
import {
  MEMORY_PAGE_MAX,
  MEMORY_SEARCH_MAX,
  normalizeTags,
  type MemorySourceType,
  type MemoryType,
} from "./constants";
import {
  BrainValidationError,
  MemoryNotFoundError,
  MemoryVersionNotFoundError,
} from "./errors";
import {
  clampLimit,
  decodeMemoryCursor,
  encodeMemoryCursor,
  type MemoryCursor,
} from "./pagination";
import { memoryContentHash } from "./enrich/enrich-service";
import { deleteDerivedEdgesFor } from "./graph/derived-link-service";
import { relateJobId } from "./graph/relate-jobs";
import { enqueueJob } from "@/lib/queue";

/**
 * Ask the worker to enrich a memory (P1).
 *
 * Deliberately fire-and-forget and deliberately un-awaited by the write path: the
 * memory is already committed, and enrichment failing — or Redis being absent
 * entirely — must never turn a successful write into an error. With no worker the
 * row simply stays `enrichment_status = 'pending'` until a sweep picks it up.
 *
 * No `jobId` de-duplication on purpose: `removeOnComplete` keeps finished jobs
 * around, and a retained completed job would make BullMQ silently drop the next
 * add for the same id. Duplicate jobs are harmless here — the second one sees a
 * matching `enriched_hash` and does nothing.
 */
function requestEnrichment(brainId: string, memoryId: string): void {
  void enqueueJob("enrich_memory", { brainId, memoryId }).catch(() => {});
}

/**
 * PHASE 2: Ask the worker to compute derived relationships for a memory.
 *
 * Same fire-and-forget pattern as enrichment. Normally the worker chains relate off
 * a successful enrichment (PRINSIP 9: CREATE → enrichment → relate), so this direct
 * call is only for edits enrichment ignores but the scorer does not — tags and
 * project membership are signal families of their own.
 *
 * `jobId` dedupe collapses burst writes: five rapid PATCHes queue one relate pass.
 * Safe because reconciliation is idempotent — it rewrites the seed's edges rather
 * than adding to them.
 */
function requestRelate(brainId: string, memoryId: string): void {
  void enqueueJob("relate_memory", { brainId, memoryId }, { jobId: relateJobId(memoryId) }).catch(() => {});
}

/**
 * PHASE 2: Drop the derived edges of a memory that just went away.
 *
 * Soft delete leaves the row in place, so the FK `ON DELETE cascade` never fires and
 * `memory_derived_links` would keep pointing at a memory no reader should surface.
 * Derived edges are recomputable artifacts, so hard-deleting them costs nothing —
 * explicit `memory_links` are deliberately left alone so a restore revives them.
 *
 * Best-effort: the delete has already been committed and reported to the caller, and
 * the read paths filter `deleted_at` anyway. A failure here leaves rows that the next
 * relate pass reconciles away.
 */
function forgetDerivedEdges(brainId: string, memoryId: string): void {
  void deleteDerivedEdgesFor(db, brainId, memoryId).catch((error) => {
    console.error("failed to remove derived edges for deleted memory", error);
  });
}

export type MemoryWithTags = Memory & { tags: string[] };

type Principal = { userId: string; agentId: string | null };

/** Fields a caller may set on a memory. */
export type MemoryInput = {
  type?: MemoryType;
  title: string;
  content: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  sourceType?: MemorySourceType;
  sourceId?: string | null;
  projectId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
};

export type MemoryPatch = Partial<{
  type: MemoryType;
  title: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  projectId: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[];
  archived: boolean;
}>;

// ── tags ────────────────────────────────────────────────────────────────────

/**
 * Insert any missing tags for the brain and return their ids.
 * Two statements regardless of tag count (the first cut ran 2 per tag).
 */
async function upsertTags(tx: typeof db, brainId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];

  await tx
    .insert(memoryTags)
    .values(names.map((name) => ({ brainId, name })))
    .onConflictDoNothing();

  const rows = await tx
    .select({ id: memoryTags.id })
    .from(memoryTags)
    .where(and(eq(memoryTags.brainId, brainId), inArray(memoryTags.name, names)));

  return rows.map((row) => row.id);
}

/** Replace a memory's tag set with exactly `names`. */
async function replaceMemoryTags(
  tx: typeof db,
  brainId: string,
  memoryId: string,
  names: string[]
): Promise<void> {
  const tagIds = await upsertTags(tx, brainId, names);

  await tx.delete(memoryTagMap).where(eq(memoryTagMap.memoryId, memoryId));
  if (tagIds.length === 0) return;

  await tx
    .insert(memoryTagMap)
    .values(tagIds.map((tagId) => ({ memoryId, tagId })))
    .onConflictDoNothing();
}

/** One query that fetches the tag names for a page of memories. */
async function tagsForMemories(memoryIds: string[]): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (memoryIds.length === 0) return grouped;

  const rows = await db
    .select({ memoryId: memoryTagMap.memoryId, name: memoryTags.name })
    .from(memoryTagMap)
    .innerJoin(memoryTags, eq(memoryTags.id, memoryTagMap.tagId))
    .where(inArray(memoryTagMap.memoryId, memoryIds))
    .orderBy(asc(memoryTags.name));

  for (const row of rows) {
    const list = grouped.get(row.memoryId);
    if (list) list.push(row.name);
    else grouped.set(row.memoryId, [row.name]);
  }
  return grouped;
}

async function withTags(rows: Memory[]): Promise<MemoryWithTags[]> {
  const grouped = await tagsForMemories(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, tags: grouped.get(row.id) ?? [] }));
}

export async function listBrainTags(brainId: string): Promise<MemoryTag[]> {
  return db
    .select()
    .from(memoryTags)
    .where(eq(memoryTags.brainId, brainId))
    .orderBy(asc(memoryTags.name));
}

// ── create ──────────────────────────────────────────────────────────────────

export async function createMemory(params: {
  brainId: string;
  principal: Principal;
  data: MemoryInput;
}): Promise<MemoryWithTags> {
  const { brainId, principal, data } = params;
  const tags = normalizeTags(data.tags ?? []);
  const type = data.type ?? "fact";
  const title = data.title.trim();
  const summary = data.summary?.trim() || null;

  const created = await db.transaction(async (tx) => {
    const [memory] = await tx
      .insert(memories)
      .values({
        brainId,
        type,
        title,
        content: data.content,
        summary,
        importance: data.importance ?? 0.5,
        confidence: data.confidence ?? 0.9,
        // An agent that does not say where the memory came from is itself the source.
        sourceType: data.sourceType ?? (principal.agentId ? "agent" : "user"),
        sourceId: data.sourceId ?? null,
        createdBy: principal.agentId ? null : principal.userId,
        createdByAgent: principal.agentId,
        projectId: data.projectId ?? null,
        metadata: data.metadata ?? null,
        // Written with the row so enrichment has its idempotency key from the
        // start; `enrichment_status` keeps its `pending` default.
        contentHash: memoryContentHash({ type, title, content: data.content, summary }),
      })
      .returning();

    // Tags share the memory's transaction: a failing tag write must not leave a
    // half-tagged memory behind.
    if (tags.length > 0) {
      await replaceMemoryTags(tx, brainId, memory.id, tags);
    }

    return { ...memory, tags };
  });

  requestEnrichment(brainId, created.id);
  return created;
}

// ── read ────────────────────────────────────────────────────────────────────

export async function listMemories(params: {
  brainId: string;
  type?: MemoryType;
  tag?: string;
  projectId?: string;
  archived?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ memories: MemoryWithTags[]; nextCursor: string | null }> {
  const limit = clampLimit(params.limit, 20, MEMORY_PAGE_MAX);
  const conditions = [eq(memories.brainId, params.brainId), isNull(memories.deletedAt)];

  if (params.archived) conditions.push(isNotNull(memories.archivedAt));
  else conditions.push(isNull(memories.archivedAt));

  if (params.type) conditions.push(eq(memories.type, params.type));
  if (params.projectId) conditions.push(eq(memories.projectId, params.projectId));

  if (params.cursor) {
    const cursor = decodeMemoryCursor(params.cursor);
    if (!cursor) throw new BrainValidationError("Invalid cursor");
    conditions.push(memoryKeysetBefore(cursor));
  }

  if (params.tag) {
    const tag = params.tag.trim().toLowerCase();
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${memoryTagMap}
        INNER JOIN ${memoryTags} ON ${memoryTags.id} = ${memoryTagMap.tagId}
        WHERE ${memoryTagMap.memoryId} = ${memories.id} AND ${memoryTags.name} = ${tag}
      )`
    );
  }

  const rows = await db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    memories: await withTags(page),
    nextCursor: hasMore && last ? encodeMemoryCursor(last) : null,
  };
}

/**
 * `(created_at, id) < (cursor.created_at, cursor.id)` as a Postgres row-value
 * comparison — the exact shape of `memories_brain_keyset_idx`. Comparing
 * created_at alone drops every row that shares a timestamp with the cursor.
 * Both sides are cast explicitly so the tuple types line up.
 */
export function memoryKeysetBefore(cursor: MemoryCursor): SQL {
  return sql`(${memories.createdAt}, ${memories.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

async function findMemory(brainId: string, memoryId: string): Promise<Memory | null> {
  const [memory] = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.id, memoryId),
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt)
      )
    )
    .limit(1);
  return memory ?? null;
}

export async function getMemory(params: {
  brainId: string;
  memoryId: string;
  touch?: boolean;
}): Promise<MemoryWithTags | null> {
  const memory = await findMemory(params.brainId, params.memoryId);
  if (!memory) return null;

  if (params.touch !== false) {
    // Awaited, unlike the original `void db.update(...)` which built the query and
    // never ran it. A failure here must not fail the read.
    try {
      await db
        .update(memories)
        .set({ lastAccessedAt: new Date() })
        .where(eq(memories.id, memory.id));
    } catch (error) {
      console.error("failed to stamp memory last_accessed_at", error);
    }
  }

  const [withTag] = await withTags([memory]);
  return withTag;
}

export async function requireMemory(brainId: string, memoryId: string): Promise<Memory> {
  const memory = await findMemory(brainId, memoryId);
  if (!memory) throw new MemoryNotFoundError();
  return memory;
}

// ── update / delete ─────────────────────────────────────────────────────────

export async function updateMemory(params: {
  brainId: string;
  memoryId: string;
  principal: Principal;
  data: MemoryPatch;
  changeReason?: string;
}): Promise<MemoryWithTags> {
  const { brainId, memoryId, principal, data } = params;

  const hasContentChange =
    data.title !== undefined ||
    data.content !== undefined ||
    data.summary !== undefined ||
    data.metadata !== undefined;
  const hasAnyChange =
    hasContentChange ||
    data.type !== undefined ||
    data.importance !== undefined ||
    data.confidence !== undefined ||
    data.tags !== undefined ||
    // `projectId` belongs here for the same reason `tags` does: it is applied to the
    // row below and it is a relate signal family, so a patch that only moves a memory
    // between projects is a real change. Its absence made that PATCH a 400 and left
    // the relate request below it unreachable from that path.
    data.projectId !== undefined ||
    data.archived !== undefined;

  if (!hasAnyChange) throw new BrainValidationError("No fields to update");

  let needsEnrichment = false;

  const result = await db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE serializes concurrent PATCHes on the same memory, so
    // two writers cannot both snapshot version N and collide on the unique
    // (memory_id, version_number) index.
    const [existing] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, memoryId),
          eq(memories.brainId, brainId),
          isNull(memories.deletedAt)
        )
      )
      .for("update")
      .limit(1);

    if (!existing) throw new MemoryNotFoundError();

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.type !== undefined) patch.type = data.type;
    if (data.title !== undefined) patch.title = data.title.trim();
    if (data.content !== undefined) patch.content = data.content;
    if (data.summary !== undefined) patch.summary = data.summary?.trim() || null;
    if (data.importance !== undefined) patch.importance = data.importance;
    if (data.confidence !== undefined) patch.confidence = data.confidence;
    if (data.projectId !== undefined) patch.projectId = data.projectId;
    if (data.metadata !== undefined) patch.metadata = data.metadata;
    if (data.archived !== undefined) {
      patch.archivedAt = data.archived ? (existing.archivedAt ?? new Date()) : null;
    }

    // Re-enrichment is keyed on the hash rather than on "was a text field in the
    // patch": re-submitting identical text must not queue work, and a legacy row
    // with no hash yet must. Status returns to `pending` so the graph is never
    // silently left describing the previous version of the text.
    const nextHash = memoryContentHash({
      type: (data.type ?? existing.type) as string,
      title: data.title !== undefined ? data.title.trim() : existing.title,
      content: data.content !== undefined ? data.content : existing.content,
      summary:
        data.summary !== undefined ? data.summary?.trim() || null : existing.summary,
    });
    if (nextHash !== existing.contentHash) {
      patch.contentHash = nextHash;
      patch.enrichmentStatus = "pending";
      patch.enrichmentError = null;
      needsEnrichment = true;
    }

    // Only snapshot a version when the versioned columns actually change —
    // archiving or re-tagging should not inflate the history.
    if (hasContentChange) {
      await tx.insert(memoryVersions).values({
        memoryId: existing.id,
        versionNumber: existing.version,
        title: existing.title,
        content: existing.content,
        summary: existing.summary,
        changedBy: principal.agentId ? null : principal.userId,
        changedByAgent: principal.agentId,
        changeReason: params.changeReason ?? null,
        metadata: asJsonObject(existing.metadata),
      });
      patch.version = existing.version + 1;
    }

    const [updated] = await tx
      .update(memories)
      .set(patch)
      .where(eq(memories.id, existing.id))
      .returning();

    let tags: string[] | null = null;
    if (data.tags !== undefined) {
      tags = normalizeTags(data.tags);
      await replaceMemoryTags(tx, brainId, existing.id, tags);
    }

    if (tags !== null) return { ...updated, tags };
    const [withTag] = await withTags([updated]);
    return withTag;
  });

  if (needsEnrichment) requestEnrichment(brainId, memoryId);
  // Tags and project are relate signal families in their own right, and neither is
  // part of the enrichment hash — so an edit that only re-tags a memory changes its
  // relationships without changing `contentHash`. When enrichment does run the worker
  // chains relate itself, so asking twice would only burn a dedupe slot.
  else if (data.tags !== undefined || data.projectId !== undefined) {
    requestRelate(brainId, memoryId);
  }
  return result;
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Soft delete. Returns false when nothing matched, so the route can answer 404. */
export async function deleteMemory(params: {
  brainId: string;
  memoryId: string;
}): Promise<boolean> {
  const now = new Date();
  const deleted = await db
    .update(memories)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(memories.id, params.memoryId),
        eq(memories.brainId, params.brainId),
        isNull(memories.deletedAt)
      )
    )
    .returning({ id: memories.id });

  if (deleted.length > 0) forgetDerivedEdges(params.brainId, params.memoryId);

  return deleted.length > 0;
}

// ── search ──────────────────────────────────────────────────────────────────

/**
 * Prefix full-text search over title (weight A) + content (weight B).
 *
 * Uses the shared lib/search/fts helpers, which build the tsquery inside Postgres
 * from a bound parameter. The first cut assembled `term:*` strings in JS, so a
 * query of pure punctuation produced the tsquery `":*"` and Postgres answered
 * with a syntax error — a 500 for an ordinary search box keystroke.
 */
export async function searchMemories(params: {
  brainId: string;
  query: string;
  type?: MemoryType;
  projectId?: string;
  includeArchived?: boolean;
  limit?: number;
}): Promise<MemoryWithTags[]> {
  const q = params.query.trim();
  if (!q) return [];

  const limit = clampLimit(params.limit, 20, MEMORY_SEARCH_MAX);
  const conditions = [eq(memories.brainId, params.brainId), isNull(memories.deletedAt)];
  if (!params.includeArchived) conditions.push(isNull(memories.archivedAt));
  if (params.type) conditions.push(eq(memories.type, params.type));
  if (params.projectId) conditions.push(eq(memories.projectId, params.projectId));

  const rows = await db
    .select()
    .from(memories)
    .where(and(...conditions, ftsMatchOn(memories.searchVector, q)))
    .orderBy(
      desc(ftsRankOn(memories.searchVector, q)),
      desc(memories.importance),
      desc(memories.createdAt)
    )
    .limit(limit);

  return withTags(rows);
}

// ── versions ────────────────────────────────────────────────────────────────

/**
 * Versions of one memory. The join on `memories` is the access check: without it
 * any brain the caller owns could be used to read version history belonging to
 * somebody else's brain.
 */
export async function getMemoryVersions(params: {
  brainId: string;
  memoryId: string;
  limit?: number;
}): Promise<MemoryVersion[]> {
  await requireMemory(params.brainId, params.memoryId);

  const rows = await db
    .select({ version: memoryVersions })
    .from(memoryVersions)
    .innerJoin(memories, eq(memories.id, memoryVersions.memoryId))
    .where(
      and(
        eq(memoryVersions.memoryId, params.memoryId),
        eq(memories.brainId, params.brainId),
        isNull(memories.deletedAt)
      )
    )
    .orderBy(desc(memoryVersions.versionNumber))
    .limit(clampLimit(params.limit, 50, MEMORY_PAGE_MAX));

  return rows.map((row) => row.version);
}

/**
 * Restore a past version. Restores summary and metadata too — the first cut used
 * `summary ?? undefined`, which left the current summary in place whenever the
 * restored version had none, producing a row that matched no version at all.
 */
export async function restoreMemoryVersion(params: {
  brainId: string;
  memoryId: string;
  versionId: string;
  principal: Principal;
  reason?: string;
}): Promise<MemoryWithTags> {
  await requireMemory(params.brainId, params.memoryId);

  const [row] = await db
    .select({ version: memoryVersions })
    .from(memoryVersions)
    .innerJoin(memories, eq(memories.id, memoryVersions.memoryId))
    .where(
      and(
        eq(memoryVersions.id, params.versionId),
        eq(memoryVersions.memoryId, params.memoryId),
        eq(memories.brainId, params.brainId)
      )
    )
    .limit(1);

  if (!row) throw new MemoryVersionNotFoundError();
  const version = row.version;

  return updateMemory({
    brainId: params.brainId,
    memoryId: params.memoryId,
    principal: params.principal,
    data: {
      title: version.title,
      content: version.content,
      summary: version.summary,
      metadata: asJsonObject(version.metadata),
    },
    changeReason: params.reason ?? `Restored from version ${version.versionNumber}`,
  });
}

/** Every non-deleted memory in a brain, oldest first — used by the export route. */
export async function exportMemories(brainId: string): Promise<MemoryWithTags[]> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt)))
    .orderBy(asc(memories.createdAt), asc(memories.id));
  return withTags(rows);
}
