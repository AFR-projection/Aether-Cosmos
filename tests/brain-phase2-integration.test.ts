import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { relateOne, type RelateMemory } from "@brain/domain/graph/relate";
import {
  RELATE_POLICY,
  RELATE_VERSION,
  canonicalizePair,
  reconcileDerivedEdges,
  toDerivedEdgeInputs,
  type DerivedEdgeInput,
} from "@brain/application/commands/derived-link-service";

/**
 * PHASE 2, end to end: the scenario the spec makes mandatory.
 *
 *   A "Pengguna lebih suka komunikasi dalam Bahasa Indonesia."
 *   B "User meminta jawaban menggunakan Bahasa Indonesia dan gaya santai."
 *   C "Server menggunakan PostgreSQL."
 *
 * With nobody having linked anything, `brain_related(A)` must find B as *derived* —
 * a computed guess, never an assertion — and C must not ride up on the handful of
 * common words it shares.
 *
 * The chain under test is the real one: `relateOne` scores, `toDerivedEdgeInputs`
 * applies the storage policy, and `findRelatedMemories` reads the rows back. Only the
 * two ends are faked — the candidate SQL that feeds the scorer, and the driver that
 * returns the rows — because the suite has no DATABASE_URL. Everything between them,
 * including every threshold that decides whether B is visible at all, is production
 * code.
 */

const retrieveMemories = vi.fn();

vi.mock("@brain/application/queries/retrieve", () => ({
  retrieveMemories: (...args: unknown[]) => retrieveMemories(...args),
}));

const { findRelatedMemories } = await import("@brain/application/queries/related-service");

const MEMORY_TABLE = getTableName(schema.memories);
const LINK_TABLE = getTableName(schema.memoryLinks);
const DERIVED_TABLE = getTableName(schema.memoryDerivedLinks);

const BRAIN = "brain-integration";
const A = "mem-a-prefers-indonesian";
const B = "mem-b-asks-indonesian-casual";
const C = "mem-c-postgres";

function memory(overrides: Partial<RelateMemory> & { id: string }): RelateMemory {
  return {
    title: "",
    content: "",
    tags: [],
    projectId: null,
    entityIds: [],
    ...overrides,
  };
}

/**
 * The three spec memories, plus enough of a brain around them to make TF-IDF mean
 * something.
 *
 * The corpus is not padding. A term is distinctive only when its document frequency
 * sits in `2 .. max(2, floor(total / 2))`, so what "bahasa" is worth depends entirely
 * on how many other memories use it: in this brain, where nine other memories talk
 * about deployment and queues, it is informative. Both the three-memory case and the
 * twelve-memory case are exercised below, because the answer differs — lexical
 * similarity is a statement about a vocabulary, not about a pair.
 */
const SPEC_A = memory({
  id: A,
  title: "Preferensi bahasa pengguna",
  content: "Pengguna lebih suka komunikasi dalam Bahasa Indonesia.",
});
const SPEC_B = memory({
  id: B,
  // Titles are the test's own, and this one echoes its content the way a real title
  // does. It matters: the title is weighted, so a title that says nothing about its
  // memory costs the pair most of its lexical similarity.
  title: "Permintaan bahasa dan gaya jawaban",
  content: "User meminta jawaban menggunakan Bahasa Indonesia dan gaya santai.",
});
const SPEC_C = memory({
  id: C,
  title: "Database server",
  content: "Server menggunakan PostgreSQL.",
});

const FILLER: RelateMemory[] = [
  memory({
    id: "mem-d",
    title: "Deployment target",
    content: "Aplikasi produksi berjalan di Fly.io dengan dua region.",
  }),
  memory({
    id: "mem-e",
    title: "Backup schedule",
    content: "Snapshot database dijalankan setiap malam pukul dua.",
  }),
  memory({
    id: "mem-f",
    title: "Queue worker",
    content: "Worker BullMQ memproses job enrichment secara berurutan.",
  }),
  memory({
    id: "mem-g",
    title: "Rate limit",
    content: "Endpoint upload dibatasi sepuluh permintaan per menit.",
  }),
  memory({
    id: "mem-h",
    title: "Session secret",
    content: "Mengubah SESSION_SECRET membatalkan semua sesi yang tersimpan.",
  }),
  memory({
    id: "mem-i",
    title: "Storage driver",
    content: "Berkas besar disimpan pada object storage, bukan pada disk lokal.",
  }),
  memory({
    id: "mem-j",
    title: "Email sender",
    content: "Notifikasi dikirim melalui SMTP Gmail dengan App Password.",
  }),
  memory({
    id: "mem-k",
    title: "Search index",
    content: "Pencarian memakai PostgreSQL full text search, tanpa layanan luar.",
  }),
  memory({
    id: "mem-l",
    title: "Audit log",
    content: "Setiap tindakan agen dicatat pada tabel audit beserta waktunya.",
  }),
];

/** Every memory in the brain except the seed — what the candidate probes would find. */
const candidatesFor = (seed: RelateMemory, extra: RelateMemory[] = []): RelateMemory[] =>
  [SPEC_A, SPEC_B, SPEC_C, ...FILLER, ...extra].filter((m) => m.id !== seed.id);

/** contentHash stand-in: the scorer only ever stores it, never interprets it. */
const hashesFor = (memories: RelateMemory[]): Map<string, string> =>
  new Map(memories.map((m) => [m.id, `hash-${m.id}`]));

/**
 * The scoring half of the pipeline, exactly as `runRelateMemory` runs it.
 * Returns the rows that would reach `reconcileDerivedEdges`.
 */
function scoreSeed(seed: RelateMemory, extra: RelateMemory[] = []): DerivedEdgeInput[] {
  const candidates = candidatesFor(seed, extra);
  return toDerivedEdgeInputs(relateOne(seed, candidates), hashesFor([seed, ...candidates]));
}

/** The status `reconcileDerivedEdges` would store for a given confidence. */
const statusFor = (confidence: number): "applied" | "suggested" =>
  confidence >= RELATE_POLICY.CONF_APPLY_MIN ? "applied" : "suggested";

/** A stored `memory_derived_links` row, as the database would hand it back. */
function storedRow(edge: DerivedEdgeInput) {
  const [source, target] = canonicalizePair(edge.memoryA, edge.memoryB);
  const swapped = source !== edge.memoryA;
  return {
    id: `edge-${source}-${target}`,
    brainId: BRAIN,
    sourceMemoryId: source,
    targetMemoryId: target,
    origin: edge.origin,
    status: statusFor(edge.confidence),
    relation: edge.relation,
    weight: edge.weight,
    confidence: edge.confidence,
    reason: edge.reason,
    evidence: edge.evidence,
    computedBy: RELATE_VERSION,
    sourceHashA: swapped ? edge.hashB : edge.hashA,
    sourceHashB: swapped ? edge.hashA : edge.hashB,
  };
}

const edgeBetween = (edges: DerivedEdgeInput[], x: string, y: string) =>
  edges.find(
    (e) => (e.memoryA === x && e.memoryB === y) || (e.memoryA === y && e.memoryB === x)
  );

/** Rows queued per table in call order; a missing entry reads as an empty table. */
function recordingDb(queues: Record<string, unknown[][]>) {
  const cursors: Record<string, number> = {};
  const select = () => {
    let table = "";
    const builder: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as Parameters<typeof getTableName>[0]);
        return builder;
      },
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      then(onFulfilled: (rows: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) {
        const index = cursors[table] ?? 0;
        cursors[table] = index + 1;
        return Promise.resolve(queues[table]?.[index] ?? []).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };
  return { select } as unknown as PostgresJsDatabase<typeof schema>;
}

/** Titles/types for the hydration pass, for whichever ids a case can return. */
const hydration = (ids: string[]) =>
  ids.map((id) => ({ id, title: `Title ${id}`, type: "fact", projectId: null }));

beforeEach(() => {
  retrieveMemories.mockReset();
  retrieveMemories.mockResolvedValue({ results: [], total: 0 });
});

describe("the mandatory scenario — A and B relate, and nobody said so", () => {
  it("scores A–B as a single-family derived edge and leaves A–C unscored", () => {
    const edges = scoreSeed(SPEC_A);
    const ab = edgeBetween(edges, A, B);

    expect(ab).toBeDefined();
    expect(ab).toMatchObject({ origin: "derived", relation: "semantic" });
    expect(ab!.evidence.signalFamilyCount).toBe(1);
    // The words they share are the point, and they are recorded: an agent can audit
    // the guess without being handed either memory's text (PRINSIP 12).
    const signals = (ab!.evidence as { signals: { semantic?: { sharedTerms: string[] } } })
      .signals;
    expect(signals.semantic?.sharedTerms).toContain("bahasa");
    expect(signals.semantic?.sharedTerms).toContain("indonesia");

    // C shares only "menggunakan" with B and nothing distinctive with A.
    expect(edgeBetween(edges, A, C)).toBeUndefined();
  });

  it("stores that edge as a suggestion, because one family cannot clear the bar", () => {
    const ab = edgeBetween(scoreSeed(SPEC_A), A, B)!;

    expect(ab.confidence).toBeGreaterThanOrEqual(RELATE_POLICY.CONF_SUGGEST_MIN);
    expect(ab.confidence).toBeLessThan(RELATE_POLICY.CONF_APPLY_MIN);
    expect(statusFor(ab.confidence)).toBe("suggested");
  });

  it("returns B from brain_related(A) as derived, and does not return C at all", async () => {
    const edges = scoreSeed(SPEC_A);
    const db = recordingDb({
      [MEMORY_TABLE]: [
        [{ id: A, title: SPEC_A.title, summary: SPEC_A.content, projectId: null }],
        hydration(edges.map((e) => (e.memoryA === A ? e.memoryB : e.memoryA))),
      ],
      [LINK_TABLE]: [[], []],
      [DERIVED_TABLE]: [edges.map(storedRow)],
    });

    const results = await findRelatedMemories(db, BRAIN, A);
    const b = results.find((r) => r.id === B);

    // The requirement, in one assertion: found, and found as a guess.
    expect(b).toBeDefined();
    expect(b).toMatchObject({
      origin: "derived",
      explicit: false,
      status: "suggested",
      computedBy: RELATE_VERSION,
    });
    expect(b!.score).toBeLessThan(1);
    expect(b!.confidence).toBeLessThan(RELATE_POLICY.CONF_APPLY_MIN);
    expect(b!.evidence).toBeDefined();

    expect(results.map((r) => r.id)).not.toContain(C);
  });

  it("finds the same edge in a brain that holds only the three spec memories", () => {
    // No corpus to speak of: with three documents a term is distinctive at df 2, so
    // "bahasa" and "indonesia" still carry information and the edge survives. Weaker
    // than in the fuller brain (0.267 against 0.348) and still only a suggestion.
    const tiny = toDerivedEdgeInputs(
      relateOne(SPEC_A, [SPEC_B, SPEC_C]),
      hashesFor([SPEC_A, SPEC_B, SPEC_C])
    );
    const ab = edgeBetween(tiny, A, B);

    expect(ab).toMatchObject({ origin: "derived", relation: "semantic" });
    expect(statusFor(ab!.confidence)).toBe("suggested");
    expect(edgeBetween(tiny, A, C)).toBeUndefined();
    expect(ab!.weight).toBeLessThan(edgeBetween(scoreSeed(SPEC_A), A, B)!.weight);
  });

  it("is close enough to the gate that a title carrying no content loses the edge", () => {
    // Not a defect to fix here, a limit to know: lexical similarity on two short
    // sentences sits near SEMANTIC_MIN, and the title is weighted. Give B a title that
    // shares nothing with its own content and the pair drops under the gate entirely.
    const untitled = memory({ ...SPEC_B, title: "Permintaan gaya jawaban" });
    const edges = toDerivedEdgeInputs(
      relateOne(SPEC_A, [untitled, SPEC_C, ...FILLER]),
      hashesFor([SPEC_A, untitled, SPEC_C, ...FILLER])
    );

    expect(edgeBetween(edges, A, B)).toBeUndefined();
  });
});

describe("agreement is what promotes a guess", () => {
  /** A and B, both filed under one rare tag. */
  const tagged = (id: string, base: RelateMemory) =>
    memory({ ...base, id, tags: ["preferensi-bahasa"] });

  it("a second signal family makes the same pair inferred and applied", () => {
    const a = tagged(A, SPEC_A);
    const b = tagged(B, SPEC_B);
    const edges = toDerivedEdgeInputs(
      relateOne(a, [b, SPEC_C, ...FILLER]),
      hashesFor([a, b, SPEC_C, ...FILLER])
    );
    const ab = edgeBetween(edges, A, B)!;

    expect(ab.evidence.signalFamilyCount).toBe(2);
    expect(ab.origin).toBe("inferred");
    expect(ab.confidence).toBeGreaterThanOrEqual(RELATE_POLICY.CONF_APPLY_MIN);
    expect(statusFor(ab.confidence)).toBe("applied");
    // Confidence rose because two independent families agreed, not because the text
    // got more similar — PRINSIP 11, weight and confidence are different quantities.
    expect(ab.weight).toBeGreaterThan(edgeBetween(scoreSeed(SPEC_A), A, B)!.weight);
  });

  it("ranks an applied inferred edge above the suggestion it replaces", async () => {
    const a = tagged(A, SPEC_A);
    const b = tagged(B, SPEC_B);
    const inferredEdges = toDerivedEdgeInputs(
      relateOne(a, [b, SPEC_C, ...FILLER]),
      hashesFor([a, b, SPEC_C, ...FILLER])
    );
    const suggestion = edgeBetween(scoreSeed(SPEC_A), A, B)!;
    const other = FILLER[0].id;

    const db = recordingDb({
      [MEMORY_TABLE]: [
        [{ id: A, title: SPEC_A.title, summary: SPEC_A.content, projectId: null }],
        hydration([B, other]),
      ],
      [LINK_TABLE]: [[], []],
      [DERIVED_TABLE]: [
        [
          storedRow(edgeBetween(inferredEdges, A, B)!),
          // The same seed's weaker neighbour, still only a suggestion.
          storedRow({ ...suggestion, memoryB: other }),
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, A);

    expect(results.map((r) => [r.id, r.origin, r.status])).toEqual([
      [B, "inferred", "applied"],
      [other, "derived", "suggested"],
    ]);
  });
});

describe("determinism — the same brain answers the same way twice", () => {
  it("does not depend on the order candidates arrive in", () => {
    const forward = scoreSeed(SPEC_A);
    const shuffled = toDerivedEdgeInputs(
      relateOne(SPEC_A, [...candidatesFor(SPEC_A)].reverse()),
      hashesFor([SPEC_A, ...candidatesFor(SPEC_A)])
    );

    const key = (edges: DerivedEdgeInput[]) =>
      edges
        .map((e) => {
          const [s, t] = canonicalizePair(e.memoryA, e.memoryB);
          return `${s}|${t}|${e.origin}|${e.relation}|${e.weight}|${e.confidence}|${e.reason}`;
        })
        .sort();

    expect(key(shuffled)).toEqual(key(forward));
  });

  it("produces byte-identical evidence on a re-run", () => {
    expect(JSON.stringify(scoreSeed(SPEC_A))).toBe(JSON.stringify(scoreSeed(SPEC_A)));
  });

  it("scores nothing for a memory with no candidates at all", () => {
    // Scenario 17: a brain of one. The scorer must not invent a partner, and the worker
    // still reconciles (with an empty set) so a memory that *lost* its candidates loses
    // its edges — that half is asserted against the SQL in derived-link-service.test.ts.
    expect(relateOne(SPEC_A, [])).toEqual([]);
    expect(toDerivedEdgeInputs([], hashesFor([SPEC_A]))).toEqual([]);
  });
});

describe("quality gate 10 — one brain, five kinds of answer", () => {
  /**
   * The dataset the gate asks for, read through `brain_related(A)`:
   * an explicit link, an applied inferred edge, a suggested derived edge, a two-hop
   * graph path, a retrieval-only hit — and an orphan that must appear in none of them.
   */
  const EXPLICIT = "mem-explicit";
  const INFERRED = "mem-inferred";
  const GRAPH = "mem-two-hops";
  const LEXICAL = "mem-lexical-only";
  const ORPHAN = "mem-orphan";

  it("labels each of the five tiers, and never reports the orphan", async () => {
    retrieveMemories.mockResolvedValue({
      results: [
        { id: LEXICAL, score: { score: 0.9 }, legs: ["lexical"] },
        // Retrieval also nominates the derived neighbour; it must stay derived.
        { id: B, score: { score: 0.8 }, legs: ["entity"] },
      ],
      total: 2,
    });

    const suggestion = edgeBetween(scoreSeed(SPEC_A), A, B)!;
    const db = recordingDb({
      [MEMORY_TABLE]: [
        [{ id: A, title: SPEC_A.title, summary: SPEC_A.content, projectId: null }],
        hydration([EXPLICIT, INFERRED, B, GRAPH, LEXICAL]),
      ],
      [LINK_TABLE]: [
        [{ sourceMemoryId: A, targetMemoryId: EXPLICIT, linkType: "related_to" }],
        [{ sourceMemoryId: EXPLICIT, targetMemoryId: GRAPH, linkType: "related_to" }],
      ],
      [DERIVED_TABLE]: [
        [
          storedRow(suggestion),
          storedRow({
            ...suggestion,
            memoryB: INFERRED,
            origin: "inferred",
            weight: 0.54,
            confidence: 0.79,
          }),
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, A);

    expect(results.map((r) => [r.id, r.origin])).toEqual([
      [EXPLICIT, "explicit"],
      [INFERRED, "inferred"],
      [B, "derived"],
      [GRAPH, "graph"],
      [LEXICAL, "retrieval"],
    ]);
    // Trust, not similarity: the derived edge was also the second-best retrieval hit
    // and still sits below the inferred one, and the assertion outranks everything.
    expect(results[0].explicit).toBe(true);
    expect(results.slice(1).every((r) => r.explicit === false)).toBe(true);
    expect(results.find((r) => r.id === B)?.status).toBe("suggested");
    expect(results.find((r) => r.id === B)?.reason).toContain("also shared_entity");

    // The orphan is linked by nobody, resembles nothing, and answers no query.
    expect(results.map((r) => r.id)).not.toContain(ORPHAN);
  });
});

/**
 * A store that behaves the way `memory_derived_links` behaves for the three
 * statements reconciliation issues: delete the seed's rows for this scorer version,
 * count what is there, upsert on the canonical triple.
 *
 * It implements those clauses rather than verifying them — a fake cannot confirm its
 * own WHERE — so brain scoping and the version filter stay asserted against the SQL
 * in `src/features/brain/application/commands/derived-link-service.test.ts` and the migration in
 * `tests/brain-derived-schema.test.ts`. What it does prove is what neither of those
 * can: that scoring, pruning, canonicalising and upserting *compose* into a converging
 * state when the same job runs twice, or when both endpoints of a pair are scored in
 * turn.
 */
type StoredRow = Record<string, unknown> & {
  brainId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  computedBy: string;
  status: string;
};

function edgeStore() {
  const rows = new Map<string, StoredRow>();
  let sequence = 0;
  const keyOf = (row: { brainId: string; sourceMemoryId: string; targetMemoryId: string }) =>
    `${row.brainId}|${row.sourceMemoryId}|${row.targetMemoryId}`;

  /** A driver bound to one reconcile call, since the fake reads intent from the seed. */
  const driverFor = (brainId: string, seed: string) => {
    const tx = {
      delete: () => ({
        where: () => ({
          returning: () => {
            const removed: Array<{ id: string }> = [];
            for (const [key, row] of rows) {
              if (row.brainId !== brainId) continue;
              if (row.computedBy !== RELATE_VERSION) continue;
              if (row.sourceMemoryId !== seed && row.targetMemoryId !== seed) continue;
              removed.push({ id: String(row.id) });
              rows.delete(key);
            }
            return Promise.resolve(removed);
          },
        }),
      }),
      /** The degree query: applied edges per node, pairs touching the seed excluded. */
      execute: () => {
        const degrees = new Map<string, number>();
        for (const row of rows.values()) {
          if (row.brainId !== brainId || row.status !== "applied") continue;
          for (const [id, other] of [
            [row.sourceMemoryId, row.targetMemoryId],
            [row.targetMemoryId, row.sourceMemoryId],
          ]) {
            if (id === seed || other === seed) continue;
            degrees.set(id, (degrees.get(id) ?? 0) + 1);
          }
        }
        return Promise.resolve(
          [...degrees].map(([id, degree]) => ({ id, degree }))
        ) as unknown as Promise<unknown>;
      },
      select: () => ({
        from: () => ({
          where: () => ({
            then<T>(resolve: (value: unknown[]) => T) {
              const count = [...rows.values()].filter((row) => row.brainId === brainId).length;
              return Promise.resolve([{ count }]).then(resolve);
            },
          }),
        }),
      }),
      insert: () => {
        let pending: StoredRow[] = [];
        const chain = {
          values(values: StoredRow[]) {
            pending = values;
            return chain;
          },
          onConflictDoUpdate: () => chain,
          returning() {
            const result = pending.map((value) => {
              const key = keyOf(value);
              const existing = rows.get(key);
              if (existing) {
                // ON CONFLICT DO UPDATE: everything but the identity and createdAt.
                rows.set(key, { ...existing, ...value, id: existing.id });
                return { id: String(existing.id), isInsert: false };
              }
              sequence += 1;
              const id = `edge-${sequence}`;
              rows.set(key, { ...value, id });
              return { id, isInsert: true };
            });
            return Promise.resolve(result);
          },
        };
        return chain;
      },
    };
    return {
      ...tx,
      transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
    } as unknown as PostgresJsDatabase<typeof schema>;
  };

  return {
    driverFor,
    seed: (row: StoredRow) => rows.set(keyOf(row), row),
    all: () => [...rows.values()],
    /** Stable projection: what the row says, without identity or timestamps. */
    snapshot: () =>
      [...rows.values()]
        .map((row) => ({
          brainId: row.brainId,
          sourceMemoryId: row.sourceMemoryId,
          targetMemoryId: row.targetMemoryId,
          origin: row.origin,
          status: row.status,
          relation: row.relation,
          weight: row.weight,
          confidence: row.confidence,
          reason: row.reason,
          evidence: row.evidence,
          computedBy: row.computedBy,
          sourceHashA: row.sourceHashA,
          sourceHashB: row.sourceHashB,
        }))
        .sort((a, b) =>
          `${a.brainId}|${a.sourceMemoryId}|${a.targetMemoryId}`.localeCompare(
            `${b.brainId}|${b.sourceMemoryId}|${b.targetMemoryId}`
          )
        ),
  };
}

/** One relate job, end to end: score the seed, then reconcile what survives. */
const relateJob = (store: ReturnType<typeof edgeStore>, seed: RelateMemory) =>
  reconcileDerivedEdges(store.driverFor(BRAIN, seed.id), BRAIN, seed.id, scoreSeed(seed));

describe("idempotency — running the job again changes nothing", () => {
  it("converges on the same rows when the same seed is scored twice", async () => {
    const store = edgeStore();

    const first = await relateJob(store, SPEC_A);
    const after = store.snapshot();
    const second = await relateJob(store, SPEC_A);

    expect(first.inserted).toBeGreaterThan(0);
    expect(store.snapshot()).toEqual(after);
    // The second run reclaims its own rows before rewriting them, so the count it
    // deleted is the count it had written: no drift, no accumulation.
    expect(second.deleted).toBe(first.inserted);
    expect(second.inserted + second.updated).toBe(first.inserted);
  });

  it("stores one row for a pair no matter which end of it is scored", async () => {
    const store = edgeStore();

    await relateJob(store, SPEC_A);
    const fromA = store.snapshot();
    await relateJob(store, SPEC_B);

    const pairKeys = store
      .all()
      .map((row) => `${row.sourceMemoryId}|${row.targetMemoryId}`);
    expect(new Set(pairKeys).size).toBe(pairKeys.length);

    // A scored B, then B scored A: canonical ordering means the second job found the
    // first job's row and updated it in place rather than storing the mirror image.
    const [source, target] = canonicalizePair(A, B);
    const ab = store.all().filter(
      (row) =>
        (row.sourceMemoryId === source && row.targetMemoryId === target) ||
        (row.sourceMemoryId === target && row.targetMemoryId === source)
    );
    expect(ab).toHaveLength(1);
    expect(ab[0].sourceMemoryId).toBe(source);
    expect(ab[0].targetMemoryId).toBe(target);
    // Both jobs agreed about the pair, because one scorer produced both readings.
    const before = fromA.find(
      (row) => row.sourceMemoryId === source && row.targetMemoryId === target
    );
    expect(ab[0].weight).toBe(before?.weight);
    expect(ab[0].confidence).toBe(before?.confidence);
  });

  it("leaves another scorer version's edges where they are", async () => {
    const store = edgeStore();
    const [source, target] = canonicalizePair(A, C);
    store.seed({
      id: "edge-v2",
      brainId: BRAIN,
      sourceMemoryId: source,
      targetMemoryId: target,
      origin: "inferred",
      status: "applied",
      relation: "semantic",
      weight: 0.71,
      confidence: 0.8,
      reason: "relate-v2 saw something v1 does not",
      evidence: { signalFamilyCount: 2 },
      computedBy: "relate-v2",
      sourceHashA: "hash-a",
      sourceHashB: "hash-c",
    });

    await relateJob(store, SPEC_A);

    // PRINSIP 8: v1 reconciles its own rows. A pair v1 has no opinion about is not
    // v1's to delete, even though the seed is one of its endpoints.
    const survivor = store.all().find((row) => row.computedBy === "relate-v2");
    expect(survivor).toMatchObject({ weight: 0.71, reason: "relate-v2 saw something v1 does not" });
  });
});
