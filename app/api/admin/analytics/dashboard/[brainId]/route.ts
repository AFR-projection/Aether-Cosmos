/**
 * Brain Analytics Dashboard API
 *
 * GET /api/admin/analytics/dashboard/:brainId
 *
 * Comprehensive analytics for a brain:
 * - Memory statistics
 * - Retrieval patterns
 * - Graph structure metrics
 * - Growth trends
 * - Query performance
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { memories, memoryLinks, memoryTags, memoryDerivedLinks } from "@/lib/db/schema";
import { eq, and, isNull, sql, desc, gte } from "drizzle-orm";
import { getRetrievalStats } from "@/lib/monitoring/query-analytics";
import { clusterMemories } from "@/lib/brain/clustering";

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { brainId: string } }
) {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const { brainId } = params;
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Parallel data fetching
    const [
      memoryStats,
      graphStats,
      retrievalStats,
      growthData,
      clusteringData,
      topTags,
    ] = await Promise.all([
      getMemoryStatistics(brainId),
      getGraphStatistics(brainId),
      getRetrievalStats(brainId, since),
      getGrowthTrends(brainId, days),
      clusterMemories(brainId, { maxClusters: 8, minClusterSize: 3 }),
      getTopTags(brainId, 10),
    ]);

    return NextResponse.json({
      brainId,
      period: { days, since },
      memory: memoryStats,
      graph: graphStats,
      retrieval: {
        totalQueries: retrievalStats.totalQueries,
        uniqueQueries: retrievalStats.uniqueQueries,
        avgCandidates: retrievalStats.avgCandidatesPerQuery,
        zeroResultRate: retrievalStats.zeroResultRate,
      },
      growth: growthData,
      clustering: {
        totalClusters: clusteringData.clusters.length,
        avgClusterSize: clusteringData.avgClusterSize,
        outliers: clusteringData.outliers.length,
        clusters: clusteringData.clusters.map((c) => ({
          label: c.label,
          size: c.size,
          coherence: c.coherence,
        })),
      },
      topTags,
    });
  } catch (error) {
    console.error("Analytics dashboard failed:", error);
    return NextResponse.json(
      {
        error: "Analytics failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * Get memory statistics.
 */
async function getMemoryStatistics(brainId: string) {
  const stats = await db.execute(
    sql`SELECT
          COUNT(*) as total_memories,
          COUNT(*) FILTER (WHERE embedding IS NOT NULL) as embedded_memories,
          AVG(LENGTH(content)) as avg_content_length,
          MAX(LENGTH(content)) as max_content_length,
          COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as deleted_memories
        FROM memories
        WHERE brain_id = ${brainId}`
  );

  const row = stats.rows[0] as any;

  return {
    total: parseInt(row.total_memories, 10),
    embedded: parseInt(row.embedded_memories, 10),
    avgLength: Math.round(parseFloat(row.avg_content_length)),
    maxLength: parseInt(row.max_content_length, 10),
    deleted: parseInt(row.deleted_memories, 10),
  };
}

/**
 * Get graph statistics.
 */
async function getGraphStatistics(brainId: string) {
  const linkStats = await db.execute(
    sql`SELECT
          COUNT(DISTINCT ml.source_id) as memories_with_links,
          COUNT(*) as total_explicit_links,
          AVG(link_count) as avg_links_per_memory
        FROM memory_links ml
        JOIN memories m ON m.id = ml.source_id
        WHERE m.brain_id = ${brainId}
        GROUP BY ml.source_id`
  );

  const derivedStats = await db.execute(
    sql`SELECT COUNT(*) as total_derived_links
        FROM memory_derived_links mdl
        JOIN memories m ON m.id = mdl.source_id
        WHERE m.brain_id = ${brainId}`
  );

  const tagStats = await db.execute(
    sql`SELECT
          COUNT(DISTINCT mt.memory_id) as memories_with_tags,
          COUNT(DISTINCT mt.tag) as unique_tags,
          COUNT(*) as total_tag_assignments
        FROM memory_tags mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE m.brain_id = ${brainId}`
  );

  const linkRow = linkStats.rows[0] as any;
  const derivedRow = derivedStats.rows[0] as any;
  const tagRow = tagStats.rows[0] as any;

  return {
    explicitLinks: parseInt(linkRow?.total_explicit_links || "0", 10),
    derivedLinks: parseInt(derivedRow?.total_derived_links || "0", 10),
    memoriesWithLinks: parseInt(linkRow?.memories_with_links || "0", 10),
    avgLinksPerMemory: parseFloat(linkRow?.avg_links_per_memory || "0").toFixed(2),
    memoriesWithTags: parseInt(tagRow?.memories_with_tags || "0", 10),
    uniqueTags: parseInt(tagRow?.unique_tags || "0", 10),
    totalTagAssignments: parseInt(tagRow?.total_tag_assignments || "0", 10),
  };
}

/**
 * Get growth trends over time.
 */
async function getGrowthTrends(brainId: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const dailyGrowth = await db.execute(
    sql`SELECT
          DATE(created_at) as date,
          COUNT(*) as count
        FROM memories
        WHERE brain_id = ${brainId}
          AND created_at >= ${since}
          AND deleted_at IS NULL
        GROUP BY DATE(created_at)
        ORDER BY date ASC`
  );

  return dailyGrowth.rows.map((row: any) => ({
    date: row.date,
    count: parseInt(row.count, 10),
  }));
}

/**
 * Get top tags by usage.
 */
async function getTopTags(brainId: string, limit: number) {
  const tags = await db.execute(
    sql`SELECT
          mt.tag,
          COUNT(*) as usage_count
        FROM memory_tags mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE m.brain_id = ${brainId}
          AND m.deleted_at IS NULL
        GROUP BY mt.tag
        ORDER BY usage_count DESC
        LIMIT ${limit}`
  );

  return tags.rows.map((row: any) => ({
    tag: row.tag,
    count: parseInt(row.usage_count, 10),
  }));
}
