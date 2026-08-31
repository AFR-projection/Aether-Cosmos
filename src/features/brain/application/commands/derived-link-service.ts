import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, or, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memoryDerivedLinks, memories } from "@/shared/infrastructure/db/schema";
import { RELATE_DEFAULTS, type ScoredEdgeWithEvidence } from "@brain/domain/graph/relate";

/**
 * PHASE 2: Derived relationship persistence and reconciliation.
 *
 * Design invariants enforced here:
 * - Canonical ordering: source < target (undirected pairs)
 * - Brain isolation: brainId in every WHERE clause
 * - Reconcilable: only touch rows with matching computedBy
 * - Idempotent: same input + contentHash → same output, no drift
 * - Deterministic: transaction-safe upsert
 */

export const RELATE_VERSION = "relate-v1";

/**
 * Policy thresholds for DETECT → SCORE → SUGGEST/APPLY workflow.
 * Tunable constants in one block.
 */
export const RELATE_POLICY = {
  /** Base confidence for single-signal derived edges */
  CONF_BASE_DERIVED: 0.45,
  /** Base confidence for multi-signal inferred edges */
  CONF_BASE_INFERRED: 0.65,
  /** Bonus per additional signal family beyond the first */
  CONF_FAMILY_BONUS: 0.12,
  /** Minimum confidence to auto-apply (status = 'applied') */
  CONF_APPLY_MIN: 0.55,
  /** Minimum confidence to suggest (status = 'suggested'); below this = not stored */
  CONF_SUGGEST_MIN: 0.40,
} as const;

/**
 * One derived edge ready for persistence, with full provenance.
 * Produced by the scoring layer (relate.ts extensions in next step).
 */
export type DerivedEdgeInput = {
  /** Unordered pair — will be canonicalized before insert */
  memoryA: string;
  memoryB: string;
  /** derived (1 signal family) | inferred (>= 2 families) */
  origin: "derived" | "inferred";
  /** Dominant signal: semantic | tag | entity | project */
  relation: string;
  /** Edge strength 0..1 */
  weight: number;
  /** Belief 0..1 based on signal agreement */
  confidence: number;
  /** Bounded structured evidence, safe for agents */
  evidence: Record<string, unknown>;
  /** Human-readable <= 90 chars */
  reason: string;
  /**
   * contentHash of `memoryA` — of that memory specifically, not of the canonical
   * source slot. `reconcileDerivedEdges` swaps the two along with the IDs when it
   * canonicalizes, so `source_hash_a` always describes `source_memory_id`.
   */
  hashA: string;
  /** contentHash of `memoryB` (see hashA). */
  hashB: string;
};

export type DerivedEdge = typeof memoryDerivedLinks.$inferSelect;

/**
 * Canonicalize an undirected pair: source < target.
 * Enforces the CHECK constraint at application layer.
 */
export function canonicalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Compute confidence from signal family count and evidence strength.
 * Confidence ≠ weight: weight is similarity strength, confidence is belief.
 */
export function computeConfidence(
  origin: "derived" | "inferred",
  signalFamilyCount: number,
  evidenceStrength: number
): number {
  const base = origin === "inferred" ? RELATE_POLICY.CONF_BASE_INFERRED : RELATE_POLICY.CONF_BASE_DERIVED;
  const bonus = RELATE_POLICY.CONF_FAMILY_BONUS * Math.max(0, signalFamilyCount - 1);
  const conf = base + bonus + evidenceStrength * 0.1; // evidenceStrength is already capped
  return Math.max(0, Math.min(1, conf)); // clamp 0..1
}

/**
 * Turn scored pairs into rows ready for `reconcileDerivedEdges`.
 *
 * This is the whole of the scorer→storage policy, and it lives here rather than in
 * the worker so that it is reachable from a test: the decisions it makes (how many
 * families count as agreement, how much a strong single signal is allowed to buy,
 * what is too weak to keep at all) are exactly what the integration tests need to
 * pin down, and a copy of them in a test would only prove the copy right.
 *
 * @param hashes - contentHash per memory id, so each edge records what it was scored
 *   against. A missing hash stores empty rather than guessing, and the staleness
 *   check will then treat the edge as needing a recompute.
 */
export function toDerivedEdgeInputs(
  scored: ScoredEdgeWithEvidence[],
  hashes: Map<string, string>
): DerivedEdgeInput[] {
  const edges = scored.map((edge) => {
    const familyCount = edge.evidence.signalFamilyCount;
    const origin: "derived" | "inferred" = familyCount >= 2 ? "inferred" : "derived";

    // Evidence strength: bounded contribution so a strong single signal can never
    // outrank genuine multi-family agreement.
    const evidenceStrength = Math.min(0.3, edge.weight * 0.3);

    return {
      memoryA: edge.memoryA,
      memoryB: edge.memoryB,
      origin,
      relation: edge.relation,
      weight: edge.weight,
      confidence: computeConfidence(origin, familyCount, evidenceStrength),
      evidence: edge.evidence,
      reason: edge.reason,
      hashA: hashes.get(edge.memoryA) ?? "",
      hashB: hashes.get(edge.memoryB) ?? "",
    };
  });

  // Below CONF_SUGGEST_MIN an edge is not even worth showing as a suggestion.
  return edges.filter((edge) => edge.confidence >= RELATE_POLICY.CONF_SUGGEST_MIN);
}

/**
 * The other endpoint of an edge relative to `seedMemoryId`.
 * Edges are undirected, so "the neighbour" is whichever id is not the seed.
 */
function neighbourOf(edge: DerivedEdgeInput, seedMemoryId: string): string {
  return edge.memoryA === seedMemoryId ? edge.memoryB : edge.memoryA;
}

/**
 * Deterministic ordering for a seed's candidate edges: strongest first, ties broken
 * by neighbour id. Two runs over the same data must produce the same list, or
 * top-K pruning would silently churn rows on every recompute.
 */
function orderEdges(edges: DerivedEdgeInput[], seedMemoryId: string): DerivedEdgeInput[] {
  return [...edges].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const na = neighbourOf(a, seedMemoryId);
    const nb = neighbourOf(b, seedMemoryId);
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

export type PruneStats = {
  /** Dropped because the seed already had K stronger neighbours. */
  droppedTopK: number;
  /** Dropped because the neighbour is already at maxDegree. */
  droppedDegree: number;
  /** Dropped because the brain is at maxEdges. */
  droppedGlobalCap: number;
};

/**
 * PRINSIP 10: never auto-link blindly. Three bounds, applied in this order:
 *
 * 1. **top-K** (`neighbours`) — a seed contributes at most K derived edges. Keeps a
 *    verbose memory from fanning out to everything it vaguely resembles.
 * 2. **maxDegree** — refuse an edge whose *other* endpoint is already saturated, so
 *    one popular memory cannot become a hub the whole graph routes through.
 * 3. **maxEdges** — global per-brain ceiling.
 *
 * Degree and total counts are read inside the caller's transaction *after* the seed's
 * own rows have been deleted, so the seed never counts itself and a recompute cannot
 * inflate its neighbours' degrees.
 *
 * "Better to lose a relationship than to turn the graph into a hairball."
 */
async function pruneForSeed(
  tx: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string,
  edges: DerivedEdgeInput[],
  limits: { neighbours: number; maxDegree: number; maxEdges: number }
): Promise<{ kept: DerivedEdgeInput[]; stats: PruneStats }> {
  const stats: PruneStats = { droppedTopK: 0, droppedDegree: 0, droppedGlobalCap: 0 };
  if (edges.length === 0) return { kept: [], stats };

  const ordered = orderEdges(edges, seedMemoryId);
  const topK = ordered.slice(0, limits.neighbours);
  stats.droppedTopK = ordered.length - topK.length;

  // Current degree of every prospective neighbour, seed's own edges excluded.
  // Raw SQL because this is a UNION ALL over both endpoint columns — expressing it
  // through the query builder would need a named subquery for no benefit.
  const degrees = new Map<string, number>();
  const degreeRows = (await tx.execute(sql`
    SELECT m.id AS id, count(*)::int AS degree
    FROM (
      SELECT source_memory_id AS id, target_memory_id AS other
      FROM memory_derived_links
      WHERE brain_id = ${brainId} AND status = 'applied'
      UNION ALL
      SELECT target_memory_id AS id, source_memory_id AS other
      FROM memory_derived_links
      WHERE brain_id = ${brainId} AND status = 'applied'
    ) AS m
    WHERE m.id <> ${seedMemoryId} AND m.other <> ${seedMemoryId}
    GROUP BY m.id
  `)) as unknown as Array<{ id: string; degree: number }>;

  for (const row of degreeRows) degrees.set(row.id, Number(row.degree));

  const [totalRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryDerivedLinks)
    .where(eq(memoryDerivedLinks.brainId, brainId));
  let budget = Math.max(0, limits.maxEdges - (totalRow?.count ?? 0));

  const kept: DerivedEdgeInput[] = [];
  for (const edge of topK) {
    const neighbour = neighbourOf(edge, seedMemoryId);
    if ((degrees.get(neighbour) ?? 0) >= limits.maxDegree) {
      stats.droppedDegree += 1;
      continue;
    }
    if (budget <= 0) {
      stats.droppedGlobalCap += 1;
      continue;
    }
    kept.push(edge);
    budget -= 1;
  }

  return { kept, stats };
}

/**
 * Reconcile derived edges for one seed memory in a single transaction.
 *
 * Pattern (mirrors enrichment's "own only what you wrote"):
 * 1. DELETE rows this version owns touching the seed
 * 2. PRUNE the incoming set against top-K / maxDegree / global cap
 * 3. INSERT survivors, ON CONFLICT UPDATE if another writer got there first
 *
 * Guarantees:
 * - Idempotent: running twice with same input produces same final state
 * - Deterministic: output depends only on input + scorer constants
 * - Safe: only deletes rows with computedBy = RELATE_VERSION (relate-v2 rows survive)
 * - Isolated: brainId in every clause
 */
export async function reconcileDerivedEdges(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string,
  edges: DerivedEdgeInput[],
  options: { neighbours?: number; maxDegree?: number; maxEdges?: number } = {}
): Promise<{ inserted: number; updated: number; deleted: number; pruned: PruneStats }> {
  const limits = {
    neighbours: options.neighbours ?? RELATE_DEFAULTS.neighbours,
    maxDegree: options.maxDegree ?? RELATE_DEFAULTS.maxDegree,
    maxEdges: options.maxEdges ?? RELATE_DEFAULTS.maxEdges,
  };

  return await db.transaction(async (tx) => {
    // Step 1: Delete stale rows this version owns
    const deleted = await tx
      .delete(memoryDerivedLinks)
      .where(
        and(
          eq(memoryDerivedLinks.brainId, brainId),
          eq(memoryDerivedLinks.computedBy, RELATE_VERSION),
          or(
            eq(memoryDerivedLinks.sourceMemoryId, seedMemoryId),
            eq(memoryDerivedLinks.targetMemoryId, seedMemoryId)
          )
        )
      )
      .returning({ id: memoryDerivedLinks.id });

    // Step 2: Bound the graph before writing anything.
    const { kept, stats } = await pruneForSeed(tx, brainId, seedMemoryId, edges, limits);

    // Step 3: Insert survivors
    let inserted = 0;
    let updated = 0;

    if (kept.length > 0) {
      const values = kept.map((edge) => {
        const [source, target] = canonicalizePair(edge.memoryA, edge.memoryB);
        // The hashes travel with their memory, not with the slot: if canonicalizing
        // swapped the ids, swap the hashes too or every edge whose pair happened to
        // arrive in the wrong order would look permanently stale.
        const swapped = source !== edge.memoryA;
        const status = edge.confidence >= RELATE_POLICY.CONF_APPLY_MIN ? "applied" : "suggested";

        return {
          brainId,
          sourceMemoryId: source,
          targetMemoryId: target,
          origin: edge.origin,
          status: status as "applied" | "suggested",
          relation: edge.relation,
          weight: edge.weight,
          confidence: edge.confidence,
          evidence: edge.evidence,
          reason: edge.reason,
          computedBy: RELATE_VERSION,
          sourceHashA: swapped ? edge.hashB : edge.hashA,
          sourceHashB: swapped ? edge.hashA : edge.hashB,
        };
      });

      const result = await tx
        .insert(memoryDerivedLinks)
        .values(values)
        .onConflictDoUpdate({
          target: [
            memoryDerivedLinks.brainId,
            memoryDerivedLinks.sourceMemoryId,
            memoryDerivedLinks.targetMemoryId,
          ],
          set: {
            origin: sql`EXCLUDED.origin`,
            status: sql`EXCLUDED.status`,
            relation: sql`EXCLUDED.relation`,
            weight: sql`EXCLUDED.weight`,
            confidence: sql`EXCLUDED.confidence`,
            evidence: sql`EXCLUDED.evidence`,
            reason: sql`EXCLUDED.reason`,
            computedBy: sql`EXCLUDED.computed_by`,
            sourceHashA: sql`EXCLUDED.source_hash_a`,
            sourceHashB: sql`EXCLUDED.source_hash_b`,
            updatedAt: sql`NOW()`,
          },
        })
        // `xmax = 0` is true only for a genuinely inserted row: an ON CONFLICT update
        // leaves the updating transaction's id in xmax. Cheaper than a pre-SELECT and
        // exact, where the first cut just reported every returned row as an insert.
        .returning({ id: memoryDerivedLinks.id, isInsert: sql<boolean>`(xmax = 0)` });

      for (const row of result) {
        if (row.isInsert) inserted += 1;
        else updated += 1;
      }
    }

    return { inserted, updated, deleted: deleted.length, pruned: stats };
  });
}

/**
 * Hard-delete all derived edges touching a memory (both directions).
 *
 * Called on soft-delete of a memory, since FK CASCADE does not fire for soft deletes.
 * Derived edges are ephemeral computational artifacts — safe to delete.
 * Explicit edges in memory_links survive (by design, so restore revives them).
 */
export async function deleteDerivedEdgesFor(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string
): Promise<number> {
  const deleted = await db
    .delete(memoryDerivedLinks)
    .where(
      and(
        eq(memoryDerivedLinks.brainId, brainId),
        or(
          eq(memoryDerivedLinks.sourceMemoryId, memoryId),
          eq(memoryDerivedLinks.targetMemoryId, memoryId)
        )
      )
    )
    .returning({ id: memoryDerivedLinks.id });

  return deleted.length;
}

/**
 * Load derived edges for a memory (both directions), optionally filtered by status.
 *
 * Returns undirected neighbors: if seed is source, return target; if seed is target, return source.
 * Sorted by weight DESC (strongest first).
 */
export async function loadDerivedNeighbors(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string,
  options: {
    status?: "applied" | "suggested";
    limit?: number;
  } = {}
): Promise<Array<DerivedEdge & { neighborId: string }>> {
  const { status = "applied", limit = 50 } = options;

  // Query both directions and UNION
  const outgoing = await db
    .select()
    .from(memoryDerivedLinks)
    .where(
      and(
        eq(memoryDerivedLinks.brainId, brainId),
        eq(memoryDerivedLinks.sourceMemoryId, memoryId),
        eq(memoryDerivedLinks.status, status)
      )
    )
    .orderBy(sql`${memoryDerivedLinks.weight} DESC, ${memoryDerivedLinks.id} ASC`)
    .limit(limit);

  const incoming = await db
    .select()
    .from(memoryDerivedLinks)
    .where(
      and(
        eq(memoryDerivedLinks.brainId, brainId),
        eq(memoryDerivedLinks.targetMemoryId, memoryId),
        eq(memoryDerivedLinks.status, status)
      )
    )
    .orderBy(sql`${memoryDerivedLinks.weight} DESC, ${memoryDerivedLinks.id} ASC`)
    .limit(limit);

  // Merge and dedupe by *neighbour id*, not row id: brain_related must never emit the
  // same memory twice, and canonical ordering makes a duplicate pair impossible only
  // as long as the CHECK constraint holds.
  const seen = new Set<string>();
  const results: Array<DerivedEdge & { neighborId: string }> = [];

  for (const edge of [...outgoing, ...incoming]) {
    const neighborId = edge.sourceMemoryId === memoryId ? edge.targetMemoryId : edge.sourceMemoryId;
    if (seen.has(neighborId)) continue;
    seen.add(neighborId);
    results.push({ ...edge, neighborId });
  }

  // Re-sort after merge; neighbour id breaks ties so the order is deterministic.
  results.sort((a, b) => b.weight - a.weight || (a.neighborId < b.neighborId ? -1 : 1));

  return results.slice(0, limit);
}

/**
 * Check if a memory's derived edges are stale (contentHash mismatch).
 *
 * Returns memory IDs whose hashes don't match current state.
 * Used by DETECT sweep to prioritize recomputation without re-scoring.
 */
export async function detectStaleEdges(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string
): Promise<{ stale: boolean; reason?: string }> {
  // Load current contentHash
  const [memory] = await db
    .select({ contentHash: memories.contentHash })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId)))
    .limit(1);

  if (!memory) {
    return { stale: false, reason: "memory not found" };
  }

  // Check if any derived edge touching this memory has mismatched hash
  const [staleCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryDerivedLinks)
    .where(
      and(
        eq(memoryDerivedLinks.brainId, brainId),
        eq(memoryDerivedLinks.computedBy, RELATE_VERSION),
        or(
          and(
            eq(memoryDerivedLinks.sourceMemoryId, memoryId),
            sql`${memoryDerivedLinks.sourceHashA} IS DISTINCT FROM ${memory.contentHash}`
          ),
          and(
            eq(memoryDerivedLinks.targetMemoryId, memoryId),
            sql`${memoryDerivedLinks.sourceHashB} IS DISTINCT FROM ${memory.contentHash}`
          )
        )
      )
    );

  return {
    stale: staleCount.count > 0,
    reason: staleCount.count > 0 ? `${staleCount.count} edges with hash mismatch` : undefined,
  };
}

/**
 * Reconcile with application DB as default.
 */
export const reconcileDerivedEdgesDefault = (
  brainId: string,
  seedMemoryId: string,
  edges: DerivedEdgeInput[]
) => reconcileDerivedEdges(applicationDb, brainId, seedMemoryId, edges);
export const deleteDerivedEdgesForDefault = (brainId: string, memoryId: string) =>
  deleteDerivedEdgesFor(applicationDb, brainId, memoryId);

export const loadDerivedNeighborsDefault = (
  brainId: string,
  memoryId: string,
  options?: Parameters<typeof loadDerivedNeighbors>[3]
) => loadDerivedNeighbors(applicationDb, brainId, memoryId, options);

export const detectStaleEdgesDefault = (brainId: string, memoryId: string) =>
  detectStaleEdges(applicationDb, brainId, memoryId);
