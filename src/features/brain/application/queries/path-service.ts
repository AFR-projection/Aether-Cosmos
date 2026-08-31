import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memories, memoryLinks } from "@/shared/infrastructure/db/schema";
import {
  buildUndirectedGraph,
  shortestPath,
  type GraphEdge,
  type PathResult,
} from "@brain/domain/graph/algorithms";

/**
 * Graph path service: find explainable paths between memories.
 *
 * Loads explicit edges (memory_links where both endpoints are memories) from the
 * database, builds an undirected adjacency list, then runs Dijkstra's algorithm
 * to find the shortest weighted path. Each hop carries the relationship type and
 * weight, so the path is explainable: "A --supersedes--> B --related_to--> C".
 *
 * Returns null when no path exists within maxDepth hops. Does not include derived
 * edges (semantic similarity, shared entities) — only stored memory_links rows.
 */

export type PathMemory = {
  id: string;
  title: string;
  type: string;
};

export type ExplainableHop = {
  source: PathMemory;
  target: PathMemory;
  relationshipType: string;
  weight: number;
};

export type MemoryPathResult = {
  found: boolean;
  path: ExplainableHop[];
  distance: number;
};

/**
 * Find the shortest path from sourceMemoryId to targetMemoryId within the brain.
 *
 * @param db - Database connection
 * @param brainId - Brain to search within (tenant isolation)
 * @param sourceMemoryId - Starting memory
 * @param targetMemoryId - Target memory
 * @param maxDepth - Maximum number of hops (default 5)
 */
export async function findMemoryPath(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  maxDepth = 5
): Promise<MemoryPathResult> {
  // Load all memory-to-memory links in this brain.
  const linkRows = await db
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
    )
    .orderBy(asc(memoryLinks.createdAt));

  // Build graph edges: undirected, so both A→B and B→A.
  // Filter out rows where targetMemoryId is null (shouldn't happen given the WHERE clause, but type-safe).
  const edges: GraphEdge[] = linkRows
    .filter((row) => row.targetMemoryId !== null)
    .map((row) => ({
      source: row.sourceMemoryId,
      target: row.targetMemoryId!,
      type: row.linkType,
      weight: 1.0, // Explicit links are certainties.
    }));

  const graph = buildUndirectedGraph(edges);
  const pathResult: PathResult = shortestPath(graph, sourceMemoryId, targetMemoryId, maxDepth);

  if (!pathResult.found || pathResult.path.length === 0) {
    return { found: false, path: [], distance: Infinity };
  }

  // Load memory metadata for every node in the path.
  const nodeIds = new Set<string>();
  for (const hop of pathResult.path) {
    nodeIds.add(hop.source);
    nodeIds.add(hop.target);
  }

  const memoryRows = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        inArray(memories.id, [...nodeIds]),
        isNull(memories.deletedAt)
      )
    );

  const memoryMap = new Map<string, PathMemory>();
  for (const row of memoryRows) {
    memoryMap.set(row.id, { id: row.id, title: row.title, type: row.type });
  }

  // Build explainable hops with memory titles.
  //
  // Every node has to resolve. A link row can outlive the memory it points at (soft
  // delete leaves the row in place), and skipping such a hop would return a path
  // whose remaining hops no longer join up — "found: true" over a broken chain, which
  // is worse than an honest miss. So an unresolvable node invalidates the whole path
  // rather than being quietly dropped.
  const explainablePath: ExplainableHop[] = [];
  for (const hop of pathResult.path) {
    const source = memoryMap.get(hop.source);
    const target = memoryMap.get(hop.target);
    if (!source || !target) {
      return { found: false, path: [], distance: Infinity };
    }
    explainablePath.push({
      source,
      target,
      relationshipType: hop.relationshipType,
      weight: hop.weight,
    });
  }

  return {
    found: true,
    path: explainablePath,
    distance: pathResult.distance,
  };
}

/**
 * Service wrapper using the application database connection.
 */
export function findBrainMemoryPath(
  brainId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  maxDepth?: number
): Promise<MemoryPathResult> {
  return findMemoryPath(applicationDb, brainId, sourceMemoryId, targetMemoryId, maxDepth);
}
