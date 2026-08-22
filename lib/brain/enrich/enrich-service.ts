import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { brainEntities, memories, memoryLinks, memoryMentions } from "@/lib/db/schema";
import {
  EXTRACTOR_VERSION,
  extractEntities,
  type ExtractedEntity,
  type KnownEntity,
} from "./extract";

/**
 * Enrichment: turn a memory's text into graph evidence, idempotently (P1).
 *
 * The pipeline is deliberately boring, because the expensive property here is not
 * cleverness but *repeatability*. Enrichment runs on create, on update, from a
 * backfill sweep and from a retried job, and every one of those runs must converge
 * on the same rows:
 *
 *   1. hash the enrichable payload; if it matches `enriched_hash` and the memory is
 *      already `ready`, do nothing at all (the idempotency key P1 asks for).
 *   2. extract entities deterministically, seeded with the entities this brain
 *      already knows so a curated node wins over a lexicon guess.
 *   3. upsert those entity nodes, *preserving* curated `description`/`metadata`.
 *   4. reconcile `memory_mentions` — the literal evidence spans.
 *   5. reconcile the derived memory→entity `mentions` links, touching only rows
 *      enrichment itself created.
 *   6. recompute `mention_count` from the mentions table, never by incrementing.
 *
 * Nothing here invents a relationship: an edge exists only where a span of this
 * memory's own text matched, and that span is stored alongside it. Memory↔memory
 * relatedness is NOT written here — it stays derived from the same shared model in
 * `lib/brain/graph/relate.ts`, so the local and global graph cannot disagree.
 *
 * Failure is contained: the memory is marked `failed` with a short, content-free
 * reason and the write path that triggered enrichment is never affected.
 */

type EnrichDb = PostgresJsDatabase<typeof schema>;
type EnrichTx = Parameters<Parameters<EnrichDb["transaction"]>[0]>[0];

/** Bumped when the pipeline's *output shape* changes, not on every tweak. */
export const ENRICHMENT_VERSION = "enrich-v1";

/**
 * Ceiling on the curated vocabulary handed to the extractor. Ordered by mention
 * count, so the entities the brain actually uses are the ones that get priority.
 */
export const KNOWN_ENTITY_LIMIT = 500;

/** Derived links carry this verb. Same vocabulary the link API already uses. */
export const MENTION_LINK_TYPE = "mentions";

/** How many memories one sweep will process. Keeps a backfill job bounded. */
export const ENRICH_SWEEP_LIMIT = 25;
export const ENRICH_SWEEP_MAX = 200;

/** `enrichment_error` is a debugging hint, not a log. It stays short. */
export const ENRICHMENT_ERROR_MAX_CHARS = 200;

/** Exactly the fields the extractor reads, so the hash tracks what matters. */
export type EnrichablePayload = {
  type?: string | null;
  title: string;
  content: string;
  summary?: string | null;
};

/**
 * Idempotency key for a memory's enrichable text.
 *
 * Fields are joined with a NUL, which cannot occur in a Postgres `text` value, so
 * no combination of titles and bodies can collide by concatenation. The extractor
 * version is part of the digest: shipping a smarter extractor invalidates every
 * hash and the next sweep re-enriches, instead of the brain silently keeping
 * results from an older set of rules.
 */
export function memoryContentHash(payload: EnrichablePayload): string {
  const parts = [
    ENRICHMENT_VERSION,
    EXTRACTOR_VERSION,
    payload.type ?? "",
    payload.title ?? "",
    payload.summary ?? "",
    payload.content ?? "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export type EnrichmentOutcome =
  /** Enrichment ran and the graph now matches this text. */
  | "ready"
  /** The text was already enriched at this hash; nothing was written. */
  | "skipped"
  /** Extraction or persistence threw; the memory is marked `failed`. */
  | "failed"
  /** No live memory with that id in that brain. Never an error. */
  | "missing";

export type EnrichmentReport = {
  brainId: string;
  memoryId: string;
  outcome: EnrichmentOutcome;
  contentHash: string | null;
  /** Entity nodes this memory now claims a mention of. */
  entities: number;
  /** Evidence spans written. */
  mentions: number;
  linksAdded: number;
  linksRemoved: number;
  /** Candidates the extractor rejected — surfaced so tuning is measurable. */
  dropped: number;
  /** Short, content-free reason. Present only when `outcome` is `failed`. */
  error?: string;
};

/**
 * Reduce a thrown error to something safe to store in a user-readable column.
 *
 * Only `error.message`, only its first line, only 200 characters. Postgres puts
 * offending *row values* in the `detail`/`where` fields of a driver error, and
 * `enrichment_error` is returned by the memory API — so nothing beyond the first
 * line of the message is allowed anywhere near it (§ no Brain content in error
 * messages). The full error still surfaces to the worker's own logs via BullMQ.
 */
export function sanitizeEnrichmentError(error: unknown): string {
  const message =
    error instanceof Error && error.message ? `${error.name}: ${error.message}` : "unknown error";
  return message.split("\n")[0].trim().slice(0, ENRICHMENT_ERROR_MAX_CHARS);
}

/**
 * The brain's curated vocabulary, as extraction seeds.
 *
 * This is what stops the graph growing a second node for something it already
 * knows: a `known` match outranks every heuristic rule, carries the existing
 * type, and resolves a defined alias back to its canonical name.
 */
async function loadKnownEntities(tx: EnrichTx, brainId: string): Promise<KnownEntity[]> {
  const rows = await tx
    .select({
      name: brainEntities.name,
      type: brainEntities.type,
      aliases: brainEntities.aliases,
    })
    .from(brainEntities)
    .where(eq(brainEntities.brainId, brainId))
    .orderBy(sql`${brainEntities.mentionCount} desc`, asc(brainEntities.name))
    .limit(KNOWN_ENTITY_LIMIT);

  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    aliases: row.aliases ?? [],
  }));
}

/**
 * Upsert one entity node and return its id.
 *
 * Written here rather than through `graph-service.upsertEntity` on purpose: that
 * helper's conflict clause sets `description` and `metadata` from its arguments,
 * which would blank a curated description every time a memory mentioning the
 * entity is re-enriched. This statement never touches either column — enrichment
 * owns provenance, humans own meaning.
 *
 * The merge is done in SQL, not read-modify-write, so two memories enriched
 * concurrently cannot lose each other's aliases. `mention_count` is deliberately
 * absent: it is recomputed from `memory_mentions` at the end of the run, never
 * incremented, because an increment is exactly what makes a re-run drift.
 */
async function upsertEntityNode(
  tx: EnrichTx,
  brainId: string,
  entity: ExtractedEntity,
  extractedBy: string,
  seenAt: Date
): Promise<string> {
  const aliases = [...new Set(entity.aliases.map((alias) => alias.trim()).filter(Boolean))].sort();

  const [row] = await tx
    .insert(brainEntities)
    .values({
      brainId,
      name: entity.name,
      type: entity.type,
      aliases,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      extractedBy,
      extractionConfidence: entity.confidence,
    })
    .onConflictDoUpdate({
      target: [brainEntities.brainId, brainEntities.name, brainEntities.type],
      set: {
        aliases: sql`ARRAY(
          SELECT DISTINCT a FROM unnest(
            coalesce(${brainEntities.aliases}, ARRAY[]::text[])
              || coalesce(excluded.aliases, ARRAY[]::text[])
          ) AS a ORDER BY a
        )`,
        firstSeenAt: sql`LEAST(coalesce(${brainEntities.firstSeenAt}, excluded.first_seen_at), excluded.first_seen_at)`,
        lastSeenAt: sql`GREATEST(coalesce(${brainEntities.lastSeenAt}, excluded.last_seen_at), excluded.last_seen_at)`,
        // A curated `manual` node keeps its provenance; only an unknown one adopts
        // the extractor's. Confidence keeps the highest value ever observed, so a
        // weaker later match cannot demote an established node.
        extractedBy: sql`coalesce(${brainEntities.extractedBy}, excluded.extracted_by)`,
        extractionConfidence: sql`GREATEST(coalesce(${brainEntities.extractionConfidence}, 0), coalesce(excluded.extraction_confidence, 0))`,
        updatedAt: seenAt,
      },
    })
    .returning({ id: brainEntities.id });

  return row.id;
}

type ApplyResult = Omit<EnrichmentReport, "brainId" | "memoryId" | "outcome" | "contentHash">;

/**
 * The whole write side of one enrichment, in one transaction.
 *
 * Reconciliation is delete-then-insert for the evidence spans, because a span is
 * identified by its offsets and those move whenever the text changes; there is no
 * stable identity to update in place. It is intersect-and-diff for the links,
 * because a link's identity IS the (memory, entity) pair.
 */
async function applyEnrichment(
  tx: EnrichTx,
  memory: { id: string; brainId: string; type: string; title: string; content: string; summary: string | null },
  seenAt: Date
): Promise<ApplyResult> {
  const known = await loadKnownEntities(tx, memory.brainId);
  const extraction = extractEntities({
    title: memory.title,
    summary: memory.summary,
    content: memory.content,
    known,
  });

  // Entities this memory used to credit. Needed before the delete, so a mention
  // that disappeared still gets its counter recomputed.
  const previous = await tx
    .selectDistinct({ entityId: memoryMentions.entityId })
    .from(memoryMentions)
    .where(eq(memoryMentions.memoryId, memory.id));

  const entityIds: string[] = [];
  const mentionRows: (typeof memoryMentions.$inferInsert)[] = [];
  const claimedSpans = new Set<string>();

  // Sorted, so two memories being enriched at the same time take row locks on the
  // shared entity nodes in the same order. Unsorted upserts of an overlapping set
  // are a textbook deadlock, and the ordering costs nothing.
  const ordered = [...extraction.entities].sort(
    (a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)
  );

  for (const entity of ordered) {
    const entityId = await upsertEntityNode(
      tx,
      memory.brainId,
      entity,
      extraction.extractedBy,
      seenAt
    );
    if (!entityIds.includes(entityId)) entityIds.push(entityId);

    for (const mention of entity.mentions) {
      // Matches memory_mentions_span_unique. Two extracted nodes must never claim
      // the same characters, but the insert cannot rely on that being true.
      const spanKey = `${entityId}:${mention.field}:${mention.startOffset}`;
      if (claimedSpans.has(spanKey)) continue;
      claimedSpans.add(spanKey);
      mentionRows.push({
        brainId: memory.brainId,
        memoryId: memory.id,
        entityId,
        field: mention.field,
        surface: mention.surface,
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
        confidence: entity.confidence,
        extractedBy: extraction.extractedBy,
      });
    }
  }

  await tx.delete(memoryMentions).where(eq(memoryMentions.memoryId, memory.id));
  if (mentionRows.length > 0) {
    await tx.insert(memoryMentions).values(mentionRows).onConflictDoNothing();
  }

  // Only rows enrichment created are eligible for removal. A `mentions` link a
  // human or an agent made through the link API carries no `derivedBy` marker and
  // is left exactly alone — the pipeline may not garbage-collect other people's
  // assertions (P1: reconcile stale relationships, never invent or destroy).
  const ownedByEnrichment = and(
    eq(memoryLinks.sourceMemoryId, memory.id),
    eq(memoryLinks.targetType, "entity"),
    eq(memoryLinks.linkType, MENTION_LINK_TYPE),
    sql`${memoryLinks.metadata} ->> 'derivedBy' IS NOT NULL`
  );

  const removed = await tx
    .delete(memoryLinks)
    .where(
      entityIds.length > 0
        ? and(ownedByEnrichment, notInArray(memoryLinks.targetEntityId, entityIds))
        : ownedByEnrichment
    )
    .returning({ targetEntityId: memoryLinks.targetEntityId });

  const added =
    entityIds.length > 0
      ? await tx
          .insert(memoryLinks)
          .values(
            entityIds.map((entityId) => ({
              brainId: memory.brainId,
              sourceMemoryId: memory.id,
              targetType: "entity" as const,
              targetEntityId: entityId,
              linkType: MENTION_LINK_TYPE,
              // The marker is what makes the row reclaimable, and the extractor
              // version is the evidence trail for how it got here.
              metadata: { derivedBy: ENRICHMENT_VERSION, extractedBy: extraction.extractedBy },
            }))
          )
          // A pre-existing link for the same pair wins; we never overwrite its
          // metadata (that is the trap in link-service's conflict clause).
          .onConflictDoNothing()
          .returning({ id: memoryLinks.id })
      : [];

  // Recomputed, never incremented: an increment is what makes a re-run drift, and
  // this number is a fact about the mentions table, not about this job.
  const touched = new Set<string>([
    ...previous.map((row) => row.entityId),
    ...entityIds,
    ...removed.map((row) => row.targetEntityId).filter((id): id is string => id != null),
  ]);

  if (touched.size > 0) {
    await tx
      .update(brainEntities)
      .set({
        mentionCount: sql`(
          SELECT count(*)::int FROM ${memoryMentions}
          JOIN ${memories} ON ${memories.id} = ${memoryMentions.memoryId}
          WHERE ${memoryMentions.entityId} = ${brainEntities.id}
            AND ${memories.deletedAt} IS NULL
        )`,
        updatedAt: seenAt,
      })
      .where(
        and(
          // Tenant scope stays on every statement, not just the read: a stray id
          // must not be able to touch another brain's node.
          eq(brainEntities.brainId, memory.brainId),
          inArray(brainEntities.id, [...touched])
        )
      );
  }

  return {
    entities: entityIds.length,
    mentions: mentionRows.length,
    linksAdded: added.length,
    linksRemoved: removed.length,
    dropped: extraction.dropped,
  };
}

function blankReport(
  brainId: string,
  memoryId: string,
  outcome: EnrichmentOutcome,
  contentHash: string | null
): EnrichmentReport {
  return {
    brainId,
    memoryId,
    outcome,
    contentHash,
    entities: 0,
    mentions: 0,
    linksAdded: 0,
    linksRemoved: 0,
    dropped: 0,
  };
}

/**
 * Enrich one memory. Never throws for an expected condition, so a sweep over a
 * brain cannot be derailed by a single bad row — the outcome is in the report.
 *
 * `brainId` is required and matched in the WHERE clause of every statement rather
 * than read out of the row: a job payload is not an authorization decision, and a
 * memory id from another tenant must resolve to `missing`, not to that memory.
 */
export async function enrichMemory(
  db: EnrichDb,
  params: { brainId: string; memoryId: string; force?: boolean; now?: Date }
): Promise<EnrichmentReport> {
  const { brainId, memoryId } = params;
  const now = params.now ?? new Date();
  const scope = and(eq(memories.id, memoryId), eq(memories.brainId, brainId));

  const [memory] = await db
    .select({
      id: memories.id,
      brainId: memories.brainId,
      type: memories.type,
      title: memories.title,
      content: memories.content,
      summary: memories.summary,
      contentHash: memories.contentHash,
      enrichedHash: memories.enrichedHash,
      enrichmentStatus: memories.enrichmentStatus,
    })
    .from(memories)
    .where(and(scope, isNull(memories.deletedAt)))
    .limit(1);

  if (!memory) return blankReport(brainId, memoryId, "missing", null);

  const contentHash = memoryContentHash(memory);

  if (!params.force && memory.enrichmentStatus === "ready" && memory.enrichedHash === contentHash) {
    // Already current. Backfill the hash column if this row predates it, but do
    // not touch anything else — and never `updatedAt`: recency ranking reads that
    // column, so a backfill sweep must not make the whole brain look freshly edited.
    if (memory.contentHash !== contentHash) {
      await db.update(memories).set({ contentHash }).where(scope);
    }
    return blankReport(brainId, memoryId, "skipped", contentHash);
  }

  await db
    .update(memories)
    .set({ contentHash, enrichmentStatus: "processing", enrichmentError: null })
    .where(scope);

  try {
    const result = await db.transaction((tx) => applyEnrichment(tx, memory, now));

    await db
      .update(memories)
      .set({
        enrichmentStatus: "ready",
        enrichedHash: contentHash,
        enrichedAt: now,
        enrichmentError: null,
      })
      .where(scope);

    return { brainId, memoryId, outcome: "ready", contentHash, ...result };
  } catch (error) {
    // `enriched_hash` is left untouched, so the next sweep retries this memory
    // instead of treating the failure as a finished state.
    const reason = sanitizeEnrichmentError(error);
    await db
      .update(memories)
      .set({ enrichmentStatus: "failed", enrichmentError: reason })
      .where(scope);

    return { ...blankReport(brainId, memoryId, "failed", contentHash), error: reason };
  }
}

export type EnrichSweepReport = {
  brainId: string;
  processed: number;
  ready: number;
  skipped: number;
  failed: number;
  /** How many memories still need a pass after this one. Drives re-queueing. */
  remaining: number;
  reports: EnrichmentReport[];
};

/**
 * Backfill sweep: enrich the next `limit` memories in a brain that are not `ready`.
 *
 * Bounded on purpose (P: "retrieval must not be O(N) per request" applies to jobs
 * too). The predicate is exactly the one `memories_enrichment_idx` covers, so
 * claiming work stays an index scan however large the brain gets, and a memory
 * left in `processing` by a crashed worker is picked up again by definition.
 *
 * Memories are processed oldest-first and one at a time: a sweep is a background
 * chore, and it must not become a burst of concurrent transactions competing with
 * live writes for the same entity rows.
 */
export async function enrichBrain(
  db: EnrichDb,
  params: { brainId: string; limit?: number; now?: Date }
): Promise<EnrichSweepReport> {
  const { brainId } = params;
  const limit = Math.min(
    Math.max(1, Math.trunc(params.limit ?? ENRICH_SWEEP_LIMIT)),
    ENRICH_SWEEP_MAX
  );
  const needsWork = and(
    eq(memories.brainId, brainId),
    isNull(memories.deletedAt),
    ne(memories.enrichmentStatus, "ready")
  );

  const batch = await db
    .select({ id: memories.id })
    .from(memories)
    .where(needsWork)
    .orderBy(asc(memories.createdAt), asc(memories.id))
    .limit(limit);

  const reports: EnrichmentReport[] = [];
  for (const row of batch) {
    reports.push(await enrichMemory(db, { brainId, memoryId: row.id, now: params.now }));
  }

  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(needsWork);

  return {
    brainId,
    processed: reports.length,
    ready: reports.filter((report) => report.outcome === "ready").length,
    skipped: reports.filter((report) => report.outcome === "skipped").length,
    failed: reports.filter((report) => report.outcome === "failed").length,
    remaining: Number(pending?.count ?? 0),
    reports,
  };
}
