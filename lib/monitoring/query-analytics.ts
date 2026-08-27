/**
 * Query Analytics Service
 *
 * Tracks brain retrieval patterns to improve lexicon, stopwords, and query understanding.
 * Aggregates metrics from brain_retrieval_events without storing query text (privacy).
 */

import { db } from "../db";
import { sql, desc, and, eq, gte, lte } from "drizzle-orm";
import { brainRetrievalEvents, memories } from "../db/schema";

export type QueryPattern = {
  queryHash: string;
  count: number;
  avgScore: number;
  zeroCandidates: number;
  lastSeen: Date;
};

export type LowRecallQuery = {
  queryHash: string;
  attemptCount: number;
  avgCandidates: number;
  lastSeen: Date;
};

export type RetrievalStats = {
  totalQueries: number;
  uniqueQueries: number;
  avgCandidatesPerQuery: number;
  zeroResultRate: number;
  topQueryHashes: QueryPattern[];
  lowRecallQueries: LowRecallQuery[];
};

/**
 * Get retrieval statistics for a brain over a time period.
 */
export async function getRetrievalStats(
  brainId: string,
  since: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // last 7 days
): Promise<RetrievalStats> {
  // Total queries
  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(brainRetrievalEvents)
    .where(
      and(
        eq(brainRetrievalEvents.brainId, brainId),
        gte(brainRetrievalEvents.createdAt, since)
      )
    );

  const totalQueries = totalResult?.count ?? 0;

  // Unique query hashes
  const [uniqueResult] = await db
    .select({ count: sql<number>`count(distinct query_hash)::int` })
    .from(brainRetrievalEvents)
    .where(
      and(
        eq(brainRetrievalEvents.brainId, brainId),
        gte(brainRetrievalEvents.createdAt, since)
      )
    );

  const uniqueQueries = uniqueResult?.count ?? 0;

  // Top query patterns (by frequency)
  const topQueries = await db
    .select({
      queryHash: brainRetrievalEvents.queryHash,
      count: sql<number>`count(*)::int`,
      avgScore: sql<number>`avg(score)`,
      zeroCandidates: sql<number>`count(*) filter (where event_type = 'zero_candidates')::int`,
      lastSeen: sql<Date>`max(created_at)`,
    })
    .from(brainRetrievalEvents)
    .where(
      and(
        eq(brainRetrievalEvents.brainId, brainId),
        gte(brainRetrievalEvents.createdAt, since)
      )
    )
    .groupBy(brainRetrievalEvents.queryHash)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  // Low recall queries (many attempts, few results)
  const lowRecallQueries = await db
    .select({
      queryHash: brainRetrievalEvents.queryHash,
      attemptCount: sql<number>`count(*)::int`,
      avgCandidates: sql<number>`avg(case when event_type = 'retrieved' then 1 else 0 end)`,
      lastSeen: sql<Date>`max(created_at)`,
    })
    .from(brainRetrievalEvents)
    .where(
      and(
        eq(brainRetrievalEvents.brainId, brainId),
        gte(brainRetrievalEvents.createdAt, since)
      )
    )
    .groupBy(brainRetrievalEvents.queryHash)
    .having(sql`count(*) >= 3 AND avg(case when event_type = 'retrieved' then 1 else 0 end) < 0.3`)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const avgCandidates = totalQueries > 0
    ? topQueries.reduce((sum, q) => sum + (q.count - q.zeroCandidates), 0) / totalQueries
    : 0;

  const zeroResultRate = totalQueries > 0
    ? topQueries.reduce((sum, q) => sum + q.zeroCandidates, 0) / totalQueries
    : 0;

  return {
    totalQueries,
    uniqueQueries,
    avgCandidatesPerQuery: avgCandidates,
    zeroResultRate,
    topQueryHashes: topQueries.map((q) => ({
      queryHash: q.queryHash,
      count: q.count,
      avgScore: q.avgScore ?? 0,
      zeroCandidates: q.zeroCandidates,
      lastSeen: q.lastSeen,
    })),
    lowRecallQueries: lowRecallQueries.map((q) => ({
      queryHash: q.queryHash,
      attemptCount: q.attemptCount,
      avgCandidates: q.avgCandidates ?? 0,
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

  // High zero-result rate suggests missing stopwords or poor query processing
  if (stats.zeroResultRate > 0.3) {
    improvements.push({
      type: "stopword",
      suggestion: "Review stopword list — high zero-result rate suggests noisy queries",
      evidence: `${Math.round(stats.zeroResultRate * 100)}% of queries return zero candidates`,
      priority: "high",
    });
  }

  // Low recall queries need investigation
  if (stats.lowRecallQueries.length > 5) {
    improvements.push({
      type: "phrase",
      suggestion: "Improve phrase detection — many queries have low recall despite multiple attempts",
      evidence: `${stats.lowRecallQueries.length} query patterns with <30% success rate`,
      priority: "high",
    });
  }

  // Low unique query ratio suggests repetitive failed searches
  const uniqueRatio = stats.totalQueries > 0 ? stats.uniqueQueries / stats.totalQueries : 0;
  if (uniqueRatio < 0.3 && stats.zeroResultRate > 0.2) {
    improvements.push({
      type: "lexicon",
      suggestion: "Expand entity lexicon — users retry similar queries that fail",
      evidence: `Only ${Math.round(uniqueRatio * 100)}% unique queries with ${Math.round(stats.zeroResultRate * 100)}% zero-result rate`,
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
      lastRecalled: sql<Date | null>`max(${brainRetrievalEvents.createdAt})`,
      avgScore: sql<number>`avg(${brainRetrievalEvents.score})`,
    })
    .from(brainRetrievalEvents)
    .innerJoin(memories, eq(brainRetrievalEvents.memoryId, memories.id))
    .where(
      and(
        eq(brainRetrievalEvents.brainId, brainId),
        eq(brainRetrievalEvents.eventType, "retrieved"),
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
    lastRecalled: r.lastRecalled,
    avgScore: r.avgScore ?? 0,
  }));
}

/**
 * Orphaned memories that are never recalled.
 */
export async function getOrphanedMemories(
  brainId: string,
  daysSinceCreated: number = 90
): Promise<Array<{ id: string; title: string; createdAt: Date }>> {
  const threshold = new Date(Date.now() - daysSinceCreated * 24 * 60 * 60 * 1000);

  const results = await db
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
        sql`NOT EXISTS (
          SELECT 1 FROM brain_retrieval_events
          WHERE memory_id = ${memories.id}
          AND event_type = 'retrieved'
        )`
      )
    )
    .orderBy(memories.createdAt)
    .limit(50);

  return results;
}
