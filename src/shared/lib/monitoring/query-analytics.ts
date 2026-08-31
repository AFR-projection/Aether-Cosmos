/**
 * Query Analytics Service
 *
 * Aggregates brain_retrieval_events to show which memories actually get used,
 * and which query patterns keep pulling candidates that nobody opens.
 *
 * Privacy: the events table stores `query_hash`, never the query text, so every
 * metric here is keyed on the hash. Two different questions that happen to
 * normalize to the same string share a hash; that is the intended trade-off.
 *
 * Measurement limits worth knowing before reading the numbers:
 * - Rows are written per retrieved *memory*, so a query that matched nothing
 *   leaves no row at all. A true "zero result rate" is not derivable here.
 *   `omittedRate` is the closest honest signal: candidates were surfaced and
 *   then dropped from the final context.
 * - `queryHash` is nullable (background/internal retrievals don't set it).
 *   Those rows are excluded from per-query aggregates but still count toward
 *   totals.
 */

import { db } from "@/shared/infrastructure/db";
import { sql, desc, and, eq, gte, lte, isNotNull } from "drizzle-orm";
import { brainRetrievalEvents, memories } from "@/shared/infrastructure/db/schema";

/** Outcomes that mean the memory made it into a real answer. */
const USED_OUTCOMES = ["selected", "opened", "confirmed"] as const;

/** Minimum candidates a query needs before its use rate is worth reporting. */
const LOW_RECALL_MIN_CANDIDATES = 3;

/** Below this share of used candidates, a query pattern counts as noisy. */
const LOW_RECALL_THRESHOLD = 0.3;

export type QueryPattern = {
  queryHash: string;
  /** Number of candidate memories surfaced across all runs of this query. */
  candidateCount: number;
  /** Distinct runs of this query (approximated by distinct event timestamps). */
  runCount: number;
  /** Candidates that were actually used (selected/opened/confirmed). */
  usedCount: number;
  /** Candidates surfaced then dropped from context. */
  omittedCount: number;
  avgScore: number;
  lastSeen: Date;
};

export type LowRecallQuery = {
  queryHash: string;
  candidateCount: number;
  usedCount: number;
  /** usedCount / candidateCount — low means noisy retrieval. */
  useRate: number;
  lastSeen: Date;
};

export type RetrievalStats = {
  /** Total retrieval events (one per surfaced memory). */
  totalEvents: number;
  /** Events carrying a query hash — the subset per-query stats are built from. */
  attributedEvents: number;
  uniqueQueries: number;
  avgCandidatesPerQuery: number;
  /** Share of candidates that were surfaced and then dropped. */
  omittedRate: number;
  topQueryHashes: QueryPattern[];
  lowRecallQueries: LowRecallQuery[];
};

/** `('selected','opened','confirmed')` built from the constant above. */
const usedOutcomeList = sql.join(
  USED_OUTCOMES.map((outcome) => sql`${outcome}`),
  sql`, `
);

/** Bare aggregate, so callers can cast it to whatever they need. */
const usedCountExpr = sql`count(*) filter (where ${brainRetrievalEvents.outcome} in (${usedOutcomeList}))`;

const usedFilter = sql<number>`${usedCountExpr}::int`;
const omittedFilter = sql<number>`count(*) filter (where ${brainRetrievalEvents.outcome} = 'omitted')::int`;

/**
 * Get retrieval statistics for a brain over a time period.
 */
export async function getRetrievalStats(
  brainId: string,
  since: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // last 7 days
): Promise<RetrievalStats> {
  const scope = and(
    eq(brainRetrievalEvents.brainId, brainId),
    gte(brainRetrievalEvents.createdAt, since)
  );

  const [totals] = await db
    .select({
      totalEvents: sql<number>`count(*)::int`,
      attributedEvents: sql<number>`count(${brainRetrievalEvents.queryHash})::int`,
      uniqueQueries: sql<number>`count(distinct ${brainRetrievalEvents.queryHash})::int`,
      omittedCount: omittedFilter,
    })
    .from(brainRetrievalEvents)
    .where(scope);

  const totalEvents = totals?.totalEvents ?? 0;
  const attributedEvents = totals?.attributedEvents ?? 0;
  const uniqueQueries = totals?.uniqueQueries ?? 0;
  const omittedCount = totals?.omittedCount ?? 0;

  const attributedScope = and(scope, isNotNull(brainRetrievalEvents.queryHash));

  const topQueries = await db
    .select({
      queryHash: sql<string>`${brainRetrievalEvents.queryHash}`,
      candidateCount: sql<number>`count(*)::int`,
      runCount: sql<number>`count(distinct ${brainRetrievalEvents.createdAt})::int`,
      usedCount: usedFilter,
      omittedCount: omittedFilter,
      avgScore: sql<number | null>`avg(${brainRetrievalEvents.score})`,
      lastSeen: sql<Date>`max(${brainRetrievalEvents.createdAt})`,
    })
    .from(brainRetrievalEvents)
    .where(attributedScope)
    .groupBy(brainRetrievalEvents.queryHash)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  // Queries that keep surfacing candidates nobody uses.
  const lowRecall = await db
    .select({
      queryHash: sql<string>`${brainRetrievalEvents.queryHash}`,
      candidateCount: sql<number>`count(*)::int`,
      usedCount: usedFilter,
      lastSeen: sql<Date>`max(${brainRetrievalEvents.createdAt})`,
    })
    .from(brainRetrievalEvents)
    .where(attributedScope)
    .groupBy(brainRetrievalEvents.queryHash)
    .having(
      sql`count(*) >= ${LOW_RECALL_MIN_CANDIDATES} and (${usedCountExpr})::numeric / count(*) < ${LOW_RECALL_THRESHOLD}`
    )
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  return {
    totalEvents,
    attributedEvents,
    uniqueQueries,
    avgCandidatesPerQuery:
      uniqueQueries > 0 ? attributedEvents / uniqueQueries : 0,
    omittedRate: totalEvents > 0 ? omittedCount / totalEvents : 0,
    topQueryHashes: topQueries.map((q) => ({
      queryHash: q.queryHash,
      candidateCount: q.candidateCount,
      runCount: q.runCount,
      usedCount: q.usedCount,
      omittedCount: q.omittedCount,
      avgScore: q.avgScore ?? 0,
      lastSeen: q.lastSeen,
    })),
    lowRecallQueries: lowRecall.map((q) => ({
      queryHash: q.queryHash,
      candidateCount: q.candidateCount,
      usedCount: q.usedCount,
      useRate: q.candidateCount > 0 ? q.usedCount / q.candidateCount : 0,
      lastSeen: q.lastSeen,
    })),
  };
}

/**
 * Suggest improvements to query understanding based on observed patterns.
 */
export type QueryImprovement = {
  type: "stopword" | "imperative" | "phrase" | "lexicon";
  suggestion: string;
  evidence: string;
  priority: "high" | "medium" | "low";
};

export async function suggestQueryImprovements(
  brainId: string,
  since: Date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // last 30 days
): Promise<QueryImprovement[]> {
  const stats = await getRetrievalStats(brainId, since);
  const improvements: QueryImprovement[] = [];

  // Most candidates get dropped => retrieval is surfacing noise.
  if (stats.omittedRate > 0.5 && stats.totalEvents >= 20) {
    improvements.push({
      type: "stopword",
      suggestion:
        "Review the stopword list — most retrieved candidates are dropped before they reach the answer",
      evidence: `${Math.round(stats.omittedRate * 100)}% of ${stats.totalEvents} candidates were omitted`,
      priority: "high",
    });
  }

  if (stats.lowRecallQueries.length > 5) {
    improvements.push({
      type: "phrase",
      suggestion:
        "Improve phrase detection — several query patterns repeatedly surface candidates nobody uses",
      evidence: `${stats.lowRecallQueries.length} query patterns with under ${Math.round(LOW_RECALL_THRESHOLD * 100)}% use rate`,
      priority: "high",
    });
  }

  // Same handful of queries run over and over with poor uptake.
  const repeatRatio =
    stats.uniqueQueries > 0 ? stats.attributedEvents / stats.uniqueQueries : 0;
  if (repeatRatio > 5 && stats.omittedRate > 0.4) {
    improvements.push({
      type: "lexicon",
      suggestion:
        "Expand the entity lexicon — a small set of queries repeats without landing useful memories",
      evidence: `${stats.avgCandidatesPerQuery.toFixed(1)} candidates per query across only ${stats.uniqueQueries} distinct queries, ${Math.round(stats.omittedRate * 100)}% omitted`,
      priority: "medium",
    });
  }

  return improvements;
}

/**
 * Memory recall frequency analysis.
 */
export type MemoryRecallStats = {
  memoryId: string;
  title: string;
  recallCount: number;
  usedCount: number;
  lastRecalled: Date | null;
  avgScore: number;
};

export async function getTopRecalledMemories(
  brainId: string,
  limit: number = 20,
  since: Date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
): Promise<MemoryRecallStats[]> {
  const results = await db
    .select({
      memoryId: brainRetrievalEvents.memoryId,
      title: memories.title,
      recallCount: sql<number>`count(*)::int`,
      usedCount: usedFilter,
      lastRecalled: sql<Date | null>`max(${brainRetrievalEvents.createdAt})`,
      avgScore: sql<number | null>`avg(${brainRetrievalEvents.score})`,
    })
    .from(brainRetrievalEvents)
    .innerJoin(memories, eq(brainRetrievalEvents.memoryId, memories.id))
    .where(
      and(
        eq(brainRetrievalEvents.brainId, brainId),
        gte(brainRetrievalEvents.createdAt, since)
      )
    )
    .groupBy(brainRetrievalEvents.memoryId, memories.title)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return results.map((r) => ({
    memoryId: r.memoryId,
    title: r.title,
    recallCount: r.recallCount,
    usedCount: r.usedCount,
    lastRecalled: r.lastRecalled,
    avgScore: r.avgScore ?? 0,
  }));
}

/**
 * Memories old enough to have been retrieved, that never have been.
 */
export async function getOrphanedMemories(
  brainId: string,
  daysSinceCreated: number = 90
): Promise<Array<{ id: string; title: string; createdAt: Date }>> {
  const threshold = new Date(Date.now() - daysSinceCreated * 24 * 60 * 60 * 1000);

  return db
    .select({
      id: memories.id,
      title: memories.title,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        eq(memories.validityState, "active"),
        lte(memories.createdAt, threshold),
        sql`not exists (
          select 1 from ${brainRetrievalEvents}
          where ${brainRetrievalEvents.memoryId} = ${memories.id}
        )`
      )
    )
    .orderBy(memories.createdAt)
    .limit(50);
}
