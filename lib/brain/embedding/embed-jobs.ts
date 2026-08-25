import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { memories } from "@/lib/db/schema";
import { embeddingInput, type EmbeddingProvider } from "../embedding/provider";
import { getEmbeddingProvider } from "../embedding/resolve";

/**
 * P9 embedding job bodies, extracted from the worker so they can run — and be verified —
 * outside BullMQ, exactly like `graph/relate-jobs.ts`.
 *
 * The write path enqueues `embed_memory` when a memory is created or its content
 * changes; `embed_brain` is the bounded backfill sweep. Both are no-ops when no provider
 * is configured, so a deployment with embeddings turned off pays nothing.
 *
 * Idempotency has two guards, so a duplicate job is cheap:
 *  - a memory whose stored `embedding_model` matches the active provider AND whose
 *    `embedding_updated_at` is at or after its `updated_at` is already fresh → skipped;
 *  - a model change (or a content edit that bumps `updated_at`) forces a re-embed.
 *
 * Writes touch only the three embedding columns, always with a brain-scoped WHERE, so a
 * job can never write across tenants and never disturbs enrichment/relate bookkeeping.
 */

/** Memories enqueued per embed_brain sweep batch. */
export const EMBED_SWEEP_LIMIT = 200;

/** Hard ceiling on one sweep, whatever the caller asks for. */
export const EMBED_SWEEP_MAX = 1000;

export type EmbedMemoryReport = {
  /** True when a vector was computed and written. */
  embedded: boolean;
  /** True when the job intentionally did nothing (see `reason`). */
  skipped: boolean;
  reason?: "unavailable" | "not_found" | "empty" | "fresh";
};

/**
 * Embed one memory. Deterministic and idempotent.
 *
 * @param provider - optional pre-resolved provider (the sweep resolves once and passes
 *   it down). Absent means resolve from the DB config here.
 */
export async function runEmbedMemoryJob(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string,
  provider?: EmbeddingProvider
): Promise<EmbedMemoryReport> {
  const active = provider ?? (await getEmbeddingProvider(db));
  if (!(await active.available())) {
    return { embedded: false, skipped: true, reason: "unavailable" };
  }

  const [memory] = await db
    .select({
      id: memories.id,
      title: memories.title,
      summary: memories.summary,
      content: memories.content,
      updatedAt: memories.updatedAt,
      embeddingModel: memories.embeddingModel,
      embeddingUpdatedAt: memories.embeddingUpdatedAt,
    })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId), isNull(memories.deletedAt)))
    .limit(1);

  if (!memory) return { embedded: false, skipped: true, reason: "not_found" };

  // Fresh: same model, and embedded at or after the last content edit.
  if (
    memory.embeddingModel === active.model &&
    memory.embeddingUpdatedAt != null &&
    memory.embeddingUpdatedAt.getTime() >= memory.updatedAt.getTime()
  ) {
    return { embedded: false, skipped: true, reason: "fresh" };
  }

  const input = embeddingInput(memory);
  if (input.length === 0) return { embedded: false, skipped: true, reason: "empty" };

  const [vector] = await active.embed([input]);
  if (!vector || vector.length === 0) return { embedded: false, skipped: true, reason: "empty" };

  const literal = `[${Array.from(vector).join(",")}]`;

  // Brain-scoped WHERE: a write can never touch another tenant's row. Only the three
  // embedding columns are set — enrichment/relate bookkeeping is untouched.
  await db.execute(sql`
    UPDATE ${memories}
    SET embedding = ${literal}::vector,
        embedding_model = ${active.model},
        embedding_updated_at = now()
    WHERE ${memories.id} = ${memoryId} AND ${memories.brainId} = ${brainId}
  `);

  return { embedded: true, skipped: false };
}

export type EmbedSweepReport = {
  /** Memories the sweep found in the brain, after the batch cap. */
  found: number;
  /** Memories actually handed to the queue. */
  enqueued: number;
};

/**
 * Bounded backfill sweep: one embed_memory job per memory in the brain, oldest first,
 * soft-deleted skipped. Mirrors `runRelateBrainJob`: fan-out rather than inline work, no
 * self-requeue, and a no-op (report only) when no queue is configured.
 */
export async function runEmbedBrainJob(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  limit: number | undefined,
  enqueue: ((memoryId: string, jobId: string) => Promise<void>) | null
): Promise<EmbedSweepReport> {
  const batchLimit = Math.min(limit ?? EMBED_SWEEP_LIMIT, EMBED_SWEEP_MAX);

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
    await enqueue(row.id, embedJobId(row.id));
    enqueued += 1;
  }

  return { found: rows.length, enqueued };
}

/**
 * The queue dedupe key for a memory's embed job. One key per memory, so rapid edits
 * collapse into one pass. Shared by every producer so they cannot drift.
 */
export function embedJobId(memoryId: string): string {
  return `embed:${memoryId}`;
}
