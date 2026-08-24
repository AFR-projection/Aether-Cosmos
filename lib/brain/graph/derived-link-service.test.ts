import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import {
  RELATE_POLICY,
  RELATE_VERSION,
  canonicalizePair,
  computeConfidence,
  deleteDerivedEdgesFor,
  detectStaleEdges,
  loadDerivedNeighbors,
  reconcileDerivedEdges,
  toDerivedEdgeInputs,
  type DerivedEdgeInput,
} from "./derived-link-service";

/**
 * PHASE 2 persistence. Everything here is about not lying and not sprawling:
 *
 * - a computed edge is stored as a canonical undirected pair, with the hash of each
 *   endpoint attached to *that* endpoint, so staleness can be detected later;
 * - reconciliation owns only the rows its own scorer version wrote, so a future
 *   relate-v2 can coexist instead of being deleted by v1;
 * - the same input produces the same rows, however it was ordered;
 * - three bounds (top-K, neighbour degree, per-brain ceiling) stand between the
 *   scorer and a hairball, and each one reports how many edges it dropped;
 * - every statement names the brain.
 *
 * The database is a recorder: it captures each statement and answers with queued rows,
 * which is enough because the interesting logic is all on this side of the wire. The
 * constraints themselves are asserted against the migration in the schema suite.
 */

type DeleteCall = { table: string; where: unknown };
type SelectCall = { table: string; where: unknown; limit: number | null };
type InsertCall = {
  table: string;
  values: Array<Record<string, unknown>>;
  conflictTarget: string[];
  set: Record<string, unknown>;
};

function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if ("queryChunks" in record) walk(record.queryChunks);
    if ("value" in record) walk(record.value);
    else if (typeof record.name === "string") parts.push(record.name);
  };

  walk(node);
  return parts.join(" ");
}

type FakeState = {
  /** Rows the DELETE reports having removed. */
  deletedIds?: string[];
  /** Degree per prospective neighbour, as the raw UNION ALL query would answer. */
  degrees?: Array<{ id: string; degree: number }>;
  /** Results for successive `select()` reads, in call order. */
  selectRows?: unknown[][];
  /** Endpoints whose insert should report as an ON CONFLICT update, not an insert. */
  conflicts?: Set<string>;
};

function fakeDb(state: FakeState = {}) {
  const deletes: DeleteCall[] = [];
  const selects: SelectCall[] = [];
  const inserts: InsertCall[] = [];
  const executes: unknown[] = [];
  let selectCursor = 0;

  const tx = {
    delete(table: unknown) {
      const call: DeleteCall = { table: getTableName(table as never), where: null };
      const chain = {
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        returning() {
          deletes.push(call);
          return Promise.resolve((state.deletedIds ?? []).map((id) => ({ id })));
        },
      };
      return chain;
    },
    select() {
      const call: SelectCall = { table: "", where: null, limit: null };
      const chain = {
        from(table: unknown) {
          call.table = getTableName(table as never);
          return chain;
        },
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        orderBy: () => chain,
        limit(value: number) {
          call.limit = value;
          return chain;
        },
        then<T>(resolve: (value: unknown[]) => T) {
          selects.push(call);
          return Promise.resolve(state.selectRows?.[selectCursor++] ?? []).then(resolve);
        },
      };
      return chain;
    },
    execute(query: unknown) {
      executes.push(query);
      return Promise.resolve(state.degrees ?? []);
    },
    insert(table: unknown) {
      const call: InsertCall = {
        table: getTableName(table as never),
        values: [],
        conflictTarget: [],
        set: {},
      };
      const chain = {
        values(values: Array<Record<string, unknown>>) {
          call.values = values;
          return chain;
        },
        onConflictDoUpdate(config: { target: unknown[]; set: Record<string, unknown> }) {
          call.conflictTarget = config.target.map((column) =>
            String((column as { name?: string }).name ?? column)
          );
          call.set = config.set;
          return chain;
        },
        returning() {
          inserts.push(call);
          return Promise.resolve(
            call.values.map((row, index) => ({
              id: `row-${index}`,
              isInsert: !(
                state.conflicts?.has(String(row.sourceMemoryId)) ||
                state.conflicts?.has(String(row.targetMemoryId))
              ),
            }))
          );
        },
      };
      return chain;
    },
  };

  const db = {
    ...tx,
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(tx),
  };

  return {
    db: db as unknown as PostgresJsDatabase<typeof schema>,
    deletes,
    selects,
    inserts,
    executes,
  };
}

const BRAIN = "brain-1";
const OTHER_BRAIN = "brain-2";
/** Ids chosen so SEED sorts after A and before B: canonicalisation is observable. */
const A = "mem-a";
const SEED = "mem-m";
const B = "mem-z";
const DERIVED_TABLE = getTableName(schema.memoryDerivedLinks);

function edge(overrides: Partial<DerivedEdgeInput> = {}): DerivedEdgeInput {
  return {
    memoryA: SEED,
    memoryB: B,
    origin: "derived",
    relation: "semantic",
    weight: 0.5,
    confidence: 0.5,
    evidence: { sharedTerms: ["deploy", "hetzner"], signalFamilyCount: 1 },
    reason: "shared terms: deploy, hetzner",
    hashA: "hash-seed",
    hashB: "hash-b",
    ...overrides,
  };
}

/** A fake with the counting reads already answered: no rows, no degree, empty brain. */
function emptyBrain(state: FakeState = {}) {
  return fakeDb({ selectRows: [[{ count: 0 }]], ...state });
}

describe("canonicalizePair", () => {
  it("orders a pair the same way whichever direction it arrives in", () => {
    expect(canonicalizePair(B, A)).toEqual([A, B]);
    expect(canonicalizePair(A, B)).toEqual([A, B]);
  });
});

describe("computeConfidence", () => {
  it("separates belief from strength: more agreeing families, more belief", () => {
    const one = computeConfidence("derived", 1, 0);
    const two = computeConfidence("inferred", 2, 0);
    const three = computeConfidence("inferred", 3, 0);

    expect(one).toBeCloseTo(RELATE_POLICY.CONF_BASE_DERIVED, 5);
    expect(two).toBeCloseTo(RELATE_POLICY.CONF_BASE_INFERRED + RELATE_POLICY.CONF_FAMILY_BONUS, 5);
    expect(three).toBeGreaterThan(two);
    // A single family can never reach the auto-apply threshold on evidence alone.
    expect(computeConfidence("derived", 1, 0.3)).toBeLessThan(RELATE_POLICY.CONF_APPLY_MIN);
  });

  it("stays inside 0..1 whatever it is handed", () => {
    expect(computeConfidence("inferred", 99, 1)).toBeLessThanOrEqual(1);
    expect(computeConfidence("derived", -5, -5)).toBeGreaterThanOrEqual(0);
  });
});

describe("reconcileDerivedEdges — owning only what this scorer wrote", () => {
  it("clears the seed's rows for this version only, both directions", async () => {
    const { db, deletes } = emptyBrain({ deletedIds: ["old-1", "old-2"] });

    const report = await reconcileDerivedEdges(db, BRAIN, SEED, []);

    expect(deletes).toHaveLength(1);
    expect(deletes[0].table).toBe(DERIVED_TABLE);
    const where = describeSql(deletes[0].where);
    expect(where).toContain("brain_id");
    expect(where).toContain(BRAIN);
    // PRINSIP 8: a relate-v2 row is another algorithm's property.
    expect(where).toContain("computed_by");
    expect(where).toContain(RELATE_VERSION);
    expect(where).toContain("source_memory_id");
    expect(where).toContain("target_memory_id");
    expect(report.deleted).toBe(2);
  });

  it("writes nothing when the scorer found nothing, but still clears the old rows", async () => {
    const { db, inserts } = emptyBrain({ deletedIds: ["old-1"] });

    const report = await reconcileDerivedEdges(db, BRAIN, SEED, []);

    expect(inserts).toEqual([]);
    expect(report).toEqual({
      inserted: 0,
      updated: 0,
      deleted: 1,
      pruned: { droppedTopK: 0, droppedDegree: 0, droppedGlobalCap: 0 },
    });
  });

  it("counts a genuine insert apart from an upsert of an existing pair", async () => {
    const { db } = emptyBrain({ conflicts: new Set([B]) });

    const report = await reconcileDerivedEdges(db, BRAIN, SEED, [
      edge({ memoryB: B }),
      edge({ memoryB: A, hashB: "hash-a" }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.updated).toBe(1);
  });

  it("upserts on the canonical pair, so a recompute can never duplicate an edge", async () => {
    const { db, inserts } = emptyBrain();

    await reconcileDerivedEdges(db, BRAIN, SEED, [edge()]);

    expect(inserts[0].conflictTarget).toEqual([
      "brain_id",
      "source_memory_id",
      "target_memory_id",
    ]);
    // Every scored field is refreshed on conflict; nothing may keep a stale value.
    expect(Object.keys(inserts[0].set).sort()).toEqual([
      "computedBy",
      "confidence",
      "evidence",
      "origin",
      "reason",
      "relation",
      "sourceHashA",
      "sourceHashB",
      "status",
      "updatedAt",
      "weight",
    ]);
  });
});

describe("reconcileDerivedEdges — canonical pairs and hashes", () => {
  it("stores the pair in canonical order however it arrived", async () => {
    const { db, inserts } = emptyBrain();

    // SEED > A, so this pair must be flipped before it is written.
    await reconcileDerivedEdges(db, BRAIN, SEED, [edge({ memoryA: SEED, memoryB: A })]);

    expect(inserts[0].values[0]).toMatchObject({
      brainId: BRAIN,
      sourceMemoryId: A,
      targetMemoryId: SEED,
    });
  });

  it("carries each hash with its own memory when the pair is flipped", async () => {
    const { db, inserts } = emptyBrain();

    await reconcileDerivedEdges(db, BRAIN, SEED, [
      edge({ memoryA: SEED, memoryB: A, hashA: "hash-seed", hashB: "hash-a" }),
    ]);

    // Without the swap every flipped pair would read as permanently stale, and the
    // DETECT sweep would rescore the whole brain forever.
    expect(inserts[0].values[0]).toMatchObject({
      sourceMemoryId: A,
      sourceHashA: "hash-a",
      targetMemoryId: SEED,
      sourceHashB: "hash-seed",
    });
  });

  it("leaves an already-canonical pair and its hashes alone", async () => {
    const { db, inserts } = emptyBrain();

    await reconcileDerivedEdges(db, BRAIN, SEED, [
      edge({ memoryA: SEED, memoryB: B, hashA: "hash-seed", hashB: "hash-b" }),
    ]);

    expect(inserts[0].values[0]).toMatchObject({
      sourceMemoryId: SEED,
      sourceHashA: "hash-seed",
      targetMemoryId: B,
      sourceHashB: "hash-b",
    });
  });

  it("applies a confident edge and only suggests a doubtful one", async () => {
    const { db, inserts } = emptyBrain();

    await reconcileDerivedEdges(db, BRAIN, SEED, [
      edge({ memoryB: B, confidence: RELATE_POLICY.CONF_APPLY_MIN }),
      edge({ memoryB: A, confidence: RELATE_POLICY.CONF_APPLY_MIN - 0.01 }),
    ]);

    const byTarget = new Map(
      inserts[0].values.map((row) => [
        row.sourceMemoryId === SEED ? row.targetMemoryId : row.sourceMemoryId,
        row.status,
      ])
    );
    expect(byTarget.get(B)).toBe("applied");
    expect(byTarget.get(A)).toBe("suggested");
  });

  it("stamps its own version on every row it writes", async () => {
    const { db, inserts } = emptyBrain();

    await reconcileDerivedEdges(db, BRAIN, SEED, [edge()]);

    expect(inserts[0].values[0].computedBy).toBe(RELATE_VERSION);
  });
});

describe("reconcileDerivedEdges — the three bounds (PRINSIP 10)", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      edge({ memoryB: `mem-n${String(index).padStart(2, "0")}`, weight: 1 - index / 100 })
    );

  it("keeps only the seed's K strongest neighbours and says how many it dropped", async () => {
    const { db, inserts } = emptyBrain();

    const report = await reconcileDerivedEdges(db, BRAIN, SEED, many(10), { neighbours: 3 });

    expect(inserts[0].values).toHaveLength(3);
    expect(report.pruned.droppedTopK).toBe(7);
    // Strongest first, so the survivors are the top three weights, not the first three
    // the scorer happened to emit.
    expect(inserts[0].values.map((row) => row.weight)).toEqual([1, 0.99, 0.98]);
  });

  it("refuses an edge to a neighbour that is already saturated", async () => {
    const { db, inserts } = emptyBrain({
      degrees: [
        { id: B, degree: 12 },
        { id: A, degree: 3 },
      ],
    });

    const report = await reconcileDerivedEdges(
      db,
      BRAIN,
      SEED,
      [edge({ memoryB: B, weight: 0.9 }), edge({ memoryB: A, weight: 0.8, hashB: "hash-a" })],
      { maxDegree: 12 }
    );

    // One popular memory must not become a hub the whole graph routes through.
    expect(report.pruned.droppedDegree).toBe(1);
    expect(inserts[0].values).toHaveLength(1);
    expect(inserts[0].values[0]).toMatchObject({ sourceMemoryId: A, targetMemoryId: SEED });
  });

  it("stops at the per-brain ceiling and reports the shortfall", async () => {
    const { db, inserts } = fakeDb({ selectRows: [[{ count: 3_999 }]] });

    const report = await reconcileDerivedEdges(db, BRAIN, SEED, many(4), { maxEdges: 4_000 });

    expect(inserts[0].values).toHaveLength(1);
    expect(report.pruned.droppedGlobalCap).toBe(3);
  });

  it("writes nothing at all once the brain is full", async () => {
    const { db, inserts } = fakeDb({ selectRows: [[{ count: 4_000 }]] });

    const report = await reconcileDerivedEdges(db, BRAIN, SEED, many(2), { maxEdges: 4_000 });

    expect(inserts).toEqual([]);
    expect(report.pruned.droppedGlobalCap).toBe(2);
  });

  it("counts the brain's edges after the seed's own rows are gone", async () => {
    // Otherwise a recompute would count the rows it is about to replace against its
    // own budget, and a full brain could never re-score anything.
    const { db, deletes, selects, inserts } = emptyBrain({ deletedIds: ["old-1"] });

    await reconcileDerivedEdges(db, BRAIN, SEED, [edge()]);

    expect(deletes).toHaveLength(1);
    expect(selects).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });
});

describe("reconcileDerivedEdges — determinism and isolation", () => {
  it("produces the same rows however the scorer ordered its output", async () => {
    const edges = [
      edge({ memoryB: "mem-p", weight: 0.4 }),
      edge({ memoryB: "mem-q", weight: 0.7 }),
      edge({ memoryB: "mem-r", weight: 0.7 }),
    ];

    const forward = emptyBrain();
    await reconcileDerivedEdges(forward.db, BRAIN, SEED, edges, { neighbours: 2 });
    const reversed = emptyBrain();
    await reconcileDerivedEdges(reversed.db, BRAIN, SEED, [...edges].reverse(), { neighbours: 2 });

    // Equal weights are broken by neighbour id, so the survivors are stable.
    expect(reversed.inserts[0].values).toEqual(forward.inserts[0].values);
    expect(forward.inserts[0].values.map((row) => row.targetMemoryId)).toEqual([
      "mem-q",
      "mem-r",
    ]);
  });

  it("names the brain in every statement it issues", async () => {
    const { db, deletes, selects, executes, inserts } = emptyBrain({ deletedIds: ["old-1"] });

    await reconcileDerivedEdges(db, BRAIN, SEED, [edge()]);

    for (const call of [...deletes, ...selects]) {
      expect(describeSql(call.where)).toContain(BRAIN);
    }
    // The degree query is raw SQL; its brain filter is a bound parameter.
    expect(describeSql(executes[0])).toContain(BRAIN);
    expect(describeSql(executes[0])).not.toContain(OTHER_BRAIN);
    expect(inserts[0].values.every((row) => row.brainId === BRAIN)).toBe(true);
  });
});

describe("deleteDerivedEdgesFor", () => {
  it("removes every computed edge touching a memory, in this brain only", async () => {
    const { db, deletes } = fakeDb({ deletedIds: ["edge-1", "edge-2", "edge-3"] });

    const removed = await deleteDerivedEdgesFor(db, BRAIN, SEED);

    expect(removed).toBe(3);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].table).toBe(DERIVED_TABLE);
    const where = describeSql(deletes[0].where);
    expect(where).toContain("brain_id");
    expect(where).toContain(BRAIN);
    expect(where).not.toContain(OTHER_BRAIN);
    // Both directions: the pair is canonical, so the seed may be on either side.
    expect(where).toContain("source_memory_id");
    expect(where).toContain("target_memory_id");
  });

  it("takes every version's edges, not just this scorer's", async () => {
    // Soft delete is not a reconcile: the memory is gone, so no algorithm's claim
    // about it survives. This is the one place that must NOT filter on computedBy.
    const { db, deletes } = fakeDb({ deletedIds: [] });

    await deleteDerivedEdgesFor(db, BRAIN, SEED);

    expect(describeSql(deletes[0].where)).not.toContain("computed_by");
  });
});

describe("loadDerivedNeighbors", () => {
  function neighbourRow(other: string, weight: number, reverse = false) {
    return {
      id: `edge-${other}`,
      brainId: BRAIN,
      sourceMemoryId: reverse ? other : SEED,
      targetMemoryId: reverse ? SEED : other,
      origin: "derived",
      status: "applied",
      relation: "semantic",
      weight,
      confidence: 0.5,
      reason: "shared terms: deploy",
      evidence: { sharedTerms: ["deploy"], signalFamilyCount: 1 },
      computedBy: RELATE_VERSION,
    };
  }

  it("reports the other endpoint whichever side of the pair the seed is on", async () => {
    const { db } = fakeDb({
      selectRows: [[neighbourRow(B, 0.7)], [neighbourRow(A, 0.6, true)]],
    });

    const neighbours = await loadDerivedNeighbors(db, BRAIN, SEED);

    expect(neighbours.map((row) => row.neighborId)).toEqual([B, A]);
  });

  it("returns a memory once even if two rows point at it", async () => {
    const { db } = fakeDb({
      selectRows: [[neighbourRow(B, 0.7)], [neighbourRow(B, 0.3, true)]],
    });

    const neighbours = await loadDerivedNeighbors(db, BRAIN, SEED);

    // brain_related must never hand the same memory to an agent twice.
    expect(neighbours).toHaveLength(1);
    expect(neighbours[0].weight).toBe(0.7);
  });

  it("orders by strength, breaking ties on neighbour id", async () => {
    const { db } = fakeDb({
      selectRows: [
        [neighbourRow(B, 0.4), neighbourRow("mem-c", 0.8)],
        [neighbourRow(A, 0.4, true)],
      ],
    });

    const neighbours = await loadDerivedNeighbors(db, BRAIN, SEED);

    expect(neighbours.map((row) => row.neighborId)).toEqual(["mem-c", A, B]);
  });

  it("reads applied edges by default and suggested ones only when asked", async () => {
    const applied = fakeDb();
    await loadDerivedNeighbors(applied.db, BRAIN, SEED);
    expect(describeSql(applied.selects[0].where)).toContain("applied");

    const suggested = fakeDb();
    await loadDerivedNeighbors(suggested.db, BRAIN, SEED, { status: "suggested" });
    expect(describeSql(suggested.selects[0].where)).toContain("suggested");
  });

  it("bounds both reads and the merged result by the limit", async () => {
    const { db, selects } = fakeDb({
      selectRows: [[neighbourRow(B, 0.7), neighbourRow("mem-c", 0.6)], [neighbourRow(A, 0.5, true)]],
    });

    const neighbours = await loadDerivedNeighbors(db, BRAIN, SEED, { limit: 2 });

    expect(selects.map((call) => call.limit)).toEqual([2, 2]);
    expect(neighbours).toHaveLength(2);
  });

  it("scopes both directions to the brain", async () => {
    const { db, selects } = fakeDb();

    await loadDerivedNeighbors(db, BRAIN, SEED);

    expect(selects).toHaveLength(2);
    for (const call of selects) {
      expect(call.table).toBe(DERIVED_TABLE);
      expect(describeSql(call.where)).toContain(BRAIN);
      expect(describeSql(call.where)).not.toContain(OTHER_BRAIN);
    }
  });
});

describe("detectStaleEdges", () => {
  it("reports staleness when an endpoint's content has moved on", async () => {
    const { db, selects } = fakeDb({
      selectRows: [[{ contentHash: "hash-new" }], [{ count: 2 }]],
    });

    const result = await detectStaleEdges(db, BRAIN, SEED);

    expect(result.stale).toBe(true);
    expect(result.reason).toContain("2");
    // The comparison is per endpoint slot, which only works because reconcile swaps
    // the hashes along with the ids.
    const where = describeSql(selects[1].where);
    expect(where).toContain("source_hash_a");
    expect(where).toContain("source_hash_b");
  });

  it("reports fresh when every hash still matches", async () => {
    const { db } = fakeDb({ selectRows: [[{ contentHash: "hash-new" }], [{ count: 0 }]] });

    expect(await detectStaleEdges(db, BRAIN, SEED)).toEqual({
      stale: false,
      reason: undefined,
    });
  });

  it("does not ask about edges when the memory is not in this brain", async () => {
    const { db, selects } = fakeDb({ selectRows: [[]] });

    const result = await detectStaleEdges(db, OTHER_BRAIN, SEED);

    expect(result).toEqual({ stale: false, reason: "memory not found" });
    expect(selects).toHaveLength(1);
  });

  it("judges only the rows this scorer version owns", async () => {
    const { db, selects } = fakeDb({
      selectRows: [[{ contentHash: "hash-new" }], [{ count: 1 }]],
    });

    await detectStaleEdges(db, BRAIN, SEED);

    // A relate-v2 row with a different hash scheme is not v1's business.
    const where = describeSql(selects[1].where);
    expect(where).toContain("computed_by");
    expect(where).toContain(RELATE_VERSION);
    expect(where).toContain(BRAIN);
    expect(describeSql(selects[0].where)).toContain(BRAIN);
  });
});

describe("toDerivedEdgeInputs — the scorer-to-storage policy", () => {
  /** A scored pair as `relateOne` hands it over. */
  const scored = (familyCount: number, weight = 0.5) => ({
    memoryA: SEED,
    memoryB: B,
    relation: "semantic" as const,
    weight,
    reason: "shared terms: deploy, hetzner",
    evidence: {
      signals: { semantic: { similarity: 0.3, sharedTerms: ["deploy", "hetzner"] } },
      signalFamilyCount: familyCount,
    },
  });

  const HASHES = new Map([
    [SEED, "hash-seed"],
    [B, "hash-b"],
  ]);

  it("calls one family a guess and two an inference", () => {
    const [derived] = toDerivedEdgeInputs([scored(1)], HASHES);
    const [inferred] = toDerivedEdgeInputs([scored(2)], HASHES);

    expect(derived.origin).toBe("derived");
    expect(inferred.origin).toBe("inferred");
    // PRINSIP 11: the pairs are equally similar. Only the agreement differs, and only
    // confidence moves — which is the whole reason the two numbers are separate.
    expect(inferred.weight).toBe(derived.weight);
    expect(inferred.confidence).toBeGreaterThan(derived.confidence);
    expect(derived.confidence).toBeLessThan(RELATE_POLICY.CONF_APPLY_MIN);
    expect(inferred.confidence).toBeGreaterThanOrEqual(RELATE_POLICY.CONF_APPLY_MIN);
  });

  it("caps what a strong single signal can buy", () => {
    const [weak] = toDerivedEdgeInputs([scored(1, 0.25)], HASHES);
    const [strong] = toDerivedEdgeInputs([scored(1, 1)], HASHES);

    // A lone family gets at most 0.03 out of evidence strength, so however similar the
    // text is it cannot reach the apply threshold on its own.
    expect(strong.confidence - weak.confidence).toBeLessThanOrEqual(0.03);
    expect(strong.confidence).toBeLessThan(RELATE_POLICY.CONF_APPLY_MIN);
  });

  it("attaches each memory's own hash, and stores empty for one it was not given", () => {
    const [both] = toDerivedEdgeInputs([scored(1)], HASHES);
    expect(both).toMatchObject({ hashA: "hash-seed", hashB: "hash-b" });

    const [half] = toDerivedEdgeInputs([scored(1)], new Map([[SEED, "hash-seed"]]));
    // Empty rather than invented: `detectStaleEdges` then treats the edge as needing a
    // recompute, which is the safe reading of "we do not know what this was scored on".
    expect(half.hashB).toBe("");
  });

  it("cannot drop anything at today's thresholds, and says so", () => {
    // CONF_BASE_DERIVED is above CONF_SUGGEST_MIN, so the floor is unreachable from
    // this function: every scored pair is stored, as a suggestion at worst. The filter
    // stays because it is the policy, and this test fails the day a lower base or a
    // weaker scorer makes it bite.
    expect(RELATE_POLICY.CONF_BASE_DERIVED).toBeGreaterThanOrEqual(
      RELATE_POLICY.CONF_SUGGEST_MIN
    );
    expect(toDerivedEdgeInputs([scored(1, 0), scored(1, 1)], HASHES)).toHaveLength(2);
  });
});
