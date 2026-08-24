import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";

/**
 * `brain_related` (P4 + PHASE 2). The seed's relatives come from five independent
 * readings of the brain — asserted links, derived edges, transitive graph paths,
 * lexical relevance and shared entities — and the value of the tool is entirely in how
 * they are merged: an asserted link must outrank a computed guess, a computed guess
 * must outrank "merely answers the same query", every result must say where it came
 * from, and nothing may be reported that this brain cannot see.
 *
 * Retrieval is mocked because it is exercised in depth by its own suite; what matters
 * here is that its verdict is combined honestly.
 */

const retrieveMemories = vi.fn();

vi.mock("../retrieval/retrieve", () => ({
  retrieveMemories: (...args: unknown[]) => retrieveMemories(...args),
}));

const { findRelatedMemories } = await import("./related-service");

type SelectCall = { table: string; columns: string[]; limit: number | null; where: unknown; orderBy: unknown[] };

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

const MEMORY_TABLE = getTableName(schema.memories);
const LINK_TABLE = getTableName(schema.memoryLinks);
const DERIVED_TABLE = getTableName(schema.memoryDerivedLinks);

const BRAIN = "brain-1";
const SEED = "mem-0-seed";
const NEAR = "mem-1-near";
const INFER = "mem-2-inferred";
const DERIV = "mem-3-derived";
const FAR = "mem-4-far";
const LEXICAL = "mem-5-lexical";

/**
 * Rows are queued per table in call order, so a fixture describes the brain the way
 * the service will read it: seed, then one row-set per BFS hop over `memory_links`,
 * then the derived edges, then the hydration pass. A missing entry reads as an empty
 * table rather than throwing — that is the "this brain cannot see it" case.
 */
type Queues = Record<string, unknown[][]>;

function recordingDb(queues: Queues) {
  const calls: SelectCall[] = [];
  const cursors: Record<string, number> = {};

  const nextRows = (table: string): unknown[] => {
    const index = cursors[table] ?? 0;
    cursors[table] = index + 1;
    return queues[table]?.[index] ?? [];
  };

  const select = (projection?: Record<string, unknown>) => {
    const call: SelectCall = {
      table: "",
      columns: projection ? Object.keys(projection) : [],
      limit: null,
      where: null,
      orderBy: [],
    };
    const builder: Record<string, unknown> = {
      from(table: unknown) {
        call.table = getTableName(table as Parameters<typeof getTableName>[0]);
        return builder;
      },
      where(condition: unknown) {
        call.where = condition;
        return builder;
      },
      orderBy(...clauses: unknown[]) {
        call.orderBy = clauses;
        return builder;
      },
      limit(value: number) {
        call.limit = value;
        return builder;
      },
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) {
        calls.push(call);
        return Promise.resolve(nextRows(call.table)).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return {
    db: { select } as unknown as PostgresJsDatabase<typeof schema>,
    calls,
    callsFor: (table: string) => calls.filter((call) => call.table === table),
  };
}

const seedRow = {
  id: SEED,
  title: "Deploy target",
  summary: "Production runs on Fly.io",
  projectId: null as string | null,
};

/** A `memory_links` row as the BFS reads it: both endpoints, undirected. */
function link(source: string, target: string, linkType = "related_to") {
  return { sourceMemoryId: source, targetMemoryId: target, linkType };
}

/** A `memory_derived_links` row as the scorer wrote it. */
function derived(
  other: string,
  overrides: Partial<{
    origin: "derived" | "inferred";
    status: "applied" | "suggested";
    relation: string;
    weight: number;
    confidence: number;
    reason: string;
    evidence: Record<string, unknown> | null;
    computedBy: string;
    reverse: boolean;
  }> = {}
) {
  const { reverse, ...rest } = overrides;
  return {
    id: `edge-${other}`,
    brainId: BRAIN,
    sourceMemoryId: reverse ? other : SEED,
    targetMemoryId: reverse ? SEED : other,
    origin: "derived" as const,
    status: "applied" as const,
    relation: "semantic",
    weight: 0.5,
    confidence: 0.5,
    reason: "shared terms: deploy, production",
    evidence: { sharedTerms: ["deploy", "production"], signalFamilyCount: 1 },
    computedBy: "relate-v1",
    ...rest,
  };
}

/** A hydration row: what the memory actually is, once it resolves in this brain. */
function memoryRow(id: string, projectId: string | null = null) {
  return { id, title: `Title ${id}`, type: "fact", projectId };
}

function noRetrieval() {
  retrieveMemories.mockResolvedValue({ results: [], total: 0 });
}

function retrieval(
  rows: Array<{ id: string; score: number; legs?: string[] }>
) {
  retrieveMemories.mockResolvedValue({
    results: rows.map((row) => ({
      id: row.id,
      score: { score: row.score },
      legs: row.legs ?? ["lexical"],
    })),
    total: rows.length,
  });
}

beforeEach(() => {
  retrieveMemories.mockReset();
  noRetrieval();
});

describe("findRelatedMemories — brain isolation", () => {
  it("returns nothing, and reads nothing further, for a seed in another brain", async () => {
    const { db, calls } = recordingDb({ [MEMORY_TABLE]: [[]] });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    expect(results).toEqual([]);
    // The seed lookup is the tenant check: if it misses, no link, derived or
    // retrieval read may happen at all.
    expect(calls).toHaveLength(1);
    expect(retrieveMemories).not.toHaveBeenCalled();
  });

  it("scopes every read to the brain and excludes soft-deleted rows", async () => {
    const { db, calls } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(NEAR)]],
      [LINK_TABLE]: [[link(SEED, NEAR, "supersedes")], []],
      [DERIVED_TABLE]: [[derived(DERIV)]],
    });

    await findRelatedMemories(db, BRAIN, SEED);

    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      expect(describeSql(call.where)).toContain("brain_id");
    }
    for (const call of calls.filter((c) => c.table === MEMORY_TABLE)) {
      expect(describeSql(call.where)).toContain("deleted_at");
    }
  });
});

describe("findRelatedMemories — trust ordering", () => {
  function fiveTierBrain() {
    retrieval([{ id: LEXICAL, score: 0.9, legs: ["lexical", "entity"] }]);
    return recordingDb({
      [MEMORY_TABLE]: [
        [seedRow],
        [memoryRow(NEAR), memoryRow(INFER), memoryRow(DERIV), memoryRow(FAR), memoryRow(LEXICAL)],
      ],
      [LINK_TABLE]: [[link(SEED, NEAR, "supersedes")], [link(NEAR, FAR, "related_to")]],
      [DERIVED_TABLE]: [
        [derived(INFER, { origin: "inferred", weight: 0.8, confidence: 0.85 })],
      ],
    });
  }

  it("ranks asserted links above inferred, derived, transitive and same-query results", async () => {
    retrieval([{ id: LEXICAL, score: 0.9, legs: ["lexical", "entity"] }]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [seedRow],
        [memoryRow(NEAR), memoryRow(INFER), memoryRow(DERIV), memoryRow(FAR), memoryRow(LEXICAL)],
      ],
      [LINK_TABLE]: [[link(SEED, NEAR, "supersedes")], [link(NEAR, FAR, "related_to")]],
      [DERIVED_TABLE]: [
        [
          derived(INFER, { origin: "inferred", weight: 0.8, confidence: 0.85 }),
          derived(DERIV, { weight: 0.5, confidence: 0.45 }),
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    expect(results.map((r) => [r.id, r.origin])).toEqual([
      [NEAR, "explicit"],
      [INFER, "inferred"],
      [DERIV, "derived"],
      [FAR, "graph"],
      [LEXICAL, "retrieval"],
    ]);
    // Disjoint bands: sorting by score reproduces the trust order on its own.
    expect(results[0].score).toBe(1);
    expect(results[1].score).toBeCloseTo(0.76, 5);
    expect(results[2].score).toBeCloseTo(0.54, 5);
    expect(results[3].score).toBeCloseTo(0.3, 5);
    expect(results[4].score).toBeCloseTo(0.252, 5);
    expect(results.filter((r) => r.explicit).map((r) => r.id)).toEqual([NEAR]);
  });

  it("marks a direct link explicit and a two-hop path merely graph-proximate", async () => {
    const { db } = fiveTierBrain();

    const results = await findRelatedMemories(db, BRAIN, SEED);
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get(NEAR)).toMatchObject({
      origin: "explicit",
      explicit: true,
      reason: "direct_link",
      linkType: "supersedes",
      hops: 1,
    });
    expect(byId.get(FAR)).toMatchObject({
      origin: "graph",
      explicit: false,
      reason: "graph_proximity_2_hops",
      hops: 2,
    });
  });
});

describe("findRelatedMemories — deterministic fetch ordering", () => {
  // Both reads that feed the merge are capped — the derived fetch at DERIVED_FETCH_MAX,
  // each BFS hop at GRAPH_FRONTIER_MAX. A cap with no total ordering drops an arbitrary
  // subset at ties, so "same brain → same answer" quietly breaks. These pin the ORDER BY
  // that makes the truncation stable. (The recording db's orderBy is captured, not
  // executed, so this asserts the SQL a real Postgres would truncate by, not row output.)
  it("orders the derived-edge fetch by trust then a unique id, mirroring the in-memory sort", async () => {
    const { db, callsFor } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV)]],
      [DERIVED_TABLE]: [[derived(DERIV)]],
    });

    await findRelatedMemories(db, BRAIN, SEED);

    const cols = describeSql(callsFor(DERIVED_TABLE)[0].orderBy)
      .split(/\s+/)
      .filter((token) => ["origin", "status", "weight", "id"].includes(token));
    // inferred first, then applied, then strongest weight, then id to break the tie —
    // exactly the keys trustRank sorts by, so the 60 the cap keeps are the 60 shown.
    expect(cols).toEqual(["origin", "status", "weight", "id"]);
  });

  it("orders the explicit-link frontier by a unique key so each bounded hop is stable", async () => {
    const { db, callsFor } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(NEAR)]],
      [LINK_TABLE]: [[link(SEED, NEAR)], []],
    });

    await findRelatedMemories(db, BRAIN, SEED);

    const cols = describeSql(callsFor(LINK_TABLE)[0].orderBy)
      .split(/\s+/)
      .filter((token) => ["created_at", "id"].includes(token));
    expect(cols).toEqual(["created_at", "id"]);
  });
});

describe("findRelatedMemories — derived provenance", () => {
  it("passes the scorer's evidence through untouched so the guess can be audited", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV)]],
      [DERIVED_TABLE]: [
        [
          derived(DERIV, {
            relation: "entity",
            weight: 0.64,
            confidence: 0.42,
            reason: "shared entity: Fly.io",
            evidence: { sharedEntities: ["Fly.io"], signalFamilyCount: 1 },
          }),
        ],
      ],
    });

    const [result] = await findRelatedMemories(db, BRAIN, SEED);

    expect(result).toMatchObject({
      id: DERIV,
      origin: "derived",
      explicit: false,
      weight: 0.64,
      confidence: 0.42,
      reason: "shared entity: Fly.io",
      computedBy: "relate-v1",
      evidence: { sharedEntities: ["Fly.io"], signalFamilyCount: 1 },
    });
  });

  it("resolves the neighbour whichever end of the derived edge the seed sits on", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV)]],
      [DERIVED_TABLE]: [[derived(DERIV, { reverse: true })]],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    expect(results.map((r) => r.id)).toEqual([DERIV]);
  });

  it("reads suggested edges by default and drops them only when asked", async () => {
    const byDefault = recordingDb({
      [MEMORY_TABLE]: [[seedRow], []],
      [DERIVED_TABLE]: [[]],
    });
    await findRelatedMemories(byDefault.db, BRAIN, SEED);
    const defaultWhere = describeSql(byDefault.callsFor(DERIVED_TABLE)[0].where);
    // A lone signal family can never clear CONF_APPLY_MIN, so reading only `applied`
    // would hide the commonest derived edge there is.
    expect(defaultWhere).toContain("applied");
    expect(defaultWhere).toContain("suggested");

    const strict = recordingDb({
      [MEMORY_TABLE]: [[seedRow], []],
      [DERIVED_TABLE]: [[]],
    });
    await findRelatedMemories(strict.db, BRAIN, SEED, 20, 2, true);
    const strictWhere = describeSql(strict.callsFor(DERIVED_TABLE)[0].where);
    expect(strictWhere).toContain("applied");
    expect(strictWhere).not.toContain("suggested");
  });

  it("labels a suggestion and ranks it below every applied edge", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV), memoryRow(FAR)]],
      [DERIVED_TABLE]: [
        [
          // The strongest possible suggestion against the weakest applied edge: the
          // sub-bands have to hold even at their boundaries.
          derived(DERIV, { status: "suggested", weight: 1, confidence: 0.46 }),
          derived(FAR, { status: "applied", weight: 0, confidence: 0.56 }),
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    expect(results.map((r) => [r.id, r.origin, r.status])).toEqual([
      [FAR, "derived", "applied"],
      [DERIV, "derived", "suggested"],
    ]);
    expect(results[0].score).toBeCloseTo(0.5, 5);
    expect(results[1].score).toBeCloseTo(0.45, 5);
    // Same tier, different trust: an agent filtering on status must still see both
    // the confidence and the evidence that produced the suggestion.
    expect(results[1]).toMatchObject({
      explicit: false,
      confidence: 0.46,
      weight: 1,
      computedBy: "relate-v1",
      evidence: { sharedTerms: ["deploy", "production"], signalFamilyCount: 1 },
    });
  });

  it("keeps a suggestion under the applied band even when weaker tiers agree", async () => {
    retrieval([{ id: DERIV, score: 1, legs: ["lexical", "entity"] }]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV), memoryRow(FAR)]],
      [DERIVED_TABLE]: [
        [
          derived(DERIV, { status: "suggested", weight: 1, confidence: 0.46 }),
          derived(FAR, { status: "applied", weight: 0, confidence: 0.56 }),
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    // 0.45 + an agreement boost is still below the applied floor of 0.50, so the gap
    // between the sub-bands is doing its job.
    const suggestion = results.find((r) => r.id === DERIV);
    expect(suggestion?.status).toBe("suggested");
    expect(suggestion?.score).toBeCloseTo(0.48, 5);
    expect(results.map((r) => r.id)).toEqual([FAR, DERIV]);
  });

  it("lets an inferred edge outrank an applied one, and both outrank a suggestion", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(INFER), memoryRow(DERIV), memoryRow(FAR)]],
      [DERIVED_TABLE]: [
        [
          derived(DERIV, { status: "suggested", weight: 0.9 }),
          derived(INFER, { origin: "inferred", weight: 0.1, confidence: 0.78 }),
          derived(FAR, { status: "applied", weight: 0.4 }),
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    expect(results.map((r) => r.id)).toEqual([INFER, FAR, DERIV]);
    expect(results.map((r) => r.origin)).toEqual(["inferred", "derived", "derived"]);
  });
});

describe("findRelatedMemories — merging tiers", () => {
  it("keeps the strongest tier when several agree, and records the agreement", async () => {
    retrieval([
      { id: NEAR, score: 1, legs: ["lexical"] },
      { id: DERIV, score: 1, legs: ["entity"] },
    ]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(NEAR), memoryRow(DERIV)]],
      [LINK_TABLE]: [[link(SEED, NEAR, "supersedes")], []],
      [DERIVED_TABLE]: [[derived(DERIV, { weight: 0.5 })]],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);
    const byId = new Map(results.map((r) => [r.id, r]));

    // A tier already claimed is never relabelled, and the boost cannot lift a result
    // out of its band: explicit stays capped at 1, derived stays under 0.6.
    expect(byId.get(NEAR)).toMatchObject({
      origin: "explicit",
      explicit: true,
      score: 1,
      reason: "direct_link, also lexical_match",
    });
    expect(byId.get(DERIV)?.origin).toBe("derived");
    expect(byId.get(DERIV)?.score).toBeCloseTo(0.57, 5);
    expect(byId.get(DERIV)?.reason).toContain("also shared_entity");
    // One row per memory, no matter how many tiers found it.
    expect(results).toHaveLength(2);
  });

  it("never reports the seed as its own relative", async () => {
    retrieval([{ id: SEED, score: 1 }, { id: LEXICAL, score: 0.5 }]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(LEXICAL)]],
      [LINK_TABLE]: [[link(SEED, SEED, "related_to")], []],
      [DERIVED_TABLE]: [[derived(SEED)]],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    expect(results.map((r) => r.id)).toEqual([LEXICAL]);
  });

  it("drops candidates that no longer resolve inside this brain", async () => {
    retrieval([{ id: LEXICAL, score: 0.9 }]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(NEAR)]],
      [LINK_TABLE]: [[link(SEED, NEAR)], []],
      [DERIVED_TABLE]: [[derived(DERIV)]],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);

    // DERIV and LEXICAL were candidates but hydration found no row for them: a
    // cross-brain or soft-deleted id must not be reported, not even as a bare id.
    expect(results.map((r) => r.id)).toEqual([NEAR]);
  });
});

describe("findRelatedMemories — retrieval fallback", () => {
  it("queries title plus summary and does not hard-filter by project", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[{ ...seedRow, projectId: "project-1" }], []],
      [DERIVED_TABLE]: [[]],
    });

    await findRelatedMemories(db, BRAIN, SEED);

    // PRINSIP 14: the project is a boost, not a gate — a hard filter would reduce
    // "related" to "filed in the same folder".
    expect(retrieveMemories).toHaveBeenCalledTimes(1);
    const params = retrieveMemories.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toEqual({
      brainId: BRAIN,
      query: "Deploy target Production runs on Fly.io",
      limit: 40,
      includeArchived: false,
    });
    expect(params).not.toHaveProperty("projectId");
  });

  it("nudges same-project results without promoting them past a stronger tier", async () => {
    retrieval([{ id: LEXICAL, score: 0.9 }]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [{ ...seedRow, projectId: "project-1" }],
        [memoryRow(NEAR), memoryRow(FAR), memoryRow(LEXICAL, "project-1")],
      ],
      [LINK_TABLE]: [[link(SEED, NEAR)], [link(NEAR, FAR)]],
      [DERIVED_TABLE]: [[]],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get(LEXICAL)?.score).toBeCloseTo(0.272, 5);
    expect(byId.get(LEXICAL)?.reason).toBe("lexical_match, same_project");
    // 0.272 + a same-project nudge still loses to a 2-hop explicit path at 0.30.
    expect(results.map((r) => r.id)).toEqual([NEAR, FAR, LEXICAL]);
  });
});

describe("findRelatedMemories — bounds and determinism", () => {
  it("stops the graph walk at maxHops", async () => {
    const oneHop = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(NEAR), memoryRow(FAR)]],
      [LINK_TABLE]: [[link(SEED, NEAR)], [link(NEAR, FAR)]],
      [DERIVED_TABLE]: [[]],
    });

    const results = await findRelatedMemories(oneHop.db, BRAIN, SEED, 20, 1);

    expect(oneHop.callsFor(LINK_TABLE)).toHaveLength(1);
    expect(results.map((r) => r.id)).toEqual([NEAR]);
  });

  it("bounds every unbounded read: frontier, derived fan-out and retrieval", async () => {
    const { db, callsFor } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], []],
      [LINK_TABLE]: [[link(SEED, NEAR)], []],
      [DERIVED_TABLE]: [[]],
    });

    await findRelatedMemories(db, BRAIN, SEED);

    for (const call of callsFor(LINK_TABLE)) expect(call.limit).toBe(500);
    expect(callsFor(DERIVED_TABLE)[0].limit).toBe(60);
  });

  it("caps the result count and breaks score ties by id, not by probe order", async () => {
    retrieval([
      { id: LEXICAL, score: 0.5 },
      { id: DERIV, score: 0.5 },
    ]);
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV), memoryRow(LEXICAL)]],
      [DERIVED_TABLE]: [[]],
    });

    const tied = await findRelatedMemories(db, BRAIN, SEED);
    expect(tied.map((r) => r.id)).toEqual([DERIV, LEXICAL]);

    retrieval([
      { id: LEXICAL, score: 0.5 },
      { id: DERIV, score: 0.5 },
    ]);
    const capped = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [memoryRow(DERIV), memoryRow(LEXICAL)]],
      [DERIVED_TABLE]: [[]],
    });
    const limited = await findRelatedMemories(capped.db, BRAIN, SEED, 1);
    expect(limited.map((r) => r.id)).toEqual([DERIV]);
  });
});
