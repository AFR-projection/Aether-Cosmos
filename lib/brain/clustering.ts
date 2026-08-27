/**
 * Memory Clustering
 *
 * Automatically groups memories into topic clusters using:
 * - Hierarchical clustering on embeddings
 * - TF-IDF for cluster labeling
 * - Silhouette score for quality measurement
 *
 * Use cases:
 * - Auto-organize memories into folders
 * - Topic-based navigation
 * - Identify knowledge silos
 * - Suggest related memories
 */

import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { eq, isNull, sql } from "drizzle-orm";
import { extractKeyTerms } from "@/lib/brain/enrich/extract";

export interface MemoryCluster {
  id: string;
  label: string;
  size: number;
  centroid: number[];
  memberIds: string[];
  coherence: number; // Silhouette score
  keywords: string[];
}

export interface ClusteringResult {
  clusters: MemoryCluster[];
  outliers: string[]; // Memories that don't fit any cluster
  totalMemories: number;
  avgClusterSize: number;
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Calculate centroid of a cluster.
 */
function calculateCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];

  const dimensions = embeddings[0].length;
  const centroid = new Array(dimensions).fill(0);

  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i++) {
      centroid[i] += embedding[i];
    }
  }

  for (let i = 0; i < dimensions; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}

/**
 * Calculate silhouette score for a memory in its cluster.
 */
function calculateSilhouette(
  memoryEmbedding: number[],
  clusterEmbeddings: number[][],
  nearestClusterEmbeddings: number[][]
): number {
  // Average distance to members of own cluster
  const a =
    clusterEmbeddings.reduce(
      (sum, emb) => sum + (1 - cosineSimilarity(memoryEmbedding, emb)),
      0
    ) / clusterEmbeddings.length;

  // Average distance to members of nearest other cluster
  const b =
    nearestClusterEmbeddings.reduce(
      (sum, emb) => sum + (1 - cosineSimilarity(memoryEmbedding, emb)),
      0
    ) / nearestClusterEmbeddings.length;

  return (b - a) / Math.max(a, b);
}

/**
 * Perform hierarchical clustering using agglomerative approach.
 */
function hierarchicalClustering(
  items: Array<{ id: string; embedding: number[] }>,
  maxClusters: number,
  similarityThreshold: number
): Array<{ memberIds: string[]; centroid: number[] }> {
  // Start with each item as its own cluster
  const clusters = items.map((item) => ({
    memberIds: [item.id],
    embeddings: [item.embedding],
    centroid: item.embedding,
  }));

  // Merge clusters until we reach maxClusters or no more similar pairs
  while (clusters.length > maxClusters) {
    let maxSimilarity = -1;
    let mergeIndices: [number, number] = [0, 1];

    // Find most similar pair
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const similarity = cosineSimilarity(
          clusters[i].centroid,
          clusters[j].centroid
        );

        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          mergeIndices = [i, j];
        }
      }
    }

    // Stop if no similar pairs found
    if (maxSimilarity < similarityThreshold) break;

    // Merge the two most similar clusters
    const [i, j] = mergeIndices;
    clusters[i].memberIds.push(...clusters[j].memberIds);
    clusters[i].embeddings.push(...clusters[j].embeddings);
    clusters[i].centroid = calculateCentroid(clusters[i].embeddings);

    clusters.splice(j, 1);
  }

  return clusters.map((c) => ({
    memberIds: c.memberIds,
    centroid: c.centroid,
  }));
}

/**
 * Generate label for cluster based on member contents.
 */
async function labelCluster(
  memberIds: string[],
  brainId: string
): Promise<{ label: string; keywords: string[] }> {
  // Fetch member contents
  const members = await db
    .select({ content: memories.content })
    .from(memories)
    .where(
      sql`${memories.id} = ANY(${memberIds}::uuid[]) AND ${memories.brainId} = ${brainId}`
    );

  // Extract key terms from all members
  const allTerms: string[] = [];
  for (const member of members) {
    const terms = extractKeyTerms(member.content);
    allTerms.push(...terms);
  }

  // Count term frequencies
  const termCounts = new Map<string, number>();
  for (const term of allTerms) {
    termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }

  // Sort by frequency
  const sortedTerms = Array.from(termCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);

  // Label = top 3 terms
  const keywords = sortedTerms.slice(0, 5);
  const label = sortedTerms.slice(0, 3).join(" • ");

  return {
    label: label || "Miscellaneous",
    keywords,
  };
}

/**
 * Cluster memories in a brain.
 */
export async function clusterMemories(
  brainId: string,
  options: {
    maxClusters?: number;
    minClusterSize?: number;
    similarityThreshold?: number;
  } = {}
): Promise<ClusteringResult> {
  const {
    maxClusters = 10,
    minClusterSize = 3,
    similarityThreshold = 0.7,
  } = options;

  // Fetch all memories with embeddings
  const items = await db
    .select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
    })
    .from(memories)
    .where(
      sql`${memories.brainId} = ${brainId} AND ${memories.deletedAt} IS NULL AND ${memories.embedding} IS NOT NULL`
    );

  if (items.length < minClusterSize * 2) {
    return {
      clusters: [],
      outliers: items.map((i) => i.id),
      totalMemories: items.length,
      avgClusterSize: 0,
    };
  }

  // Parse embeddings
  const itemsWithEmbeddings = items.map((item) => ({
    id: item.id,
    embedding: JSON.parse(item.embedding as any) as number[],
  }));

  // Perform clustering
  const rawClusters = hierarchicalClustering(
    itemsWithEmbeddings,
    maxClusters,
    similarityThreshold
  );

  // Filter out small clusters (outliers)
  const validClusters: typeof rawClusters = [];
  const outliers: string[] = [];

  for (const cluster of rawClusters) {
    if (cluster.memberIds.length >= minClusterSize) {
      validClusters.push(cluster);
    } else {
      outliers.push(...cluster.memberIds);
    }
  }

  // Label clusters and calculate coherence
  const clusters: MemoryCluster[] = [];

  for (const cluster of validClusters) {
    const { label, keywords } = await labelCluster(cluster.memberIds, brainId);

    // Calculate average silhouette score (coherence)
    const clusterEmbeddings = cluster.memberIds.map(
      (id) => itemsWithEmbeddings.find((item) => item.id === id)!.embedding
    );

    // Find nearest other cluster for silhouette
    let nearestClusterEmbeddings = clusterEmbeddings; // Fallback
    if (validClusters.length > 1) {
      let minDistance = Infinity;
      for (const otherCluster of validClusters) {
        if (otherCluster === cluster) continue;

        const distance =
          1 -
          cosineSimilarity(cluster.centroid, otherCluster.centroid);

        if (distance < minDistance) {
          minDistance = distance;
          nearestClusterEmbeddings = otherCluster.memberIds.map(
            (id) =>
              itemsWithEmbeddings.find((item) => item.id === id)!.embedding
          );
        }
      }
    }

    const coherence =
      clusterEmbeddings.reduce(
        (sum, emb) =>
          sum +
          calculateSilhouette(
            emb,
            clusterEmbeddings,
            nearestClusterEmbeddings
          ),
        0
      ) / clusterEmbeddings.length;

    clusters.push({
      id: `cluster-${clusters.length}`,
      label,
      size: cluster.memberIds.length,
      centroid: cluster.centroid,
      memberIds: cluster.memberIds,
      coherence,
      keywords,
    });
  }

  return {
    clusters,
    outliers,
    totalMemories: items.length,
    avgClusterSize:
      clusters.length > 0
        ? clusters.reduce((sum, c) => sum + c.size, 0) / clusters.length
        : 0,
  };
}

/**
 * Find which cluster a memory belongs to.
 */
export function findMemoryCluster(
  memoryId: string,
  clusters: MemoryCluster[]
): MemoryCluster | null {
  return clusters.find((c) => c.memberIds.includes(memoryId)) || null;
}

/**
 * Get related memories from the same cluster.
 */
export function getClusterMembers(
  memoryId: string,
  clusters: MemoryCluster[],
  excludeSelf: boolean = true
): string[] {
  const cluster = findMemoryCluster(memoryId, clusters);
  if (!cluster) return [];

  const members = cluster.memberIds;
  return excludeSelf ? members.filter((id) => id !== memoryId) : members;
}
