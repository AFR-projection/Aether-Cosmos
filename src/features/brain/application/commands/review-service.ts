import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { brainReviewItems, memories } from "@/shared/infrastructure/db/schema";
import type { BrainHealthReport, HealthIssue } from "@brain/application/queries/health-service";

/**
 * Human review queue (P6).
 *
 * Health analysis is read-only and forgets everything the moment it returns. This
 * module is the durable half: it turns findings into rows a person can work
 * through, and it is the ONLY place a finding is ever marked resolved.
 *
 * Three rules shape the whole module:
 *
 *  1. **Nothing is auto-resolved.** A contradiction never disappears because the
 *     scanner stopped seeing it; only `resolveReviewItem` closes a row, and it
 *     records who did it. Re-scans refresh evidence, never status.
 *  2. **Re-scanning must not flood.** Every item carries a deterministic
 *     `dedupeKey` (kind + sorted memory ids) with a unique index behind it, so the
 *     hundredth scan of the same brain updates a hundred rows instead of inserting
 *     ten thousand.
 *  3. **A dismissed item stays dismissed.** The upsert deliberately leaves `status`
 *     alone, so telling the system "this is fine" survives the next scan.
 *
 * Evidence is bounded and structural — scores, overlaps, counts. No memory content
 * is copied into the queue.
 */

/** Which health issues are worth a person's time, and what kind of review they are. */
const REVIEW_KIND_OF: Partial<Record<HealthIssue["type"], schema.BrainReviewItem["kind"]>> = {
  contradiction: "contradiction",
  orphan: "orphan",
  stale: "stale",
  low_confidence: "low_confidence_important",
  // `weak_link` and `unconfirmed` are reported by health but not queued: one link is
  // not a defect, and "never confirmed" describes most memories on the day they are
  // written. Queueing either would bury the items that do need a decision.
};

/** Ordering hint for the queue. Higher is more urgent. */
const PRIORITY_OF: Record<schema.BrainReviewItem["kind"], number> = {
  contradiction: 0.9,
  duplicate: 0.7,
  low_confidence_important: 0.5,
  missing_entities: 0.4,
  orphan: 0.3,
  stale: 0.2,
};

export type ReviewItemInput = {
  kind: schema.BrainReviewItem["kind"];
  memoryId: string;
  relatedMemoryId?: string | null;
  reason: string;
  evidence?: Record<string, unknown> | null;
  priority?: number;
};

/**
 * Deterministic identity for a finding: same finding ⇒ same key, on every machine,
 * in any argument order. Pair kinds sort their ids so (A,B) and (B,A) collapse.
 */
export function reviewDedupeKey(
  kind: schema.BrainReviewItem["kind"],
  memoryIds: string[]
): string {
  return `${kind}:${[...memoryIds].filter(Boolean).sort().join(":")}`;
}

/**
 * Insert or refresh review items.
 *
 * Returns the number of rows written. `status`, `resolvedAt` and `resolvedBy` are
 * never touched by an upsert — see rule 3 above.
 */
export async function upsertReviewItems(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  items: ReviewItemInput[]
): Promise<number> {
  if (items.length === 0) return 0;

  const byKey = new Map<string, schema.NewBrainReviewItem>();
  for (const item of items) {
    const ids = [item.memoryId, ...(item.relatedMemoryId ? [item.relatedMemoryId] : [])];
    const dedupeKey = reviewDedupeKey(item.kind, ids);
    // Last write wins inside one batch: the unique index would reject a second row
    // with the same key in the same statement.
    byKey.set(dedupeKey, {
      brainId,
      kind: item.kind,
      memoryId: item.memoryId,
      relatedMemoryId: item.relatedMemoryId ?? null,
      dedupeKey,
      reason: item.reason,
      evidence: item.evidence ?? null,
      priority: item.priority ?? PRIORITY_OF[item.kind],
    });
  }

  const values = Array.from(byKey.values());

  await db
    .insert(brainReviewItems)
    .values(values)
    .onConflictDoUpdate({
      target: [brainReviewItems.brainId, brainReviewItems.dedupeKey],
      set: {
        reason: sql`excluded.reason`,
        evidence: sql`excluded.evidence`,
        priority: sql`excluded.priority`,
        updatedAt: new Date(),
      },
    });

  return values.length;
}

/**
 * Run health analysis' findings into the queue.
 *
 * The report is passed in rather than fetched so the caller decides the scan's cost
 * and scope, and so this stays testable without a database.
 */
export async function syncReviewQueue(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  report: BrainHealthReport
): Promise<number> {
  const items: ReviewItemInput[] = [];

  for (const issue of report.issues) {
    const kind = REVIEW_KIND_OF[issue.type];
    if (!kind) continue;

    // Only genuinely important low-confidence memories are worth a decision; the
    // rest are just young. Health does not report importance, so the queue keys on
    // the pairing instead: a low-confidence memory that also contradicts something
    // arrives as a contradiction, which outranks it anyway.
    items.push({
      kind,
      memoryId: issue.memoryId,
      relatedMemoryId: issue.conflictsWith?.id ?? null,
      reason: issue.reason,
      evidence: {
        issueType: issue.type,
        severity: issue.severity,
        ...(issue.conflictsWith ? { conflictsWithId: issue.conflictsWith.id } : {}),
      },
    });
  }

  return upsertReviewItems(db, brainId, items);
}

export type ReviewItemView = {
  id: string;
  kind: schema.BrainReviewItem["kind"];
  status: schema.BrainReviewItem["status"];
  memoryId: string | null;
  memoryTitle: string | null;
  relatedMemoryId: string | null;
  relatedMemoryTitle: string | null;
  reason: string;
  evidence: unknown;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * List the queue for one brain, most urgent first.
 *
 * Titles are resolved with a brain-scoped lookup, so a row whose memory has been
 * deleted (or belongs elsewhere) shows a null title rather than leaking anything.
 */
export async function listReviewItems(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  options: { status?: schema.BrainReviewItem["status"]; limit?: number } = {}
): Promise<ReviewItemView[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const status = options.status ?? "open";

  const rows = await db
    .select({
      id: brainReviewItems.id,
      kind: brainReviewItems.kind,
      status: brainReviewItems.status,
      memoryId: brainReviewItems.memoryId,
      relatedMemoryId: brainReviewItems.relatedMemoryId,
      reason: brainReviewItems.reason,
      evidence: brainReviewItems.evidence,
      priority: brainReviewItems.priority,
      createdAt: brainReviewItems.createdAt,
      updatedAt: brainReviewItems.updatedAt,
    })
    .from(brainReviewItems)
    .where(and(eq(brainReviewItems.brainId, brainId), eq(brainReviewItems.status, status)))
    .orderBy(desc(brainReviewItems.priority), asc(brainReviewItems.createdAt))
    .limit(limit);

  const ids = Array.from(
    new Set(rows.flatMap((row) => [row.memoryId, row.relatedMemoryId].filter(Boolean) as string[]))
  );

  const titleOf = new Map<string, string>();
  if (ids.length > 0) {
    const titles = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(and(eq(memories.brainId, brainId), inArray(memories.id, ids)));
    for (const row of titles) titleOf.set(row.id, row.title);
  }

  return rows.map((row) => ({
    ...row,
    memoryTitle: row.memoryId ? titleOf.get(row.memoryId) ?? null : null,
    relatedMemoryTitle: row.relatedMemoryId ? titleOf.get(row.relatedMemoryId) ?? null : null,
  }));
}

/**
 * Close one review item.
 *
 * The only path to a non-open status. The brain id is part of the predicate, so an
 * item id from another brain updates nothing and returns false — the caller cannot
 * resolve across a tenant boundary even with a valid id.
 *
 * `resolved` means the underlying knowledge was fixed; `dismissed` means a human
 * judged the finding not worth acting on. Both are decisions, and both are recorded
 * with who made them.
 */
export async function resolveReviewItem(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  itemId: string,
  status: "resolved" | "dismissed",
  resolvedBy: string | null = null
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(brainReviewItems)
    .set({ status, resolvedAt: now, resolvedBy, updatedAt: now })
    .where(and(eq(brainReviewItems.id, itemId), eq(brainReviewItems.brainId, brainId)))
    .returning({ id: brainReviewItems.id });

  return updated.length > 0;
}

/** Counts per status, for a header badge. Cheap enough to call on every page load. */
export async function reviewQueueCounts(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string
): Promise<Record<schema.BrainReviewItem["status"], number>> {
  const rows = await db
    .select({ status: brainReviewItems.status, count: sql<number>`count(*)::int` })
    .from(brainReviewItems)
    .where(eq(brainReviewItems.brainId, brainId))
    .groupBy(brainReviewItems.status);

  const counts: Record<schema.BrainReviewItem["status"], number> = {
    open: 0,
    dismissed: 0,
    resolved: 0,
  };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

// ── application-connection wrappers ────────────────────────────────────────

export function syncBrainReviewQueue(brainId: string, report: BrainHealthReport): Promise<number> {
  return syncReviewQueue(applicationDb, brainId, report);
}

export function getBrainReviewItems(
  brainId: string,
  options?: { status?: schema.BrainReviewItem["status"]; limit?: number }
): Promise<ReviewItemView[]> {
  return listReviewItems(applicationDb, brainId, options);
}

export function resolveBrainReviewItem(
  brainId: string,
  itemId: string,
  status: "resolved" | "dismissed",
  resolvedBy?: string | null
): Promise<boolean> {
  return resolveReviewItem(applicationDb, brainId, itemId, status, resolvedBy ?? null);
}

export function getBrainReviewCounts(
  brainId: string
): Promise<Record<schema.BrainReviewItem["status"], number>> {
  return reviewQueueCounts(applicationDb, brainId);
}
