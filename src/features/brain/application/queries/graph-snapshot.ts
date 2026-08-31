import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import {
  brainEntities,
  brainProjects,
  brainRelationships,
  memories,
  memoryLinks,
  memoryTagMap,
  memoryTags,
} from "@/shared/infrastructure/db/schema";
import { BRAIN_ENTITY_TYPES, MEMORY_TYPES } from "@brain/domain/constants";
import { clampLimit } from "@brain/domain/pagination";
import { relateMemories, type DerivedEdge, type RelateMemory } from "@brain/domain/graph/relate";

/**
 * One bounded snapshot of a whole brain graph, for the interactive graph view.
 *
 * The paginated /entities and /relationships routes cap at MEMORY_PAGE_MAX (100)
 * rows, which is right for a list and useless for a layout: a force simulation
 * needs the whole neighbourhood at once or the picture is a lie. So this builds a
 * single snapshot with its own, much larger, hard caps.
 *
 * Two node kinds share the canvas, because both halves of the brain are graphs:
 *  - entity nodes, joined by brain_relationships (entity -> entity)
 *  - memory nodes, joined by memory_links   (memory -> memory | memory -> entity)
 *
 * Those two tables are the only *explicit* edges, and nothing in the app writes to
 * them on its own — a brain that never called the link API has none at all. So the
 * memories are also related to each other here, by ./graph/relate, from the signals
 * the rows already carry (shared entities, shared tags, lexical similarity, shared
 * project). Explicit rows always outrank a derived edge, and a derived edge is
 * never emitted for a pair that already has an explicit one.
 *
 * Every query filters on brain_id. The caller resolves authorization first
 * (requireBrainContext), so nothing here can reach across brains.
 */

export const GRAPH_NODE_LIMIT_DEFAULT = 2500;
export const GRAPH_NODE_LIMIT_MAX = 6000;
export const GRAPH_EDGE_LIMIT_DEFAULT = 6000;
export const GRAPH_EDGE_LIMIT_MAX = 20000;

/** Tag assignments are cheap rows; this only exists so the query can never be unbounded. */
const GRAPH_TAG_ASSIGNMENT_MAX = 30000;
const GRAPH_PROJECT_MAX = 500;

/** Longest `detail` string put on the wire, per node. */
const DETAIL_MAX = 240;

/**
 * How much memory body is read for the similarity pass. Bounded in SQL, and this
 * text never reaches the wire: it is tokenised on the server and dropped. The
 * front of a memory carries its subject, so a longer read costs tokens and buys
 * little.
 */
const RELATE_CONTENT_MAX = 1500;

export type GraphNodeKind = "entity" | "memory";

export type GraphSnapshotNode = {
  id: string;
  kind: GraphNodeKind;
  /** Entity name, or memory title. */
  label: string;
  /** brain_entity_type for entities, memory_type for memories. */
  type: string;
  /** One short line for the detail panel: entity description, or memory summary. */
  detail: string | null;
  /** Memories only; always present so the client never has to null-check. */
  tags: string[];
  projectId: string | null;
  /** Memories only — drives node size alongside degree. */
  importance: number | null;
  updatedAt: string;
};

/**
 * Where an edge came from. "relationship" and "link" are stored rows; "derived" is
 * computed here and never written back to the database.
 */
export type GraphEdgeKind = "relationship" | "link" | "derived";

/**
 * Why an edge exists. "explicit" covers both stored tables — a link the user made
 * is a link, whichever table holds it — and the rest name the deriving signal.
 */
export type GraphEdgeRelation = "explicit" | "semantic" | "tag" | "entity" | "project";

export type GraphSnapshotEdge = {
  id: string;
  /** Node id, not a name: the client indexes nodes by id. */
  source: string;
  target: string;
  /** relationship_type or link_type; for a derived edge, the relation itself. */
  type: string;
  kind: GraphEdgeKind;
  /** Which tier produced this edge. Drives filtering, styling and the legend. */
  relation: GraphEdgeRelation;
  /** 0..1 strength. Always 1 for an explicit row — a stored link is a certainty. */
  weight: number;
  /** Why a derived edge exists, in one short line. Null for explicit rows. */
  reason: string | null;
};

/** Per-tier edge counts, so the view can explain itself instead of guessing. */
export type GraphEdgeStats = {
  explicit: number;
  semantic: number;
  tag: number;
  entity: number;
  project: number;
  /** Edges whose source or target was truncated out of the node set. */
  dropped: number;
  /** Pairs the derivation actually scored. Diagnostics only. */
  candidates: number;
};

export type BrainGraphSnapshot = {
  nodes: GraphSnapshotNode[];
  edges: GraphSnapshotEdge[];
  /** Filter vocabulary, derived from what is actually in the snapshot. */
  projects: { id: string; name: string }[];
  tags: string[];
  entityTypes: string[];
  memoryTypes: string[];
  edgeStats: GraphEdgeStats;
  truncated: { nodes: boolean; edges: boolean };
  generatedAt: string;
};

function snippet(value: string | null, max = DETAIL_MAX): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The derivation is pure and deterministic, so it only has to run when the inputs
 * change. The graph is polled and reopened often — the pop-out window alone doubles
 * the traffic — and tokenising a few thousand memories on every one of those is
 * waste. Keyed by brain and by an exact fingerprint of the derivation inputs, so a
 * new memory, an edited one, a deleted one or a tag change all miss the cache; a
 * mere re-render hits it. Small and per-process: this is a latency cache, never a
 * source of truth.
 */
const DERIVE_CACHE_MAX = 8;
const deriveCache = new Map<string, { fingerprint: string; edges: DerivedEdge[]; candidates: number }>();

/**
 * FNV-1a over exactly what the derivation reads, content included. Hashing the
 * bodies costs a fraction of tokenising and scoring them, and it means the cache
 * cannot serve a stale graph after an edit however the row was written.
 */
function fingerprintOf(inputs: RelateMemory[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // A separator, so ["ab","c"] and ["a","bc"] cannot collide.
    hash ^= 31;
    hash = Math.imul(hash, 0x01000193);
  };
  for (const input of inputs) {
    mix(input.id);
    mix(input.title);
    mix(input.content);
    mix(input.tags.join(","));
    mix(input.projectId ?? "");
    mix(input.entityIds.join(","));
  }
  return `${inputs.length}:${(hash >>> 0).toString(36)}`;
}

function deriveRelations(
  brainId: string,
  inputs: RelateMemory[]
): { edges: DerivedEdge[]; candidates: number } {
  const fingerprint = fingerprintOf(inputs);
  const cached = deriveCache.get(brainId);
  if (cached && cached.fingerprint === fingerprint) {
    // Refresh the insertion order so an active brain is not the next one evicted.
    deriveCache.delete(brainId);
    deriveCache.set(brainId, cached);
    return { edges: cached.edges, candidates: cached.candidates };
  }
  const result = relateMemories(inputs);
  deriveCache.set(brainId, { fingerprint, ...result });
  if (deriveCache.size > DERIVE_CACHE_MAX) {
    const oldest = deriveCache.keys().next().value;
    if (oldest !== undefined) deriveCache.delete(oldest);
  }
  return result;
}

export async function buildBrainGraphSnapshot(params: {
  brainId: string;
  includeMemories?: boolean;
  nodeLimit?: number;
  edgeLimit?: number;
}): Promise<BrainGraphSnapshot> {
  const { brainId } = params;
  const includeMemories = params.includeMemories ?? true;
  const nodeLimit = clampLimit(params.nodeLimit, GRAPH_NODE_LIMIT_DEFAULT, GRAPH_NODE_LIMIT_MAX);
  const edgeLimit = clampLimit(params.edgeLimit, GRAPH_EDGE_LIMIT_DEFAULT, GRAPH_EDGE_LIMIT_MAX);

  // Entities are the skeleton of the graph, so they get first claim on the node
  // budget; memories take whatever is left. Asking for one more row than the cap
  // is how truncation is detected without a second COUNT query.
  const entityRows = await db
    .select({
      id: brainEntities.id,
      name: brainEntities.name,
      type: brainEntities.type,
      description: brainEntities.description,
      updatedAt: brainEntities.updatedAt,
    })
    .from(brainEntities)
    .where(eq(brainEntities.brainId, brainId))
    .orderBy(asc(brainEntities.name))
    .limit(nodeLimit + 1);

  const entitiesTruncated = entityRows.length > nodeLimit;
  const entities = entitiesTruncated ? entityRows.slice(0, nodeLimit) : entityRows;
  const memoryBudget = includeMemories ? Math.max(0, nodeLimit - entities.length) : 0;

  const [memoryRows, tagRows, relationshipRows, linkRows, projectRows] = await Promise.all([
    memoryBudget > 0
      ? db
          .select({
            id: memories.id,
            title: memories.title,
            type: memories.type,
            summary: memories.summary,
            importance: memories.importance,
            projectId: memories.projectId,
            updatedAt: memories.updatedAt,
            // Bounded in SQL so a long memory cannot inflate the response, and kept
            // server-side: this feeds the similarity pass and is never put on nodes.
            contentHead: sql<string>`left(${memories.content}, ${RELATE_CONTENT_MAX})`,
          })
          .from(memories)
          .where(
            and(
              eq(memories.brainId, brainId),
              isNull(memories.deletedAt),
              isNull(memories.archivedAt)
            )
          )
          // Most important first, so truncation drops the least significant memories.
          .orderBy(desc(memories.importance), desc(memories.updatedAt))
          .limit(memoryBudget + 1)
      : Promise.resolve([]),
    memoryBudget > 0
      ? db
          .select({ memoryId: memoryTagMap.memoryId, name: memoryTags.name })
          .from(memoryTagMap)
          .innerJoin(memoryTags, eq(memoryTags.id, memoryTagMap.tagId))
          .where(eq(memoryTags.brainId, brainId))
          .limit(GRAPH_TAG_ASSIGNMENT_MAX)
      : Promise.resolve([]),
    db
      .select({
        id: brainRelationships.id,
        source: brainRelationships.sourceEntityId,
        target: brainRelationships.targetEntityId,
        type: brainRelationships.relationshipType,
      })
      .from(brainRelationships)
      .where(eq(brainRelationships.brainId, brainId))
      .orderBy(desc(brainRelationships.confidence), asc(brainRelationships.createdAt))
      .limit(edgeLimit + 1),
    memoryBudget > 0
      ? db
          .select({
            id: memoryLinks.id,
            source: memoryLinks.sourceMemoryId,
            targetMemoryId: memoryLinks.targetMemoryId,
            targetEntityId: memoryLinks.targetEntityId,
            type: memoryLinks.linkType,
          })
          .from(memoryLinks)
          .where(eq(memoryLinks.brainId, brainId))
          .orderBy(desc(memoryLinks.createdAt))
          .limit(edgeLimit + 1)
      : Promise.resolve([]),
    db
      .select({ id: brainProjects.id, name: brainProjects.name })
      .from(brainProjects)
      .where(eq(brainProjects.brainId, brainId))
      .orderBy(asc(brainProjects.name))
      .limit(GRAPH_PROJECT_MAX),
  ]);

  const memoriesTruncated = memoryRows.length > memoryBudget;
  const memoryList = memoriesTruncated ? memoryRows.slice(0, memoryBudget) : memoryRows;

  const memoryIds = new Set(memoryList.map((row) => row.id));
  const tagsByMemory = new Map<string, string[]>();
  for (const row of tagRows) {
    // The tag query is scoped by brain, not by the truncated node set; skip rows
    // for memories that did not make the cut.
    if (!memoryIds.has(row.memoryId)) continue;
    const list = tagsByMemory.get(row.memoryId);
    if (list) list.push(row.name);
    else tagsByMemory.set(row.memoryId, [row.name]);
  }

  const nodes: GraphSnapshotNode[] = [
    ...entities.map((row) => ({
      id: row.id,
      kind: "entity" as const,
      label: row.name,
      type: row.type,
      detail: snippet(row.description),
      tags: [],
      projectId: null,
      importance: null,
      updatedAt: row.updatedAt.toISOString(),
    })),
    ...memoryList.map((row) => ({
      id: row.id,
      kind: "memory" as const,
      label: row.title,
      type: row.type,
      detail: snippet(row.summary),
      tags: tagsByMemory.get(row.id) ?? [],
      projectId: row.projectId,
      importance: row.importance,
      updatedAt: row.updatedAt.toISOString(),
    })),
  ];

  const nodeIds = new Set(nodes.map((node) => node.id));

  // Edges whose far end was truncated away would draw into empty space, so they are
  // dropped rather than rendered as dangling stubs — but the count is reported, so a
  // missing edge shows up as a number instead of vanishing silently.
  let dropped = 0;
  const explicit: GraphSnapshotEdge[] = [];
  /** Unordered pairs already joined explicitly; a derived edge must not repeat one. */
  const explicitPairs = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const row of relationshipRows.slice(0, edgeLimit)) {
    if (!nodeIds.has(row.source) || !nodeIds.has(row.target)) {
      dropped += 1;
      continue;
    }
    explicit.push({
      id: row.id,
      source: row.source,
      target: row.target,
      type: row.type,
      kind: "relationship",
      relation: "explicit",
      weight: 1,
      reason: null,
    });
    explicitPairs.add(pairKey(row.source, row.target));
  }
  for (const row of linkRows.slice(0, edgeLimit)) {
    const target = row.targetMemoryId ?? row.targetEntityId;
    if (!target) {
      dropped += 1;
      continue;
    }
    if (!nodeIds.has(row.source) || !nodeIds.has(target)) {
      dropped += 1;
      continue;
    }
    explicit.push({
      id: row.id,
      source: row.source,
      target,
      type: row.type,
      kind: "link",
      relation: "explicit",
      weight: 1,
      reason: null,
    });
    explicitPairs.add(pairKey(row.source, target));
  }

  // Entity co-mention is the strongest derived signal, and it comes from the same
  // explicit link rows: a memory that links to an entity tells us what it is about.
  const entityIdsByMemory = new Map<string, string[]>();
  for (const row of linkRows) {
    if (!row.targetEntityId || !memoryIds.has(row.source)) continue;
    const list = entityIdsByMemory.get(row.source);
    if (list) list.push(row.targetEntityId);
    else entityIdsByMemory.set(row.source, [row.targetEntityId]);
  }

  const relateInputs: RelateMemory[] = memoryList.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.contentHead ?? "",
    tags: tagsByMemory.get(row.id) ?? [],
    projectId: row.projectId,
    entityIds: entityIdsByMemory.get(row.id) ?? [],
  }));

  const derivation = deriveRelations(brainId, relateInputs);
  const derived: GraphSnapshotEdge[] = [];
  for (const edge of derivation.edges) {
    if (explicitPairs.has(pairKey(edge.source, edge.target))) continue;
    derived.push({
      // Deterministic and stable across snapshots, so the client keeps a node's
      // layout and its selection across a refresh.
      id: `d:${edge.source}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: edge.relation,
      kind: "derived",
      relation: edge.relation,
      weight: edge.weight,
      reason: edge.reason,
    });
  }

  // Explicit rows get first claim on the edge budget: a link the user made must
  // never be pushed out by something this file inferred.
  const candidates = [...explicit, ...derived];
  const edges = candidates.slice(0, edgeLimit);

  const edgeStats: GraphEdgeStats = {
    explicit: 0,
    semantic: 0,
    tag: 0,
    entity: 0,
    project: 0,
    dropped,
    candidates: derivation.candidates,
  };
  for (const edge of edges) edgeStats[edge.relation] += 1;

  const tagVocabulary = [...new Set(nodes.flatMap((node) => node.tags))].sort();
  const projectIdsInGraph = new Set(
    nodes.map((node) => node.projectId).filter((id): id is string => !!id)
  );

  return {
    nodes,
    edges,
    projects: projectRows.filter((project) => projectIdsInGraph.has(project.id)),
    tags: tagVocabulary,
    entityTypes: [...BRAIN_ENTITY_TYPES],
    memoryTypes: [...MEMORY_TYPES],
    edgeStats,
    truncated: {
      nodes: entitiesTruncated || memoriesTruncated,
      edges:
        candidates.length > edgeLimit ||
        relationshipRows.length > edgeLimit ||
        linkRows.length > edgeLimit,
    },
    generatedAt: new Date().toISOString(),
  };
}
