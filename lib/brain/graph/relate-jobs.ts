import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, eq, isNull } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { memories } from "@/lib/db/schema";
import { generateAndLoadCandidates } from "./relate-candidates";
import { relateOne } from "./relate";
import { reconcileDerivedEdges, toDerivedEdgeInputs } from "./derived-link-service";

/**
 * PHASE 2 job bodies, extracted from the worker so they can be executed — and so
 * verified — outside BullMQ.
 *
 * `workers/index.ts` builds a `Worker` at module scope and connects to Redis on
 * import, which makes the handlers there unreachable from a test. The logic that
 * decides what gets scored, what gets written and what gets re-queued is the part
 * worth verifying against a real database, so it lives here and the worker becomes a
 * thin adapter: it unpacks the job, calls one of these, and logs the report.
 *
 * No policy lives here that is not already in the scorer or the persistence layer.
 */

/** Memories re-queued per relate_brain sweep batch. */
export const RELATE_SWEEP_LIMIT = 200;

/** Hard ceiling on one sweep, whatever the caller asks for. */
export const RELATE_SWEEP_MAX = 1000;

export type RelateMemoryReport = {
  /** Candidates the probes nominated. */
  candidates: number;
  /** Pairs the scorer gave a weight to. */
  scored: number;
  /** Pairs that cleared the storage policy. */
  survived: number;
  inserted: number;
  updated: number;
  deleted: number;
  pruned: { droppedTopK: number; droppedDegree: number; droppedGlobalCap: number };
};

/**
 * Compute derived relationships for one memory.
 *
 * Deterministic and idempotent: the reconciliation deletes exactly the rows this
 * scorer version owns for the seed and rewrites them, so a duplicate job converges on
 * the same rows instead of accumulating edges.
 *
 * A memory with no candidates still reconciles: losing every candidate has to mean
 * losing every edge, or a memory that was edited into irrelevance would keep the
 * relationships it had when it was still relevant.
 */
export async function runRelateMemoryJob(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string
): Promise<RelateMemoryReport> {
  const { seed, candidates, hashes } = await generateAndLoadCandidates(db, brainId, memoryId);

  if (candidates.length === 0) {
    const report = await reconcileDerivedEdges(db, brainId, memoryId, []);
    return {
      candidates: 0,
      scored: 0,
      survived: 0,
      inserted: report.inserted,
      updated: report.updated,
      deleted: report.deleted,
      pruned: report.pruned,
    };
  }

  const scored = relateOne(seed, candidates);

  // Scorer → storage policy: origin from family count, confidence from agreement, and
  // anything below CONF_SUGGEST_MIN dropped.
  const survivors = toDerivedEdgeInputs(scored, hashes);

  const report = await reconcileDerivedEdges(db, brainId, memoryId, survivors);

  return {
    candidates: candidates.length,
    scored: scored.length,
    survived: survivors.length,
    inserted: report.inserted,
    updated: report.updated,
    deleted: report.deleted,
    pruned: report.pruned,
  };
}

export type RelateSweepReport = {
  /** Memories the sweep found in the brain, after the batch cap. */
  found: number;
  /** Memories actually handed to the queue. */
  enqueued: number;
};

/**
 * Bounded backfill sweep: one relate_memory job per memory in the brain.
 *
 * Fan-out rather than inline work, so a 10k-memory brain cannot occupy one worker
 * slot for minutes and so each memory retries independently. The `jobId` the enqueue
 * callback receives is the dedupe key: a memory already queued by its own write path
 * is not scored twice.
 *
 * Deliberately no self-requeue: the caller decides how far to sweep by passing
 * `limit`. An unbounded self-requeuing sweep over derived edges is the kind of thing
 * that quietly rewrites a whole brain's graph in the background.
 *
 * @param enqueue - how to queue one memory. Absent (no queue configured) means the
 *   sweep reports what it found and writes nothing, rather than failing.
 */
export async function runRelateBrainJob(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  limit: number | undefined,
  enqueue: ((memoryId: string, jobId: string) => Promise<void>) | null
): Promise<RelateSweepReport> {
  const batchLimit = Math.min(limit ?? RELATE_SWEEP_LIMIT, RELATE_SWEEP_MAX);

  const rows = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt)))
    .orderBy(asc(memories.createdAt))
    .limit(batchLimit);

  if (rows.length === 0 || !enqueue) {
    return { found: rows.length, enqueued: 0 };
  }

  let enqueued = 0;
  for (const row of rows) {
    await enqueue(row.id, relateJobId(row.id));
    enqueued += 1;
  }

  return { found: rows.length, enqueued };
}

/**
 * The queue dedupe key for a memory's relate job.
 *
 * One key per memory, not per request: five rapid PATCHes to the same memory collapse
 * into one pass, which is what makes the write path's fire-and-forget request cheap.
 * Shared by every producer — `memory-service`'s write path and the worker's
 * enrichment→relate chain — so the two can never drift apart.
 */
export function relateJobId(memoryId: string): string {
  return `relate:${memoryId}`;
}
