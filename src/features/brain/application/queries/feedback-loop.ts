import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memories, brainRetrievalEvents } from "@/shared/infrastructure/db/schema";

/**
 * Retrieval feedback loop (P10): record what usage happened, so ranking can read it.
 *
 * Every time a memory is retrieved, opened, confirmed, corrected or superseded, this
 * module writes two things:
 *
 *  1. **Counters on the memory** — `recallCount`, `confirmationCount`,
 *     `lastRecalledAt`, `lastConfirmedAt`, `lastAccessedAt`. These are the durable
 *     usage state.
 *  2. **One telemetry row** in `brain_retrieval_events`, for analytics and for
 *     reconstructing how a ranking came about. Content-free by construction.
 *
 * This module deliberately does NOT apply a score multiplier of its own. Ranking
 * already consumes these counters through the `reinforcement` quality signal in
 * `src/features/brain/domain/retrieval/score.ts`, which is bounded (both counts saturate) and decays
 * with a half-life since the last recall. A second multiplier layered on top of that
 * would double-count usage — which is the runaway feedback the design forbids. One
 * place decides how usage affects rank, and it is the scorer.
 *
 * Nothing here deletes or hides knowledge: staleness and disuse move a memory down
 * the ranking, never out of the brain.
 */

export type FeedbackSignal = {
  memoryId: string;
  signalType: "recalled" | "opened" | "confirmed" | "corrected" | "superseded";
  timestamp: Date;
  userId: string | null;
  agentId: string | null;
};

export type FeedbackSignalType = FeedbackSignal["signalType"];

/**
 * Signal → `brain_retrieval_outcome` enum. Only the naming differs: "recalled" is
 * the service-level word for what the telemetry table calls "retrieved".
 */
const OUTCOME_OF: Record<FeedbackSignalType, schema.BrainRetrievalEvent["outcome"]> = {
  recalled: "retrieved",
  opened: "opened",
  confirmed: "confirmed",
  corrected: "corrected",
  superseded: "superseded",
};

/**
 * Salted SHA-256 of a normalized query, truncated to 32 hex chars.
 *
 * The raw query is NEVER stored: Brain content must not leak into analytics. The
 * hash exists only to group the events of one retrieval together. Set
 * `BRAIN_QUERY_SALT` to make the hashes unguessable across deployments.
 */
export function hashQuery(query: string): string {
  const salt = process.env.BRAIN_QUERY_SALT ?? "brain-query-hash-v1";
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${salt}:${normalized}`).digest("hex").slice(0, 32);
}

export type FeedbackContext = {
  /** Surface that produced the signal, e.g. `brain_read`, `brain_context`. */
  tool: string;
  /** Output of {@link hashQuery} — never the raw query text. */
  queryHash?: string | null;
  rank?: number | null;
  score?: number | null;
};

/**
 * Record a feedback signal for one memory.
 *
 * @param db - Database connection
 * @param brainId - Brain (tenant isolation)
 * @param memoryId - Memory that was interacted with
 * @param signalType - Type of interaction
 * @param userId - User who triggered the signal (if any)
 * @param agentId - Agent who triggered the signal (if any)
 */
export async function recordFeedback(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string,
  signalType: FeedbackSignalType,
  userId: string | null = null,
  agentId: string | null = null,
  context: FeedbackContext = { tool: "unspecified" }
): Promise<void> {
  const now = new Date();

  // Update memory counters based on signal type.
  switch (signalType) {
    case "recalled":
    case "opened":
      await db
        .update(memories)
        .set({
          recallCount: sql`${memories.recallCount} + 1`,
          lastRecalledAt: now,
          lastAccessedAt: now,
        })
        .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId)));
      break;

    case "confirmed":
      await db
        .update(memories)
        .set({
          confirmationCount: sql`${memories.confirmationCount} + 1`,
          lastConfirmedAt: now,
          lastAccessedAt: now,
          confidence: sql`LEAST(1.0, ${memories.confidence} + 0.05)`, // Small confidence boost
        })
        .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId)));
      break;

    case "corrected":
      // Corrected = user/agent edited the memory, implies it was used but needed refinement.
      await db
        .update(memories)
        .set({
          lastAccessedAt: now,
          // Slight confidence penalty since it needed correction.
          confidence: sql`GREATEST(0.0, ${memories.confidence} - 0.05)`,
        })
        .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId)));
      break;

    case "superseded":
      // Memory was replaced by a newer version.
      await db
        .update(memories)
        .set({
          validityState: "superseded",
          lastAccessedAt: now,
        })
        .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId)));
      break;
  }

  // Telemetry row for the analytics/ranking history. Best-effort on purpose: the
  // counters above are what ranking reads, so a telemetry failure must never turn a
  // successful read into an error. Nothing here carries memory text or query text.
  try {
    await db.insert(brainRetrievalEvents).values({
      brainId,
      memoryId,
      queryHash: context.queryHash ?? null,
      tool: context.tool,
      outcome: OUTCOME_OF[signalType],
      rank: context.rank ?? null,
      score: context.score ?? null,
      userId,
      agentId,
    });
  } catch {
    // Swallowed deliberately — see above. No content is logged either way.
  }
}

/**
 * Service wrapper using the application database connection.
 */
export function recordMemoryFeedback(
  brainId: string,
  memoryId: string,
  signalType: FeedbackSignalType,
  userId?: string | null,
  agentId?: string | null,
  context: FeedbackContext = { tool: "unspecified" }
): Promise<void> {
  return recordFeedback(applicationDb, brainId, memoryId, signalType, userId, agentId, context);
}

