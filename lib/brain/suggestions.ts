/**
 * Intelligent Memory Suggestions
 *
 * Proactively suggests:
 * - Related memories to link
 * - Relevant tags to add
 * - Potential duplicates to merge
 * - Missing context to fill
 *
 * Powered by:
 * - Semantic similarity (embeddings)
 * - Entity overlap (NER)
 * - Temporal proximity
 * - User behavior patterns
 */

import { db } from "@/lib/db";
import { memories, memoryLinks, memoryTags } from "@/lib/db/schema";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { cosineSimilarity } from "@/lib/brain/similarity";
import { extractEntities } from "@/lib/brain/enrich/extract";

export interface LinkSuggestion {
  targetMemoryId: string;
  targetContent: string;
  reason: "semantic" | "entity" | "temporal" | "tag";
  score: number;
  explanation: string;
}

export interface TagSuggestion {
  tag: string;
  score: number;
  reason: string;
  existingUsage: number; // How many times tag is used in brain
}

export interface DuplicateSuggestion {
  memoryId: string;
  content: string;
  similarity: number;
  isDuplicate: boolean; // vs just similar
}

export interface Suggestions {
  links: LinkSuggestion[];
  tags: TagSuggestion[];
  duplicates: DuplicateSuggestion[];
}

/**
 * Generate all suggestions for a memory.
 */
export async function suggestForMemory(
  memoryId: string,
  options: {
    maxLinks?: number;
    maxTags?: number;
    maxDuplicates?: number;
    minLinkScore?: number;
    minTagScore?: number;
    minDuplicateScore?: number;
  } = {}
): Promise<Suggestions> {
  const {
    maxLinks = 5,
    maxTags = 3,
    maxDuplicates = 3,
    minLinkScore = 0.7,
    minTagScore = 0.6,
    minDuplicateScore = 0.85,
  } = options;

  const [links, tags, duplicates] = await Promise.all([
    suggestLinks(memoryId, maxLinks, minLinkScore),
    suggestTags(memoryId, maxTags, minTagScore),
    findDuplicates(memoryId, maxDuplicates, minDuplicateScore),
  ]);

  return { links, tags, duplicates };
}

/**
 * Suggest related memories to link.
 */
export async function suggestLinks(
  memoryId: string,
  limit: number,
  minScore: number
): Promise<LinkSuggestion[]> {
  // Get source memory
  const [source] = await db
    .select({
      id: memories.id,
      brainId: memories.brainId,
      content: memories.content,
      embedding: memories.embedding,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (!source || !source.embedding) return [];

  const sourceEmbedding = JSON.parse(source.embedding as any) as number[];
  const sourceEntities = extractEntities(source.content);

  // Get existing links to exclude
  const existingLinks = await db
    .select({ targetId: memoryLinks.targetId })
    .from(memoryLinks)
    .where(eq(memoryLinks.sourceId, memoryId));

  const excludeIds = [memoryId, ...existingLinks.map((l) => l.targetId)];

  // Find candidates via semantic similarity
  const candidates = await db
    .select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, source.brainId),
        isNull(memories.deletedAt),
        sql`${memories.id} != ALL(${excludeIds}::uuid[])`
      )
    )
    .limit(100);

  const suggestions: LinkSuggestion[] = [];

  for (const candidate of candidates) {
    if (!candidate.embedding) continue;

    const candidateEmbedding = JSON.parse(candidate.embedding as any) as number[];
    const semanticScore = cosineSimilarity(sourceEmbedding, candidateEmbedding);

    // Check entity overlap
    const candidateEntities = extractEntities(candidate.content);
    const sharedEntities = sourceEntities.filter((e) =>
      candidateEntities.includes(e)
    );

    // Check temporal proximity (within 1 hour)
    const timeDiff = Math.abs(
      source.createdAt.getTime() - candidate.createdAt.getTime()
    );
    const isTemporallyClose = timeDiff < 60 * 60 * 1000;

    // Calculate composite score
    let score = semanticScore * 0.6;
    if (sharedEntities.length > 0) score += 0.3;
    if (isTemporallyClose) score += 0.1;

    if (score >= minScore) {
      const reason =
        sharedEntities.length > 0
          ? "entity"
          : isTemporallyClose
          ? "temporal"
          : "semantic";

      const explanation =
        reason === "entity"
          ? `Shares entities: ${sharedEntities.slice(0, 3).join(", ")}`
          : reason === "temporal"
          ? "Created around the same time"
          : `Semantically similar (${(semanticScore * 100).toFixed(0)}%)`;

      suggestions.push({
        targetMemoryId: candidate.id,
        targetContent: candidate.content.slice(0, 150),
        reason,
        score,
        explanation,
      });
    }
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Suggest tags based on content and existing tag patterns.
 */
export async function suggestTags(
  memoryId: string,
  limit: number,
  minScore: number
): Promise<TagSuggestion[]> {
  // Get memory
  const [memory] = await db
    .select({
      brainId: memories.brainId,
      content: memories.content,
      embedding: memories.embedding,
    })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (!memory || !memory.embedding) return [];

  // Get existing tags for this memory
  const existingTags = await db
    .select({ tag: memoryTags.tag })
    .from(memoryTags)
    .where(eq(memoryTags.memoryId, memoryId));

  const excludeTags = existingTags.map((t) => t.tag);

  // Get all tags used in this brain with usage counts
  const brainTags = await db.execute(
    sql`SELECT tag, COUNT(*) as usage_count
        FROM memory_tags mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE m.brain_id = ${memory.brainId}
          AND m.deleted_at IS NULL
          AND mt.tag NOT IN (${sql.join(excludeTags.map((t) => sql`${t}`), sql`, `)})
        GROUP BY tag
        ORDER BY usage_count DESC
        LIMIT 50`
  );

  const memoryEmbedding = JSON.parse(memory.embedding as any) as number[];
  const suggestions: TagSuggestion[] = [];

  // For each popular tag, check if it fits this memory
  for (const row of brainTags.rows as any[]) {
    const tag = row.tag;
    const usageCount = parseInt(row.usage_count, 10);

    // Get memories with this tag
    const taggedMemories = await db
      .select({ embedding: memories.embedding })
      .from(memories)
      .innerJoin(memoryTags, eq(memoryTags.memoryId, memories.id))
      .where(
        and(
          eq(memoryTags.tag, tag),
          eq(memories.brainId, memory.brainId),
          isNull(memories.deletedAt)
        )
      )
      .limit(10);

    // Calculate average similarity to tagged memories
    let avgSimilarity = 0;
    let validCount = 0;

    for (const tagged of taggedMemories) {
      if (!tagged.embedding) continue;

      const taggedEmbedding = JSON.parse(tagged.embedding as any) as number[];
      avgSimilarity += cosineSimilarity(memoryEmbedding, taggedEmbedding);
      validCount++;
    }

    if (validCount > 0) {
      avgSimilarity /= validCount;

      // Score combines similarity + tag popularity
      const score = avgSimilarity * 0.7 + Math.min(usageCount / 100, 1) * 0.3;

      if (score >= minScore) {
        suggestions.push({
          tag,
          score,
          reason: `Similar to ${usageCount} memories with this tag`,
          existingUsage: usageCount,
        });
      }
    }
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Find potential duplicate memories.
 */
export async function findDuplicates(
  memoryId: string,
  limit: number,
  minScore: number
): Promise<DuplicateSuggestion[]> {
  // Get source memory
  const [source] = await db
    .select({
      brainId: memories.brainId,
      content: memories.content,
      embedding: memories.embedding,
    })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (!source || !source.embedding) return [];

  const sourceEmbedding = JSON.parse(source.embedding as any) as number[];

  // Find highly similar memories
  const candidates = await db
    .select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, source.brainId),
        isNull(memories.deletedAt),
        sql`${memories.id} != ${memoryId}`
      )
    )
    .limit(100);

  const suggestions: DuplicateSuggestion[] = [];

  for (const candidate of candidates) {
    if (!candidate.embedding) continue;

    const candidateEmbedding = JSON.parse(candidate.embedding as any) as number[];
    const similarity = cosineSimilarity(sourceEmbedding, candidateEmbedding);

    if (similarity >= minScore) {
      // Very high similarity (>0.95) = likely duplicate
      // High similarity (0.85-0.95) = similar but distinct
      const isDuplicate = similarity > 0.95;

      suggestions.push({
        memoryId: candidate.id,
        content: candidate.content.slice(0, 150),
        similarity,
        isDuplicate,
      });
    }
  }

  return suggestions
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Accept a link suggestion (create the link).
 */
export async function acceptLinkSuggestion(
  sourceId: string,
  targetId: string
): Promise<void> {
  await db.insert(memoryLinks).values({
    sourceId,
    targetId,
    createdAt: new Date(),
  });
}

/**
 * Accept a tag suggestion (add the tag).
 */
export async function acceptTagSuggestion(
  memoryId: string,
  tag: string
): Promise<void> {
  await db.insert(memoryTags).values({
    memoryId,
    tag,
    createdAt: new Date(),
  });
}
