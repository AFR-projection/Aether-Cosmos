import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memoryDerivedLinks, memoryLinks } from "@/shared/infrastructure/db/schema";
import { retrieveMemories, type RetrieveParams, type RetrievalResult } from "@brain/application/queries/retrieve";

/**
 * Relationship retrieval: what else in this brain bears on this memory?
 *
 * Four tiers, in strict order of how much an agent should trust them:
 *
 *  1. **explicit**   — a user or agent asserted this link (`memory_links`). Fact.
 *  2. **inferred**   — >= 2 independent signal families agreed (`memory_derived_links`).
 *  3. **derived**    — one signal family passed its gate. A plausible guess.
 *  4. **graph**      — reachable in 2+ hops of explicit links. Weak, transitive.
 *  5. **retrieval**  — nothing links them; they merely answer the same query.
 *
 * The tiers occupy disjoint score bands, so an agent that sorts by score gets the
 * trust ordering for free and a derived edge can never outrank a stated one. Every
 * result carries `origin` and `explicit` so a caller that cares can filter instead
 * of trusting the ranking — PRINSIP 3: the agent must be able to tell "the user said
 * A relates to B" from "the system suspects A relates to B".
 *
 * The derived tier is reported in two halves, distinguished by `status`. A single
 * signal family cannot reach `CONF_APPLY_MIN` on evidence alone — 0.45 base plus a
 * bonus capped at 0.03 never reaches 0.55 — so a text-only match is always stored
 * `suggested`. Reading only `applied` here would mean the commonest kind of derived
 * edge existed in the database and was invisible to the tool whose entire job is to
 * surface it. So both are returned, `suggested` ranked at the bottom of the derived
 * band and labelled, and a caller that wants only auto-applied edges passes
 * `appliedOnly`. Rank expresses confidence; the label carries the truth.
 */

export type RelatedOrigin = "explicit" | "inferred" | "derived" | "graph" | "retrieval";

export type RelatedMemory = {
  id: string;
  title: string;
  type: string;
  score: number;
  /** Which tier this result came from. */
  origin: RelatedOrigin;
  /** True only for asserted links. Convenience mirror of `origin === "explicit"`. */
  explicit: boolean;
  /** Human-readable justification, accumulated across tiers. */
  reason: string;
  /** Explicit links only: the asserted link type ("supersedes", "related_to", ...). */
  linkType?: string;
  /** Graph tier: how many hops of explicit links away. */
  hops?: number;
  /** Derived tiers: similarity strength 0..1. */
  weight?: number;
  /** Derived tiers: belief 0..1, driven by how many signal families agreed. */
  confidence?: number;
  /**
   * Derived tiers: `applied` when the edge cleared the apply threshold, `suggested`
   * when it is below it. A `suggested` result is a hypothesis worth seeing, not a
   * relationship the system stands behind.
   */
  status?: "applied" | "suggested";
  /** Derived tiers: bounded structured evidence. Never full memory content. */
  evidence?: Record<string, unknown>;
  /** Derived tiers: scorer version that produced the edge. */
  computedBy?: string;
};

/**
 * Disjoint score bands, one per tier. The gaps are what make the ranking express
 * trust rather than just similarity: a perfect derived edge (0.58) still loses to the
 * weakest explicit one (1.0), and a 2-hop explicit path (0.30) still loses to a
 * single-family derived edge (0.40) because transitive relatedness is thinner
 * evidence than a measured signal.
 *
 * The derived band 0.40–0.58 is split in two, with a gap wider than
 * `AGREEMENT_BOOST` between them: an applied edge (0.50–0.58) always outranks a
 * suggested one (0.40–0.45), however strong the suggestion or however many weaker
 * tiers also nominated it.
 *
 * `AGREEMENT_BOOST` is deliberately smaller than the gap between adjacent bands, so
 * a result confirmed by several tiers rises within its band. It is applied per extra
 * tier, so a result nominated by three tiers at once can reach the bottom of the next
 * band up — accepted, because agreement from independent readings is exactly the
 * evidence that ordering is meant to reward.
 */
const SCORE = {
  EXPLICIT: 1.0,
  INFERRED_BASE: 0.6,
  INFERRED_SPAN: 0.2,
  /** Derived + applied: the upper half of the derived band. */
  DERIVED_BASE: 0.5,
  DERIVED_SPAN: 0.08,
  /** Derived + suggested: the lower half, below every applied edge. */
  SUGGESTED_BASE: 0.4,
  SUGGESTED_SPAN: 0.05,
  /** Divided by (hops - 1), so 2 hops = 0.30 and 3 hops = 0.15. */
  GRAPH_BASE: 0.3,
  RETRIEVAL_MAX: 0.28,
  AGREEMENT_BOOST: 0.03,
  /** PRINSIP 14: same project is a nudge, never a filter. */
  PROJECT_BOOST: 0.02,
} as const;

/** Rows read per BFS hop. Bounds a hub memory's fan-out. */
const GRAPH_FRONTIER_MAX = 500;
/** Derived edges read for the seed. */
const DERIVED_FETCH_MAX = 60;

type ExplicitNeighbour = { hops: number; linkType: string };

/**
 * Breadth-first expansion over explicit memory links, bounded at every hop.
 *
 * The first cut loaded *every* `memory_links` row in the brain and built the whole
 * graph in memory to answer a question about one node — fine for 17 memories, a
 * full-table scan plus an O(E) allocation at 100k. Here each hop is a single
 * index-backed query against the previous frontier, capped at GRAPH_FRONTIER_MAX
 * rows, so cost tracks the neighbourhood rather than the brain.
 */
async function expandExplicitNeighbourhood(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string,
  maxHops: number
): Promise<Map<string, ExplicitNeighbour>> {
  const found = new Map<string, ExplicitNeighbour>();
  let frontier = [seedMemoryId];

  for (let hop = 1; hop <= Math.max(1, maxHops); hop += 1) {
    if (frontier.length === 0) break;

    const rows = await db
      .select({
        sourceMemoryId: memoryLinks.sourceMemoryId,
        targetMemoryId: memoryLinks.targetMemoryId,
        linkType: memoryLinks.linkType,
      })
      .from(memoryLinks)
      .where(
        and(
          eq(memoryLinks.brainId, brainId),
          eq(memoryLinks.targetType, "memory"),
          or(
            inArray(memoryLinks.sourceMemoryId, frontier),
            inArray(memoryLinks.targetMemoryId, frontier)
          )
        )
      )
      .orderBy(asc(memoryLinks.createdAt), asc(memoryLinks.id))
      .limit(GRAPH_FRONTIER_MAX);

    const next: string[] = [];
    for (const row of rows) {
      if (!row.targetMemoryId) continue;
      // Undirected: whichever endpoint is not already known is the new node.
      for (const candidate of [row.sourceMemoryId, row.targetMemoryId]) {
        if (candidate === seedMemoryId) continue;
        if (found.has(candidate)) continue;
        found.set(candidate, { hops: hop, linkType: row.linkType });
        next.push(candidate);
      }
    }
    frontier = next;
  }

  return found;
}

/**
 * Find memories related to a seed memory, merging explicit, derived and retrieval
 * evidence into one ranked list with provenance intact.
 *
 * @param maxResults - cap on returned rows (default 20)
 * @param maxHops - explicit-graph search depth (default 2)
 * @param appliedOnly - drop derived edges that are still `suggested`. Off by
 *   default: a lone signal family can never clear the apply threshold, so hiding
 *   suggestions hides most derived knowledge. Pass it when only auto-applied
 *   relationships will do.
 */
export async function findRelatedMemories(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string,
  maxResults = 20,
  maxHops = 2,
  appliedOnly = false
): Promise<RelatedMemory[]> {
  // Step 1: the seed itself. Also the tenant check — every later query is scoped by
  // brainId, and a seed from another brain never gets past here.
  const [seed] = await db
    .select({
      id: schema.memories.id,
      title: schema.memories.title,
      summary: schema.memories.summary,
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

  const combined = new Map<string, RelatedMemory>();

  /**
   * Record a candidate at a given tier. Tiers are offered strongest-first, so an id
   * already present was seen at a higher tier: keep that tier and only note the
   * agreement. This is what guarantees an explicit link is never relabelled derived.
   */
  const offer = (candidate: RelatedMemory): void => {
    const existing = combined.get(candidate.id);
    if (!existing) {
      combined.set(candidate.id, candidate);
      return;
    }
    existing.score = Math.min(
      SCORE.EXPLICIT,
      existing.score + SCORE.AGREEMENT_BOOST
    );
    existing.reason = `${existing.reason}, also ${candidate.reason}`;
  };

  // Step 2: explicit links, direct and transitive, in one bounded expansion.
  const explicitNeighbours = await expandExplicitNeighbourhood(
    db,
    brainId,
    seedMemoryId,
    maxHops
  );

  for (const [memoryId, { hops, linkType }] of explicitNeighbours) {
    if (hops === 1) {
      offer({
        id: memoryId,
        title: "",
        type: "",
        score: SCORE.EXPLICIT,
        origin: "explicit",
        explicit: true,
        reason: "direct_link",
        linkType,
        hops,
      });
    }
  }

  // Step 3: derived edges. Read straight from memory_derived_links — this is the
  // whole point of PHASE 2, and it is the only tier that carries evidence.
  const statuses: Array<"applied" | "suggested"> = appliedOnly
    ? ["applied"]
    : ["applied", "suggested"];

  const derivedRows = await db
    .select()
    .from(memoryDerivedLinks)
    .where(
      and(
        eq(memoryDerivedLinks.brainId, brainId),
        inArray(memoryDerivedLinks.status, statuses),
        or(
          eq(memoryDerivedLinks.sourceMemoryId, seedMemoryId),
          eq(memoryDerivedLinks.targetMemoryId, seedMemoryId)
        )
      )
    )
    .orderBy(
      // Fetch the strongest edges first so truncation at DERIVED_FETCH_MAX keeps
      // them, matching the trustRank sort applied below: inferred, then applied,
      // then by weight, with id as a deterministic final tiebreak.
      sql`(${memoryDerivedLinks.origin} = 'inferred') desc`,
      sql`(${memoryDerivedLinks.status} = 'applied') desc`,
      desc(memoryDerivedLinks.weight),
      asc(memoryDerivedLinks.id)
    )
    .limit(DERIVED_FETCH_MAX);

  /** Strongest reading of a pair first: inferred, then applied, then suggested. */
  const trustRank = (row: { origin: string; status: string }): number =>
    row.origin === "inferred" ? 0 : row.status === "applied" ? 1 : 2;

  // Offered strongest-first so that if two rows somehow describe one pair, the more
  // trusted one claims the tier and the other only registers as agreement.
  const orderedDerived = [...derivedRows].sort((a, b) => {
    const rank = trustRank(a) - trustRank(b);
    if (rank !== 0) return rank;
    return b.weight - a.weight;
  });

  for (const edge of orderedDerived) {
    const neighbourId =
      edge.sourceMemoryId === seedMemoryId ? edge.targetMemoryId : edge.sourceMemoryId;
    if (neighbourId === seedMemoryId) continue;

    const inferred = edge.origin === "inferred";
    const suggested = !inferred && edge.status === "suggested";
    const base = inferred
      ? SCORE.INFERRED_BASE
      : suggested
        ? SCORE.SUGGESTED_BASE
        : SCORE.DERIVED_BASE;
    const span = inferred
      ? SCORE.INFERRED_SPAN
      : suggested
        ? SCORE.SUGGESTED_SPAN
        : SCORE.DERIVED_SPAN;

    offer({
      id: neighbourId,
      title: "",
      type: "",
      // Weight positions the edge inside its band; confidence never moves it across
      // one, because origin and status already encode how much agreement there was.
      score: base + span * Math.max(0, Math.min(1, edge.weight)),
      origin: inferred ? "inferred" : "derived",
      explicit: false,
      reason: edge.reason,
      weight: edge.weight,
      confidence: edge.confidence,
      status: edge.status,
      evidence: (edge.evidence as Record<string, unknown> | null) ?? undefined,
      computedBy: edge.computedBy,
    });
  }

  // Step 4: transitive explicit paths, below both derived tiers.
  for (const [memoryId, { hops, linkType }] of explicitNeighbours) {
    if (hops < 2) continue;
    offer({
      id: memoryId,
      title: "",
      type: "",
      score: SCORE.GRAPH_BASE / (hops - 1),
      origin: "graph",
      // A 2-hop path is not itself an assertion about this pair, so `explicit` is
      // false even though every edge along the way was asserted.
      explicit: false,
      reason: `graph_proximity_${hops}_hops`,
      linkType,
      hops,
    });
  }

  // Step 5: retrieval fallback, so a memory with no edges at all still gets answers.
  //
  // The query is title + summary, not just the title: a one-word title retrieves
  // almost nothing, and the fallback is exactly the case where the seed has no graph
  // to lean on. `projectId` is deliberately NOT passed — PRINSIP 14 — because a hard
  // project filter turns "related" into "related, as long as somebody filed it in the
  // same folder". It is applied as a small boost further down instead.
  const retrievalParams: RetrieveParams = {
    brainId,
    query: `${seed.title} ${seed.summary ?? ""}`.trim(),
    limit: Math.min(maxResults * 2, 40),
    includeArchived: false,
  };

  const retrievalResult: RetrievalResult = await retrieveMemories(db, retrievalParams);
  for (const candidate of retrievalResult.results) {
    if (candidate.id === seedMemoryId) continue;

    const legs: string[] = [];
    if (candidate.legs.some((leg: string) => leg === "lexical")) legs.push("lexical_match");
    if (candidate.legs.some((leg: string) => leg === "entity")) legs.push("shared_entity");

    offer({
      id: candidate.id,
      title: "",
      type: "",
      // Clamped into the bottom band: "answers the same query" is the weakest claim
      // this function can make, and it must not outrank a measured edge.
      score: SCORE.RETRIEVAL_MAX * Math.max(0, Math.min(1, candidate.score.score)),
      origin: "retrieval",
      explicit: false,
      reason: legs.join(", ") || "semantic",
    });
  }

  // Step 6: hydrate titles/types, and drop anything that no longer resolves inside
  // this brain. Doubles as the isolation backstop: a cross-brain or soft-deleted id
  // that somehow reached this far has no row here and is filtered below.
  const memoryIds = Array.from(combined.keys());
  if (memoryIds.length === 0) return [];

  const memoryRows = await db
    .select({
      id: schema.memories.id,
      title: schema.memories.title,
      type: schema.memories.type,
      projectId: schema.memories.projectId,
    })
    .from(schema.memories)
    .where(
      and(
        eq(schema.memories.brainId, brainId),
        inArray(schema.memories.id, memoryIds),
        isNull(schema.memories.deletedAt)
      )
    );

  const resolved = new Set<string>();
  for (const row of memoryRows) {
    const related = combined.get(row.id);
    if (!related) continue;
    resolved.add(row.id);
    related.title = row.title;
    related.type = row.type;
    if (seed.projectId && row.projectId === seed.projectId) {
      related.score = Math.min(SCORE.EXPLICIT, related.score + SCORE.PROJECT_BOOST);
      related.reason = `${related.reason}, same_project`;
    }
  }

  // Step 7: deterministic ranking. Id breaks score ties so two identical brains
  // answer identically — without it, Map iteration order leaks probe order into the
  // response.
  return Array.from(combined.values())
    .filter((r) => resolved.has(r.id))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, maxResults);
}

/**
 * Service wrapper using the application database connection.
 */
export function getBrainRelatedMemories(
  brainId: string,
  seedMemoryId: string,
  maxResults?: number,
  maxHops?: number,
  appliedOnly?: boolean
): Promise<RelatedMemory[]> {
  return findRelatedMemories(
    applicationDb,
    brainId,
    seedMemoryId,
    maxResults,
    maxHops,
    appliedOnly
  );
}
