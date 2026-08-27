/**
 * Brain Recommendation Engine
 *
 * Intelligent recommendations based on usage patterns:
 * - Suggest memories to link
 * - Recommend tags based on content
 * - Identify similar memories to merge
 * - Suggest folders/organization
 * - Predict useful queries
 * - Recommend optimal retrieval settings
 */

import { db } from "@/lib/db";
import { memories, memoryLinks, memoryTags } from "@/lib/db/schema";
import { eq, and, isNull, sql, inArray, desc } from "drizzle-orm";
import { getRetrievalStats, getTopRecalledMemories } from "@/lib/monitoring/query-analytics";
import { clusterMemories } from "@/lib/brain/clustering";
import { suggestForMemory } from "@/lib/brain/suggestions";

export interface Recommendation {
  id: string;
  type: "link" | "tag" | "merge" | "organize" | "query" | "setting";
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  action: RecommendationAction;
  reasoning: string;
  estimatedBenefit: string;
}

export interface RecommendationAction {
  type: string;
  params: Record<string, any>;
}

export interface RecommendationSet {
  brainId: string;
  generatedAt: Date;
  recommendations: Recommendation[];
  stats: {
    total: number;
    highPriority: number;
    mediumPriority: number;
    lowPriority: number;
  };
}

/**
 * Generate all recommendations for a brain.
 */
export async function generateRecommendations(
  brainId: string,
  options: {
    maxRecommendations?: number;
    minPriority?: "high" | "medium" | "low";
  } = {}
): Promise<RecommendationSet> {
  const { maxRecommendations = 20, minPriority = "low" } = options;

  const recommendations: Recommendation[] = [];

  // Collect various recommendation types
  const [
    linkRecs,
    tagRecs,
    mergeRecs,
    organizeRecs,
    queryRecs,
    settingRecs,
  ] = await Promise.all([
    generateLinkRecommendations(brainId),
    generateTagRecommendations(brainId),
    generateMergeRecommendations(brainId),
    generateOrganizationRecommendations(brainId),
    generateQueryRecommendations(brainId),
    generateSettingRecommendations(brainId),
  ]);

  recommendations.push(
    ...linkRecs,
    ...tagRecs,
    ...mergeRecs,
    ...organizeRecs,
    ...queryRecs,
    ...settingRecs
  );

  // Filter by priority
  const priorityOrder = { high: 3, medium: 2, low: 1 };
  const minPriorityValue = priorityOrder[minPriority];

  const filtered = recommendations.filter(
    (r) => priorityOrder[r.priority] >= minPriorityValue
  );

  // Sort by priority and limit
  const sorted = filtered
    .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])
    .slice(0, maxRecommendations);

  return {
    brainId,
    generatedAt: new Date(),
    recommendations: sorted,
    stats: {
      total: sorted.length,
      highPriority: sorted.filter((r) => r.priority === "high").length,
      mediumPriority: sorted.filter((r) => r.priority === "medium").length,
      lowPriority: sorted.filter((r) => r.priority === "low").length,
    },
  };
}

/**
 * Generate link recommendations.
 */
async function generateLinkRecommendations(brainId: string): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Find memories with no links
  const isolatedMemories = await db.execute(
    sql`SELECT m.id, m.content
        FROM memories m
        WHERE m.brain_id = ${brainId}
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_links ml
            WHERE ml.source_id = m.id OR ml.target_id = m.id
          )
        LIMIT 10`
  );

  if (isolatedMemories.rows.length > 0) {
    recommendations.push({
      id: `link-isolated-${Date.now()}`,
      type: "link",
      priority: "medium",
      title: "Link isolated memories",
      description: `${isolatedMemories.rows.length} memories have no connections`,
      action: {
        type: "suggest_links",
        params: { memoryIds: isolatedMemories.rows.map((r: any) => r.id) },
      },
      reasoning: "Isolated memories are harder to discover through graph navigation",
      estimatedBenefit: "Improve discoverability by 30-40%",
    });
  }

  return recommendations;
}

/**
 * Generate tag recommendations.
 */
async function generateTagRecommendations(brainId: string): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Find memories without tags
  const untaggedCount = await db.execute(
    sql`SELECT COUNT(*) as count
        FROM memories m
        WHERE m.brain_id = ${brainId}
          AND m.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id
          )`
  );

  const count = parseInt((untaggedCount.rows[0] as any).count, 10);

  if (count > 10) {
    recommendations.push({
      id: `tag-untagged-${Date.now()}`,
      type: "tag",
      priority: count > 50 ? "high" : "medium",
      title: "Tag untagged memories",
      description: `${count} memories have no tags`,
      action: {
        type: "auto_tag",
        params: { brainId, maxMemories: Math.min(count, 100) },
      },
      reasoning: "Tags improve filtering and categorization",
      estimatedBenefit: `Organize ${count} memories`,
    });
  }

  return recommendations;
}

/**
 * Generate merge recommendations.
 */
async function generateMergeRecommendations(brainId: string): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Find potential duplicates (high semantic similarity)
  const duplicatePairs = await db.execute(
    sql`SELECT
          m1.id as id1,
          m2.id as id2,
          m1.content as content1,
          m2.content as content2,
          1 - (m1.embedding::vector <=> m2.embedding::vector) as similarity
        FROM memories m1
        JOIN memories m2 ON m1.brain_id = m2.brain_id AND m1.id < m2.id
        WHERE m1.brain_id = ${brainId}
          AND m1.deleted_at IS NULL
          AND m2.deleted_at IS NULL
          AND m1.embedding IS NOT NULL
          AND m2.embedding IS NOT NULL
          AND (1 - (m1.embedding::vector <=> m2.embedding::vector)) > 0.95
        LIMIT 5`
  );

  if (duplicatePairs.rows.length > 0) {
    recommendations.push({
      id: `merge-duplicates-${Date.now()}`,
      type: "merge",
      priority: "medium",
      title: "Review potential duplicates",
      description: `Found ${duplicatePairs.rows.length} pairs of very similar memories`,
      action: {
        type: "review_duplicates",
        params: {
          pairs: duplicatePairs.rows.map((r: any) => [r.id1, r.id2]),
        },
      },
      reasoning: "Duplicate memories create confusion and waste storage",
      estimatedBenefit: "Reduce redundancy and improve clarity",
    });
  }

  return recommendations;
}

/**
 * Generate organization recommendations.
 */
async function generateOrganizationRecommendations(brainId: string): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Check if brain would benefit from clustering
  const memoryCount = await db.execute(
    sql`SELECT COUNT(*) as count
        FROM memories
        WHERE brain_id = ${brainId} AND deleted_at IS NULL`
  );

  const count = parseInt((memoryCount.rows[0] as any).count, 10);

  if (count > 50) {
    try {
      const clusters = await clusterMemories(brainId, {
        maxClusters: 8,
        minClusterSize: 3,
      });

      if (clusters.clusters.length >= 3) {
        recommendations.push({
          id: `organize-clusters-${Date.now()}`,
          type: "organize",
          priority: "low",
          title: "Organize memories into folders",
          description: `Found ${clusters.clusters.length} natural topic clusters`,
          action: {
            type: "create_folders",
            params: {
              clusters: clusters.clusters.map((c) => ({
                name: c.label,
                memoryIds: c.memberIds,
              })),
            },
          },
          reasoning: "Clustering reveals natural organization structure",
          estimatedBenefit: `Group ${count} memories into ${clusters.clusters.length} topics`,
        });
      }
    } catch (error) {
      // Clustering failed, skip recommendation
    }
  }

  return recommendations;
}

/**
 * Generate query recommendations.
 */
async function generateQueryRecommendations(brainId: string): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Analyze retrieval patterns
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const stats = await getRetrievalStats(brainId, since);

  // High zero-result rate
  if (stats.zeroResultRate > 0.3) {
    recommendations.push({
      id: `query-zero-results-${Date.now()}`,
      type: "query",
      priority: "high",
      title: "Improve search quality",
      description: `${(stats.zeroResultRate * 100).toFixed(0)}% of queries return no results`,
      action: {
        type: "review_stopwords",
        params: { brainId },
      },
      reasoning: "High zero-result rate indicates poor retrieval configuration",
      estimatedBenefit: "Reduce failed searches by 50%",
    });
  }

  // Suggest popular queries
  const topMemories = await getTopRecalledMemories(brainId, 5, since);

  if (topMemories.length > 0) {
    recommendations.push({
      id: `query-popular-${Date.now()}`,
      type: "query",
      priority: "low",
      title: "Pin frequently accessed memories",
      description: `${topMemories.length} memories are accessed repeatedly`,
      action: {
        type: "pin_memories",
        params: { memoryIds: topMemories.map((m) => m.memoryId) },
      },
      reasoning: "Quick access to popular content improves productivity",
      estimatedBenefit: "Save 2-3 seconds per access",
    });
  }

  return recommendations;
}

/**
 * Generate setting recommendations.
 */
async function generateSettingRecommendations(brainId: string): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Check embedding coverage
  const embeddingStats = await db.execute(
    sql`SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE embedding IS NOT NULL) as embedded
        FROM memories
        WHERE brain_id = ${brainId} AND deleted_at IS NULL`
  );

  const stats = embeddingStats.rows[0] as any;
  const total = parseInt(stats.total, 10);
  const embedded = parseInt(stats.embedded, 10);
  const coverage = total > 0 ? embedded / total : 0;

  if (coverage < 0.9 && total > 10) {
    recommendations.push({
      id: `setting-embeddings-${Date.now()}`,
      type: "setting",
      priority: "high",
      title: "Complete embedding backfill",
      description: `Only ${(coverage * 100).toFixed(0)}% of memories have embeddings`,
      action: {
        type: "backfill_embeddings",
        params: { brainId },
      },
      reasoning: "Missing embeddings prevent semantic search",
      estimatedBenefit: `Enable search for ${total - embedded} memories`,
    });
  }

  return recommendations;
}
