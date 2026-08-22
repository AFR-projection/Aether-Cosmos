import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as applicationDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { retrieveMemories, type RetrieveParams, type RetrievalResult } from "../retrieval/retrieve";
import { buildUndirectedGraph, reachableNodes, type GraphEdge } from "./algorithms";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { memoryLinks } from "@/lib/db/schema";

/**
 * Find memories related to a seed memory by combining:
 *  1. Direct links (memory_links where source or target is the seed)
 *  2. Graph proximity (neighbors within N hops)
 *  3. Semantic/entity overlap (via retrieval using the seed's title as query)
 *  4. Shared project relationships
 *
 * Returns a ranked list of related memories, deduplicated and scored by relevance.
 */

export type RelatedMemory = {
  id: string;
  title: string;
  type: string;
  score: number;
  /** Why this memory is related: "direct_link" | "graph_proximity" | "semantic" | "shared_entity" | "shared_project" */
  reason: string;
  /** For direct links: the link type (e.g., "supersedes", "related_to"). */
  linkType?: string;
  /** For graph proximity: how many hops away. */
  hops?: number;
};

/**
 * Find memories related to a seed memory.
 *
 * @param db - Database connection
 * @param brainId - Brain (tenant isolation)
 * @param seedMemoryId - The memory to find relatives of
 * @param maxResults - Maximum number of results (default 20)
 * @param maxHops - Maximum graph distance (default 2)
 */
export async function findRelatedMemories(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string,
  maxResults = 20,
  maxHops = 2
): Promise<RelatedMemory[]> {
  // Step 1: Load the seed memory to get its title for semantic search.
  const [seed] = await db
    .select({
      id: schema.memories.id,
      title: schema.memories.title,
      projectId: schema.memories.projectId,
    })
    .from(schema.memories)
    .where(
      and(
        eq(schema.memories.id, seedMemoryId),
        eq(schema.memories.brainId, brainId),
        isNull(schema.memories.deletedAt)
      )
    )
    .limit(1);

  if (!seed) return [];

  // Step 2: Direct links (explicit edges in memory_links).
  const directLinks = await db
    .select({
      memoryId: memoryLinks.targetMemoryId,
      linkType: memoryLinks.linkType,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.sourceMemoryId, seedMemoryId),
        eq(memoryLinks.targetType, "memory")
      )
    )
    .orderBy(asc(memoryLinks.createdAt));

  const directMemoryIds = new Set<string>();
  const directLinkTypes = new Map<string, string>();
  for (const link of directLinks) {
    if (link.memoryId) {
      directMemoryIds.add(link.memoryId);
      directLinkTypes.set(link.memoryId, link.linkType);
    }
  }

  // Also check backlinks (where seed is the target).
  const backlinks = await db
    .select({
      memoryId: memoryLinks.sourceMemoryId,
      linkType: memoryLinks.linkType,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.targetMemoryId, seedMemoryId),
        eq(memoryLinks.targetType, "memory")
      )
    )
    .orderBy(asc(memoryLinks.createdAt));

  for (const link of backlinks) {
    directMemoryIds.add(link.memoryId);
    if (!directLinkTypes.has(link.memoryId)) {
      directLinkTypes.set(link.memoryId, link.linkType);
    }
  }

  // Step 3: Graph proximity (neighbors within maxHops).
  const allLinks = await db
    .select({
      sourceMemoryId: memoryLinks.sourceMemoryId,
      targetMemoryId: memoryLinks.targetMemoryId,
      linkType: memoryLinks.linkType,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.targetType, "memory")
      )
    );

  const edges: GraphEdge[] = allLinks
    .filter((link) => link.targetMemoryId !== null)
    .map((link) => ({
      source: link.sourceMemoryId,
      target: link.targetMemoryId!,
      type: link.linkType,
      weight: 1.0,
    }));

  const graph = buildUndirectedGraph(edges);
  const reachable = reachableNodes(graph, seedMemoryId, maxHops);

  const proximityMemories = new Map<string, number>();
  for (const [nodeId, distance] of reachable) {
    if (nodeId !== seedMemoryId && distance > 0) {
      proximityMemories.set(nodeId, distance);
    }
  }

  // Step 4: Semantic + entity overlap (via retrieval).
  const retrievalParams: RetrieveParams = {
    brainId,
    query: seed.title,
    limit: Math.min(maxResults * 2, 40),
    projectId: seed.projectId ?? undefined,
    includeArchived: false,
  };

  const retrievalResult: RetrievalResult = await retrieveMemories(db, retrievalParams);
  const semanticMemories = new Map<string, { score: number; reason: string }>();
  for (const candidate of retrievalResult.results) {
    if (candidate.id !== seedMemoryId) {
      const reasons: string[] = [];
      if (candidate.legs.some((leg: string) => leg === "lexical")) reasons.push("lexical_match");
      if (candidate.legs.some((leg: string) => leg === "entity")) reasons.push("shared_entity");
      semanticMemories.set(candidate.id, {
        score: candidate.score.score,
        reason: reasons.join(", ") || "semantic",
      });
    }
  }

  // Step 5: Combine and rank.
  const combined = new Map<string, RelatedMemory>();

  // Direct links get highest priority (score 1.0).
  for (const memoryId of directMemoryIds) {
    combined.set(memoryId, {
      id: memoryId,
      title: "", // Will be filled later
      type: "",
      score: 1.0,
      reason: "direct_link",
      linkType: directLinkTypes.get(memoryId),
    });
  }

  // Graph proximity: score decreases with distance.
  for (const [memoryId, hops] of proximityMemories) {
    if (!combined.has(memoryId)) {
      combined.set(memoryId, {
        id: memoryId,
        title: "",
        type: "",
        score: 1.0 / (hops + 1), // 1-hop = 0.5, 2-hop = 0.33
        reason: "graph_proximity",
        hops,
      });
    }
  }

  // Semantic/entity overlap: add or boost score.
  for (const [memoryId, { score, reason }] of semanticMemories) {
    if (combined.has(memoryId)) {
      // Boost existing score.
      const existing = combined.get(memoryId)!;
      existing.score = Math.max(existing.score, score * 0.8);
      existing.reason = `${existing.reason}, ${reason}`;
    } else {
      combined.set(memoryId, {
        id: memoryId,
        title: "",
        type: "",
        score: score * 0.8,
        reason,
      });
    }
  }

  // Step 6: Load memory metadata (title, type) for all candidates.
  const memoryIds = Array.from(combined.keys());
  if (memoryIds.length === 0) return [];

  const memoryRows = await db
    .select({
      id: schema.memories.id,
      title: schema.memories.title,
      type: schema.memories.type,
    })
    .from(schema.memories)
    .where(
      and(
        eq(schema.memories.brainId, brainId),
        inArray(schema.memories.id, memoryIds),
        isNull(schema.memories.deletedAt)
      )
    );

  for (const row of memoryRows) {
    const related = combined.get(row.id);
    if (related) {
      related.title = row.title;
      related.type = row.type;
    }
  }

  // Step 7: Sort by score (descending) and limit.
  const results = Array.from(combined.values())
    .filter((r) => r.title !== "") // Remove any that failed to load
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return results;
}

/**
 * Service wrapper using the application database connection.
 */
export function getBrainRelatedMemories(
  brainId: string,
  seedMemoryId: string,
  maxResults?: number,
  maxHops?: number
): Promise<RelatedMemory[]> {
  return findRelatedMemories(applicationDb, brainId, seedMemoryId, maxResults, maxHops);
}
