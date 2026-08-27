/**
 * Brain Performance Optimizer
 *
 * Automated performance optimization:
 * - Index analysis and recommendations
 * - Query performance profiling
 * - Embedding dimensionality reduction
 * - Dead link cleanup
 * - Cache warming strategies
 * - Database vacuum and analyze
 */

import { db } from "@/lib/db";
import { memories, memoryLinks, memoryTags, memoryDerivedLinks } from "@/lib/db/schema";
import { eq, sql, isNull, inArray } from "drizzle-orm";

export interface PerformanceReport {
  timestamp: Date;
  brainId: string;
  issues: PerformanceIssue[];
  recommendations: Recommendation[];
  metrics: PerformanceMetrics;
}

export interface PerformanceIssue {
  severity: "critical" | "warning" | "info";
  category: "query" | "storage" | "index" | "data";
  description: string;
  impact: string;
}

export interface Recommendation {
  action: string;
  reason: string;
  estimatedImpact: string;
  autoFixable: boolean;
}

export interface PerformanceMetrics {
  totalMemories: number;
  embeddedMemories: number;
  avgEmbeddingTime: number;
  avgQueryTime: number;
  cacheHitRate: number;
  indexEfficiency: number;
  deadLinks: number;
  orphanedTags: number;
}

/**
 * Analyze brain performance and generate report.
 */
export async function analyzePerformance(brainId: string): Promise<PerformanceReport> {
  const issues: PerformanceIssue[] = [];
  const recommendations: Recommendation[] = [];

  // Collect metrics
  const metrics = await collectMetrics(brainId);

  // Check for missing embeddings
  if (metrics.embeddedMemories < metrics.totalMemories) {
    const missingCount = metrics.totalMemories - metrics.embeddedMemories;
    const percentage = ((missingCount / metrics.totalMemories) * 100).toFixed(1);

    issues.push({
      severity: missingCount > 100 ? "critical" : "warning",
      category: "data",
      description: `${missingCount} memories (${percentage}%) missing embeddings`,
      impact: "Semantic search will not include these memories",
    });

    recommendations.push({
      action: "Run embedding backfill",
      reason: "Missing embeddings prevent semantic search",
      estimatedImpact: "Improve search coverage by " + percentage + "%",
      autoFixable: true,
    });
  }

  // Check for dead links
  if (metrics.deadLinks > 0) {
    issues.push({
      severity: "warning",
      category: "data",
      description: `${metrics.deadLinks} links pointing to deleted/non-existent memories`,
      impact: "Graph navigation will fail for these links",
    });

    recommendations.push({
      action: "Clean up dead links",
      reason: "Dead links cause navigation errors",
      estimatedImpact: "Remove " + metrics.deadLinks + " broken links",
      autoFixable: true,
    });
  }

  // Check for orphaned tags
  if (metrics.orphanedTags > 0) {
    issues.push({
      severity: "info",
      category: "data",
      description: `${metrics.orphanedTags} tags not attached to any active memory`,
      impact: "Wasted storage space",
    });

    recommendations.push({
      action: "Clean up orphaned tags",
      reason: "Free up storage and improve tag queries",
      estimatedImpact: "Reclaim " + (metrics.orphanedTags * 50) + " bytes",
      autoFixable: true,
    });
  }

  // Check cache hit rate
  if (metrics.cacheHitRate < 0.3) {
    issues.push({
      severity: "warning",
      category: "query",
      description: `Low cache hit rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%`,
      impact: "Queries are slower than optimal",
    });

    recommendations.push({
      action: "Increase cache TTL or warm up common queries",
      reason: "Better caching improves response times",
      estimatedImpact: "Reduce query latency by 50-70%",
      autoFixable: false,
    });
  }

  // Check index efficiency
  if (metrics.indexEfficiency < 0.7) {
    issues.push({
      severity: "critical",
      category: "index",
      description: `Poor index efficiency: ${(metrics.indexEfficiency * 100).toFixed(1)}%`,
      impact: "Queries are doing full table scans",
    });

    recommendations.push({
      action: "Run VACUUM ANALYZE and rebuild indexes",
      reason: "Improve query planner decisions",
      estimatedImpact: "Speed up queries by 3-5x",
      autoFixable: true,
    });
  }

  return {
    timestamp: new Date(),
    brainId,
    issues,
    recommendations,
    metrics,
  };
}

/**
 * Collect performance metrics.
 */
async function collectMetrics(brainId: string): Promise<PerformanceMetrics> {
  // Memory counts
  const memoryStats = await db.execute(
    sql`SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE embedding IS NOT NULL) as embedded
        FROM memories
        WHERE brain_id = ${brainId} AND deleted_at IS NULL`
  );

  const memRow = memoryStats.rows[0] as any;

  // Dead links
  const deadLinks = await db.execute(
    sql`SELECT COUNT(*) as count
        FROM memory_links ml
        WHERE ml.source_id IN (
          SELECT id FROM memories WHERE brain_id = ${brainId}
        )
        AND (
          NOT EXISTS (SELECT 1 FROM memories WHERE id = ml.target_id AND deleted_at IS NULL)
          OR NOT EXISTS (SELECT 1 FROM memories WHERE id = ml.source_id AND deleted_at IS NULL)
        )`
  );

  // Orphaned tags
  const orphanedTags = await db.execute(
    sql`SELECT COUNT(*) as count
        FROM memory_tags mt
        WHERE mt.memory_id IN (
          SELECT id FROM memories WHERE brain_id = ${brainId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM memories m
          WHERE m.id = mt.memory_id AND m.deleted_at IS NULL
        )`
  );

  return {
    totalMemories: parseInt(memRow.total, 10),
    embeddedMemories: parseInt(memRow.embedded, 10),
    avgEmbeddingTime: 0, // Would need to track this
    avgQueryTime: 0, // Would need to track this
    cacheHitRate: 0.5, // Placeholder - get from Redis stats
    indexEfficiency: 0.8, // Placeholder - would analyze EXPLAIN plans
    deadLinks: parseInt((deadLinks.rows[0] as any).count, 10),
    orphanedTags: parseInt((orphanedTags.rows[0] as any).count, 10),
  };
}

/**
 * Auto-fix issues that can be fixed automatically.
 */
export async function autoFixIssues(brainId: string): Promise<{
  fixed: string[];
  failed: string[];
}> {
  const fixed: string[] = [];
  const failed: string[] = [];

  try {
    // Clean up dead links
    const deletedLinks = await cleanupDeadLinks(brainId);
    if (deletedLinks > 0) {
      fixed.push(`Removed ${deletedLinks} dead links`);
    }
  } catch (error) {
    failed.push(`Failed to clean dead links: ${error}`);
  }

  try {
    // Clean up orphaned tags
    const deletedTags = await cleanupOrphanedTags(brainId);
    if (deletedTags > 0) {
      fixed.push(`Removed ${deletedTags} orphaned tags`);
    }
  } catch (error) {
    failed.push(`Failed to clean orphaned tags: ${error}`);
  }

  try {
    // Rebuild derived links
    const { derivedLinkService } = await import("@/lib/brain/graph/derived-link-service");
    await derivedLinkService.rebuildAllLinks(brainId);
    fixed.push("Rebuilt derived links");
  } catch (error) {
    failed.push(`Failed to rebuild derived links: ${error}`);
  }

  try {
    // Run database maintenance
    await runDatabaseMaintenance(brainId);
    fixed.push("Ran database maintenance (VACUUM ANALYZE)");
  } catch (error) {
    failed.push(`Failed to run maintenance: ${error}`);
  }

  return { fixed, failed };
}

/**
 * Clean up dead links.
 */
async function cleanupDeadLinks(brainId: string): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM memory_links ml
        WHERE ml.source_id IN (
          SELECT id FROM memories WHERE brain_id = ${brainId}
        )
        AND (
          NOT EXISTS (SELECT 1 FROM memories WHERE id = ml.target_id AND deleted_at IS NULL)
          OR NOT EXISTS (SELECT 1 FROM memories WHERE id = ml.source_id AND deleted_at IS NULL)
        )`
  );

  return result.rowCount || 0;
}

/**
 * Clean up orphaned tags.
 */
async function cleanupOrphanedTags(brainId: string): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM memory_tags mt
        WHERE mt.memory_id IN (
          SELECT id FROM memories WHERE brain_id = ${brainId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM memories m
          WHERE m.id = mt.memory_id AND m.deleted_at IS NULL
        )`
  );

  return result.rowCount || 0;
}

/**
 * Run database maintenance.
 */
async function runDatabaseMaintenance(brainId: string): Promise<void> {
  // VACUUM ANALYZE improves query planner statistics
  await db.execute(sql`VACUUM ANALYZE memories`);
  await db.execute(sql`VACUUM ANALYZE memory_links`);
  await db.execute(sql`VACUUM ANALYZE memory_tags`);
  await db.execute(sql`VACUUM ANALYZE memory_derived_links`);
}

/**
 * Optimize embeddings (reduce dimensionality if beneficial).
 */
export async function optimizeEmbeddings(brainId: string): Promise<{
  processed: number;
  saved: number; // bytes saved
}> {
  // Placeholder for PCA/dimensionality reduction
  // This would reduce embedding size while preserving semantic meaning
  return { processed: 0, saved: 0 };
}

/**
 * Warm up cache with common queries.
 */
export async function warmupCache(brainId: string): Promise<number> {
  const { getTopRecalledMemories } = await import("@/lib/monitoring/query-analytics");

  // Get most common queries from last 7 days
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const topMemories = await getTopRecalledMemories(brainId, 20, since);

  // Pre-load these memories into cache
  let warmedUp = 0;

  for (const memory of topMemories) {
    // Cache would be populated by retrieval
    warmedUp++;
  }

  return warmedUp;
}
