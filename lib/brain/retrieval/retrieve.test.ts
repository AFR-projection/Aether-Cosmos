import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { setEmbeddingProviderForTests } from "../embedding/provider";
import {
  ANY_FALLBACK_MIN_LEXEMES,
  CANDIDATE_POOL_MAX,
  ENTITY_CANDIDATE_LIMIT,
  GRAPH_CANDIDATE_LIMIT,
  GRAPH_MAX_HOPS,
  LEXICAL_CANDIDATE_LIMIT,
  MAX_QUERY_WORDS,
  OMITTED_REPORT_MAX,
  PROVENANCE_QUALITY,
  PROVENANCE_QUALITY_DEFAULT,
  RESULT_LIMIT_MAX,
  SEMANTIC_CANDIDATE_LIMIT,
  entityNamePattern,
  provenanceQuality,
  queryWords,
  retrieveMemories,
} from "./retrieve";

/**
 * Retrieval has no live Postgres in this suite, so the database is replaced by a
 * builder stub that answers each leg by the table it reads. That is enough to pin
 * down the part of P2 that is actually algorithmic — which legs voted, what raw
 * features they attached, who was excluded, and how the pool was cut — while the
 * SQL-shaped guarantees (tenant scope on every statement, a row cap on every leg,
 * and the fact that retrieval never writes) are asserted against the source text.
 */

type QuerySpec = { table: string; joined: boolean; grouped: boolean; limited: boolean };

type FakeRows = {
  lexical?: unknown[];
  /** Rows the OR recall tier returns when the AND tier leaves room (second lexical read). */
  lexicalAny?: unknown[];
  entities?: unknown[];
  entityHits?: unknown[];
  mentions?: unknown[];
  /** One entry per graph hop, in order. */
  links?: unknown[][];
  loaded?: unknown[];
  /** Rows the semantic ANN leg returns via db.execute (shape `{id, similarity}`). */
  semantic?: unknown[];
};

type Fake = { db: PostgresJsDatabase<typeof schema>; reads: QuerySpec[] };

function fakeDb(rows: FakeRows): Fake {
  const reads: QuerySpec[] = [];
  const hops = [...(rows.links ?? [])];
  let lexicalReads = 0;

  const answer = (spec: QuerySpec): unknown[] => {
    if (spec.table === "brain_entities") return rows.entities ?? [];
    if (spec.table === "memory_mentions") {
      return (spec.joined ? rows.entityHits : rows.mentions) ?? [];
    }
    if (spec.table === "memory_links") return hops.shift() ?? [];
    // The lexical leg is the only read of `memories` that is ordered and capped; the
    // uncapped one is the candidate-row loader. The capped read happens up to twice:
    // the AND precision tier first, then the OR recall tier that backfills leftover
    // slots — so the second capped read answers with `lexicalAny`.
    if (spec.table === "memories") {
      if (!spec.limited) return rows.loaded ?? [];
      lexicalReads += 1;
      return (lexicalReads === 1 ? rows.lexical : rows.lexicalAny) ?? [];
    }
    throw new Error(`unexpected read of ${spec.table}`);
  };

  const builder = (spec: QuerySpec) => {
    const chain = {
      from(table: unknown) {
        spec.table = getTableName(table as never);
        return chain;
      },
      innerJoin() {
        spec.joined = true;
        return chain;
      },
      where: () => chain,
      groupBy() {
        spec.grouped = true;
        return chain;
      },
      orderBy: () => chain,
      limit() {
        spec.limited = true;
        return chain;
      },
      then<T>(resolve: (value: unknown[]) => T) {
        reads.push(spec);
        return Promise.resolve(answer(spec)).then(resolve);
      },
    };
    return chain;
  };

  const db = {
    select: () => builder({ table: "", joined: false, grouped: false, limited: false }),
    selectDistinct: () => builder({ table: "", joined: false, grouped: false, limited: false }),
    // The semantic leg runs its ANN search through a raw execute — a separate channel
    // from the leg-by-table builder above, so it never disturbs the counter routing.
    execute: async () => {
      reads.push({ table: "memories:semantic", joined: false, grouped: false, limited: true });
      return (rows.semantic ?? []) as unknown[];
    },
  };
  return { db: db as unknown as PostgresJsDatabase<typeof schema>, reads };
}

const BRAIN = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-22T00:00:00.000Z");

function memoryRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    brainId: BRAIN,
    type: "fact",
    title: `Memory ${id}`,
    summary: null,
    contentChars: 400,
    projectId: null,
    importance: 0.5,
    confidence: 0.9,
    sourceType: "user",
    validityState: "active",
    supersededById: null,
    recallCount: 0,
    confirmationCount: 0,
    lastRecalledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

afterEach(() => {
  setEmbeddingProviderForTests(null);
});

describe("queryWords", () => {
  it("keeps only words that could name an entity", () => {
    // Stop words and two-letter fragments are not evidence; the list is the shared
    // bilingual one from graph/relate.ts, so "yang" cannot resolve to a node.
    expect(queryWords("Yang ini adalah PostgreSQL di VPS")).toEqual(["postgresql", "vps"]);
  });

  it("is case-insensitive, deduplicated and bounded", () => {
    expect(queryWords("Redis redis REDIS")).toEqual(["redis"]);
    const many = Array.from({ length: MAX_QUERY_WORDS + 10 }, (_, i) => `word${i}`).join(" ");
    expect(queryWords(many)).toHaveLength(MAX_QUERY_WORDS);
  });

  it("returns nothing for punctuation, so no regex is built from it", () => {
    expect(queryWords("!!! ??? ...")).toEqual([]);
  });
});

describe("entityNamePattern", () => {
  it("anchors on non-alphanumeric boundaries", () => {
    expect(entityNamePattern(["redis", "r2"])).toBe(
      "(^|[^[:alnum:]])(redis|r2)([^[:alnum:]]|$)"
    );
  });
});

describe("provenanceQuality", () => {
  it("is a documented table, and an unknown source is average rather than zero", () => {
    expect(provenanceQuality("user")).toBe(PROVENANCE_QUALITY.user);
    expect(provenanceQuality("imported_document")).toBeLessThan(PROVENANCE_QUALITY.user);
    expect(provenanceQuality("something_new")).toBe(PROVENANCE_QUALITY_DEFAULT);
  });

  it("never leaves the unit interval", () => {
    for (const value of Object.values(PROVENANCE_QUALITY)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("retrieveMemories — the lexical leg", () => {
  it("carries the raw ts_rank through and lets ranking normalize it", async () => {
    const { db } = fakeDb({
      lexical: [
        { ...memoryRow("a"), lexicalRank: 0.9 },
        { ...memoryRow("b"), lexicalRank: 0.1 },
      ],
    });

    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      query: "postgres storage",
      now: NOW,
    });

    expect(result.results.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.results[0].features.lexicalRank).toBe(0.9);
    expect(result.results[0].score.whyMatched).toContain("lexical");
    expect(result.results.map((row) => row.rank)).toEqual([1, 2]);
    expect(result.legCounts.lexical).toBe(2);
    expect(result.semanticAvailable).toBe(false);
  });

  it("reports a configured provider without pretending the leg voted", async () => {
    setEmbeddingProviderForTests({
      model: "test-encoder",
      dimensions: 3,
      available: async () => true,
      embed: async () => [],
    });

    const { db } = fakeDb({ lexical: [{ ...memoryRow("a"), lexicalRank: 0.5 }] });
    const result = await retrieveMemories(db, { brainId: BRAIN, query: "postgres", now: NOW });

    expect(result.semanticAvailable).toBe(true);
    // No vector column exists yet (P9), so the leg abstains — it does not vote zero.
    expect(result.legCounts.semantic).toBe(0);
    expect(result.results[0].features.semanticSimilarity).toBeUndefined();
  });

  it("excludes what the caller asked to exclude", async () => {
    const { db } = fakeDb({
      lexical: [
        { ...memoryRow("a"), lexicalRank: 0.9 },
        { ...memoryRow("b"), lexicalRank: 0.8 },
      ],
    });

    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      query: "postgres",
      excludeMemoryIds: ["a"],
      now: NOW,
    });

    expect(result.results.map((row) => row.id)).toEqual(["b"]);
    expect(result.candidates).toBe(1);
  });

  it("cuts at the limit and reports a bounded tail of what it dropped", async () => {
    const lexical = Array.from({ length: 40 }, (_, i) => ({
      ...memoryRow(`m${String(i).padStart(2, "0")}`),
      lexicalRank: (40 - i) / 40,
    }));
    const { db } = fakeDb({ lexical });

    // Use a query that passes preprocessing (>= 3 chars, not a stopword)
    const result = await retrieveMemories(db, { brainId: BRAIN, query: "test query", limit: 5, now: NOW });

    expect(result.results).toHaveLength(5);
    expect(result.candidates).toBe(40);
    expect(result.omitted).toHaveLength(OMITTED_REPORT_MAX);
    expect(result.omitted[0].rank).toBe(6);
  });
});

describe("retrieveMemories — the lexical recall tier", () => {
  it("backfills OR matches when the AND tier leaves room, without displacing it", async () => {
    // The AND tier found one exact hit; the recall tier adds a memory that matches
    // only some of the query's words. Both reach the ranker, and the precise hit —
    // carrying the higher ts_rank — still leads.
    const { db, reads } = fakeDb({
      lexical: [{ ...memoryRow("exact"), lexicalRank: 0.9 }],
      lexicalAny: [{ ...memoryRow("partial"), lexicalRank: 0.2 }],
    });

    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      query: "postgres backup strategy",
      now: NOW,
    });

    expect(result.results.map((row) => row.id)).toEqual(["exact", "partial"]);
    expect(result.legCounts.lexical).toBe(2);
    expect(result.results[0].features.lexicalRank).toBe(0.9);
    expect(result.results[1].features.lexicalRank).toBe(0.2);
    // Two capped reads of `memories`: the AND precision tier, then the OR recall tier.
    expect(reads.filter((read) => read.table === "memories" && read.limited)).toHaveLength(2);
  });

  it("recovers results the brittle AND match would have dropped entirely", async () => {
    // No memory carries every term, so the AND tier returns nothing. Before the recall
    // tier this query answered with an empty list; now the best partial match surfaces.
    const { db } = fakeDb({
      lexical: [],
      lexicalAny: [{ ...memoryRow("partial"), lexicalRank: 0.3 }],
    });

    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      query: "postgres backup strategy production",
      now: NOW,
    });

    expect(result.results.map((row) => row.id)).toEqual(["partial"]);
    expect(result.legCounts.lexical).toBe(1);
  });

  it("does not run the OR tier for a single-term query (AND and OR are identical)", async () => {
    const { db, reads } = fakeDb({
      lexical: [{ ...memoryRow("only"), lexicalRank: 0.5 }],
      lexicalAny: [{ ...memoryRow("phantom"), lexicalRank: 0.9 }],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "postgres", now: NOW });

    // One lexeme ⇒ the fallback is a no-op and must not run, so `phantom` never loads.
    expect(result.results.map((row) => row.id)).toEqual(["only"]);
    expect(reads.filter((read) => read.table === "memories" && read.limited)).toHaveLength(1);
    expect(ANY_FALLBACK_MIN_LEXEMES).toBe(2);
  });

  it("never double-counts a memory the OR tier repeats", async () => {
    // A stub that ignores the notInArray filter can hand the same row back to both
    // tiers; the merge must still list it once, keeping the precise tier's rank.
    const { db } = fakeDb({
      lexical: [{ ...memoryRow("dup"), lexicalRank: 0.8 }],
      lexicalAny: [{ ...memoryRow("dup"), lexicalRank: 0.1 }],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "postgres backup", now: NOW });

    expect(result.results.map((row) => row.id)).toEqual(["dup"]);
    expect(result.legCounts.lexical).toBe(1);
    expect(result.results[0].features.lexicalRank).toBe(0.8);
  });
});

const QUERY_ENTITIES = [
  { id: "e1", name: "PostgreSQL", type: "technology" },
  { id: "e2", name: "pgvector", type: "technology" },
];

describe("retrieveMemories — the entity leg", () => {
  it("scores coverage of the query's entities, not raw mention counts", async () => {
    const { db } = fakeDb({
      entities: QUERY_ENTITIES,
      entityHits: [
        { memoryId: "m1", matched: 2 },
        { memoryId: "m2", matched: 1 },
      ],
      loaded: [memoryRow("m1"), memoryRow("m2")],
      mentions: [
        { memoryId: "m1", entityId: "e1", mentions: 3 },
        { memoryId: "m1", entityId: "e2", mentions: 1 },
        { memoryId: "m2", entityId: "e1", mentions: 9 },
      ],
    });

    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      query: "postgresql pgvector",
      now: NOW,
    });

    const [first, second] = result.results;
    expect(first.id).toBe("m1");
    expect(first.features.entityOverlap).toBe(1);
    // m2 names one entity nine times and still loses to m1, which covers both.
    expect(second.features.entityOverlap).toBe(0.5);
    expect(first.score.whyMatched).toContain("entity");
    expect(result.queryEntities).toEqual(QUERY_ENTITIES);
  });

  it("attaches the spans that justify the match, strongest first", async () => {
    const { db } = fakeDb({
      entities: QUERY_ENTITIES,
      entityHits: [{ memoryId: "m1", matched: 2 }],
      loaded: [memoryRow("m1")],
      mentions: [
        { memoryId: "m1", entityId: "e2", mentions: 1 },
        { memoryId: "m1", entityId: "e1", mentions: 4 },
      ],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "postgresql", now: NOW });

    expect(result.results[0].entityEvidence).toEqual([
      { entityId: "e1", name: "PostgreSQL", type: "technology", mentions: 4 },
      { entityId: "e2", name: "pgvector", type: "technology", mentions: 1 },
    ]);
  });

  it("drops a hit the visibility scope refuses to load", async () => {
    // The join table can still name a memory that is archived, deleted, filtered out
    // or in another brain. Loading is what enforces the scope, so an id the loader
    // does not return must never reach the pool.
    const { db } = fakeDb({
      entities: QUERY_ENTITIES,
      entityHits: [{ memoryId: "hidden", matched: 2 }],
      loaded: [],
      mentions: [{ memoryId: "hidden", entityId: "e1", mentions: 5 }],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "postgresql", now: NOW });

    expect(result.results).toEqual([]);
    expect(result.candidates).toBe(0);
    expect(result.legCounts.entity).toBe(0);
  });
});

describe("retrieveMemories — the graph leg", () => {
  const walk = () =>
    fakeDb({
      links: [
        [
          { source: "seed", target: "n1", linkType: "supersedes" },
          { source: "n3", target: "seed", linkType: "contradicts" },
        ],
        [{ source: "n1", target: "n2", linkType: "relates_to" }],
      ],
      loaded: [memoryRow("n1"), memoryRow("n2"), memoryRow("n3")],
    });

  it("walks both directions and decays with distance", async () => {
    const { db } = walk();
    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      seedMemoryIds: ["seed"],
      now: NOW,
    });

    const byId = new Map(result.results.map((row) => [row.id, row]));
    expect(byId.get("n1")?.graphEvidence).toEqual({
      fromMemoryId: "seed",
      hops: 1,
      linkType: "supersedes",
      direction: "outgoing",
    });
    expect(byId.get("n3")?.graphEvidence?.direction).toBe("incoming");
    expect(byId.get("n2")?.features.graphHops).toBe(2);
  });

  it("treats only a direct link as a relationship, and never returns the seed", async () => {
    const { db } = walk();
    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      seedMemoryIds: ["seed"],
      now: NOW,
    });

    const byId = new Map(result.results.map((row) => [row.id, row]));
    // A one-hop link is somebody's explicit assertion, so it votes on `related` too.
    expect(byId.get("n1")?.features.relationshipStrength).toBe(1);
    // Two hops away is proximity, not a relationship.
    expect(byId.get("n2")?.features.relationshipStrength).toBeUndefined();
    expect(byId.has("seed")).toBe(false);
    expect(byId.get("n1")!.score.score).toBeGreaterThan(byId.get("n2")!.score.score);
  });

  it("stops at the hop ceiling", async () => {
    const { db, reads } = walk();
    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      seedMemoryIds: ["seed"],
      maxHops: 1,
      now: NOW,
    });

    expect(result.results.map((row) => row.id).sort()).toEqual(["n1", "n3"]);
    expect(reads.filter((read) => read.table === "memory_links")).toHaveLength(1);
  });

  it("asks the database for nothing when there is no query and no seed", async () => {
    const { db, reads } = fakeDb({});
    const result = await retrieveMemories(db, { brainId: BRAIN, now: NOW });

    // Quality is not relevance: with no match evidence there is nothing to rank, and
    // "the whole brain ordered by importance" is not an answer.
    expect(result.results).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe("retrieveMemories — merging the legs", () => {
  const overlapping = () =>
    fakeDb({
      lexical: [{ ...memoryRow("m1"), lexicalRank: 0.5 }],
      entities: QUERY_ENTITIES,
      entityHits: [{ memoryId: "m1", matched: 1 }],
      mentions: [{ memoryId: "m1", entityId: "e1", mentions: 2 }],
      links: [[{ source: "m1", target: "m9", linkType: "relates_to" }]],
      loaded: [memoryRow("m9")],
    });

  it("keeps one candidate per memory, with every leg that voted", async () => {
    const { db, reads } = overlapping();
    const result = await retrieveMemories(db, {
      brainId: BRAIN,
      query: "postgresql pgvector",
      now: NOW,
    });

    const m1 = result.results.find((row) => row.id === "m1")!;
    expect(m1.legs).toEqual(["lexical", "entity"]);
    expect(m1.features.lexicalRank).toBe(0.5);
    expect(m1.features.entityOverlap).toBe(0.5);
    expect(result.legCounts).toEqual({ lexical: 1, entity: 1, graph: 1, semantic: 0 });
    expect(result.candidates).toBe(2);
    // m1 came back with the lexical rows, so the loader was asked for m9 only — a
    // second read of a row already in hand would be pure waste.
    expect(reads.filter((read) => read.table === "memories" && !read.limited)).toHaveLength(1);
  });

  it("is deterministic: the same inputs give the same order and the same scores", async () => {
    const first = await retrieveMemories(overlapping().db, {
      brainId: BRAIN,
      query: "postgresql pgvector",
      now: NOW,
    });
    const second = await retrieveMemories(overlapping().db, {
      brainId: BRAIN,
      query: "postgresql pgvector",
      now: NOW,
    });

    expect(second.results.map((row) => [row.id, row.rank, row.score.score])).toEqual(
      first.results.map((row) => [row.id, row.rank, row.score.score])
    );
  });
});

describe("retrieveMemories — the semantic leg", () => {
  const stubProvider = (over: Partial<{ available: boolean; embed: () => Promise<Float32Array[]> }> = {}) =>
    setEmbeddingProviderForTests({
      model: "test-encoder",
      dimensions: 3,
      available: async () => over.available ?? true,
      embed: over.embed ?? (async () => [Float32Array.from([0.1, 0.2, 0.3])]),
    });

  it("votes with the cosine similarity and blends alongside the lexical leg", async () => {
    stubProvider();
    const { db, reads } = fakeDb({
      lexical: [{ ...memoryRow("m1"), lexicalRank: 0.5 }],
      loaded: [memoryRow("m2")],
      semantic: [
        { id: "m1", similarity: 0.92 },
        { id: "m2", similarity: 0.81 },
      ],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "vector search", now: NOW });

    expect(result.semanticAvailable).toBe(true);
    expect(result.legCounts.semantic).toBe(2);
    const m1 = result.results.find((row) => row.id === "m1")!;
    const m2 = result.results.find((row) => row.id === "m2")!;
    // m1 was found by both legs; m2 only by the semantic ANN and still enters the pool.
    expect(m1.legs).toEqual(["lexical", "semantic"]);
    expect(m1.features.semanticSimilarity).toBe(0.92);
    expect(m2.legs).toEqual(["semantic"]);
    expect(m2.features.semanticSimilarity).toBe(0.81);
    expect(m1.score.whyMatched).toContain("semantic");
    // The ANN ran exactly once, through the raw execute channel.
    expect(reads.filter((read) => read.table === "memories:semantic")).toHaveLength(1);
  });

  it("abstains without throwing when the provider fails to embed the query", async () => {
    stubProvider({ embed: async () => { throw new Error("network down"); } });
    const { db, reads } = fakeDb({
      lexical: [{ ...memoryRow("m1"), lexicalRank: 0.5 }],
      semantic: [{ id: "m1", similarity: 0.99 }],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "vector search", now: NOW });

    // Provider is configured, so the flag is true, but the leg contributed nothing and
    // retrieval degraded to lexical — no execute ran, no semantic vote landed.
    expect(result.semanticAvailable).toBe(true);
    expect(result.legCounts.semantic).toBe(0);
    expect(result.results.map((row) => row.id)).toEqual(["m1"]);
    expect(reads.filter((read) => read.table === "memories:semantic")).toHaveLength(0);
  });

  it("does not run when no provider is configured", async () => {
    const { db, reads } = fakeDb({
      lexical: [{ ...memoryRow("m1"), lexicalRank: 0.5 }],
      semantic: [{ id: "m1", similarity: 0.99 }],
    });

    const result = await retrieveMemories(db, { brainId: BRAIN, query: "vector search", now: NOW });

    expect(result.semanticAvailable).toBe(false);
    expect(result.legCounts.semantic).toBe(0);
    expect(reads.filter((read) => read.table === "memories:semantic")).toHaveLength(0);
  });
});

describe("the SQL keeps retrieval's invariants", () => {
  const source = readFileSync("lib/brain/retrieval/retrieve.ts", "utf8");

  it("never writes anything", () => {
    // Retrieval is a read. Recall counters and retrieval events are P5/P10 work, and
    // a read path that quietly writes cannot be cached, retried or run on a replica.
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
  });

  it("scopes every leg by brain", () => {
    expect(source).toContain("eq(memories.brainId, params.brainId)");
    expect(source).toContain("eq(memoryMentions.brainId, params.brainId)");
    expect(source).toContain("eq(memoryMentions.brainId, brainId)");
    expect(source).toContain("eq(memoryLinks.brainId, brainId)");
    expect(source).toContain("eq(brainEntities.brainId, brainId)");
  });

  it("keeps the semantic ANN search brain-scoped in the same WHERE as the ORDER BY", () => {
    // ISOLATION: a vector index must never range across tenants. The brain_id predicate
    // has to sit in the SAME WHERE clause as `ORDER BY embedding <=>`, or a nearest
    // neighbour from another brain could rank first. Assert both live in semanticLeg.
    const leg = source.slice(
      source.indexOf("async function semanticLeg"),
      source.indexOf("function uniqueIds")
    );
    expect(leg).toContain("eq(memories.brainId, params.brainId)");
    expect(leg).toContain("ORDER BY ${distance} ASC");
    expect(leg).toContain("WHERE ${sql.join(filters");
    // The leg abstains rather than throwing when the provider fails.
    expect(leg).toContain("return [];");
  });

  it("re-applies the visibility scope when loading ids from a join table", () => {
    const loader = source.slice(
      source.indexOf("async function loadCandidateRows"),
      source.indexOf("/** Documented, deterministic provenance quality")
    );
    expect(loader).toContain("visibilityScope(params)");
    expect(loader).toContain("inArray(memories.id");
  });

  it("caps every leg", () => {
    expect(source).toContain("limit(LEXICAL_CANDIDATE_LIMIT)");
    expect(source).toContain("limit(ENTITY_CANDIDATE_LIMIT)");
    expect(source).toContain("limit(GRAPH_EDGE_LIMIT)");
    expect(source).toContain("limit(QUERY_ENTITY_LIMIT)");
    expect(source).toContain("LIMIT ${SEMANTIC_CANDIDATE_LIMIT}");
    expect(CANDIDATE_POOL_MAX).toBe(
      LEXICAL_CANDIDATE_LIMIT + ENTITY_CANDIDATE_LIMIT + GRAPH_CANDIDATE_LIMIT + SEMANTIC_CANDIDATE_LIMIT
    );
    expect(GRAPH_MAX_HOPS).toBeLessThanOrEqual(2);
    expect(RESULT_LIMIT_MAX).toBeLessThanOrEqual(CANDIDATE_POOL_MAX);
  });

  it("skips a link with no target instead of inventing one", () => {
    expect(source).toContain("if (!edge.target) continue;");
  });
});

describe("brain_search is left alone", () => {
  const memoryService = readFileSync("lib/brain/memory-service.ts", "utf8");

  it("still runs its own query, unchanged", () => {
    // P2 adds a surface; it does not replace the search box. If searchMemories ever
    // starts delegating here, its ordering contract changes silently.
    expect(memoryService).toContain("ftsMatchOn(memories.searchVector, q)");
    expect(memoryService).toContain("desc(ftsRankOn(memories.searchVector, q))");
    expect(memoryService).not.toContain("retrieveMemories");
  });
});
