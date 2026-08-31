import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { estimateTokens, usableTokenBudget, TOKEN_MODEL } from "@brain/domain/tokens";
import {
  CONTEXT_MAX_MEMORIES_DEFAULT,
  CONTEXT_OMITTED_MAX,
  CONTEXT_TOKEN_BUDGET_MAX,
  CONTEXT_TOKEN_BUDGET_MIN,
  MEMORY_TOKENS_MAX,
  MEMORY_TOKENS_MIN,
  REDUNDANCY_THRESHOLD,
  SHORTLIST_FACTOR,
  buildContext,
  distinctiveWords,
  wordOverlap,
} from "./context-engine";

/**
 * The context engine's contract is a promise about a number: whatever the caller
 * asks for, the package it gets back fits. That is what most of these tests check —
 * against the real tokenizer, at several budgets, on bodies far larger than the
 * budget — together with the two things that make the answer usable: every dropped
 * candidate has a reason, and the same request always produces the same package.
 *
 * There is no live Postgres here, so the database is a builder stub that answers
 * each read by the table and the columns it projects. The SQL-shaped guarantees
 * (tenant scope on every statement, no writes, bodies read only for the shortlist)
 * are asserted against the source text.
 */

type QuerySpec = { table: string; columns: string[]; joined: boolean; limited: boolean };

type FakeRows = {
  lexical?: unknown[];
  entities?: unknown[];
  entityHits?: unknown[];
  mentions?: unknown[];
  links?: unknown[][];
  candidates?: unknown[];
  context?: unknown[];
  contextEdges?: unknown[];
  derivedEdges?: unknown[];
  sharedEntities?: unknown[];
};

type Fake = { db: PostgresJsDatabase<typeof schema>; reads: QuerySpec[] };

function fakeDb(rows: FakeRows): Fake {
  const reads: QuerySpec[] = [];
  const hops = [...(rows.links ?? [])];

  const answer = (spec: QuerySpec): unknown[] => {
    const has = (column: string) => spec.columns.includes(column);
    if (spec.table === "brain_entities") return rows.entities ?? [];
    if (spec.table === "memory_mentions") {
      if (has("memoryIds")) return rows.sharedEntities ?? [];
      if (has("matched")) return rows.entityHits ?? [];
      return rows.mentions ?? [];
    }
    if (spec.table === "memory_links") {
      // The context engine's edge read projects `sourceId`; the retrieval walk
      // projects `source` and consumes one hop per read.
      return has("sourceId") ? (rows.contextEdges ?? []) : (hops.shift() ?? []);
    }
    // PHASE 2: computed edges live in their own table, read only for the graph.
    if (spec.table === "memory_derived_links") return rows.derivedEdges ?? [];
    if (spec.table === "memories") {
      if (has("lexicalRank")) return rows.lexical ?? [];
      // `content` is projected by exactly one read: the shortlist text loader.
      if (has("content")) return rows.context ?? [];
      return rows.candidates ?? [];
    }
    throw new Error(`unexpected read of ${spec.table} [${spec.columns.join(",")}]`);
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
      groupBy: () => chain,
      having: () => chain,
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

  const start = (projection?: Record<string, unknown>) =>
    builder({
      table: "",
      columns: Object.keys(projection ?? {}),
      joined: false,
      limited: false,
    });

  const db = { select: start, selectDistinct: start };
  return { db: db as unknown as PostgresJsDatabase<typeof schema>, reads };
}

const BRAIN = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-22T00:00:00.000Z");

/** Distinct words, so two generated memories are never accidentally redundant. */
function filler(seed: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${seed}kata${index}`).join(" ");
}

function lexicalRow(id: string, rank: number, over: Record<string, unknown> = {}) {
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
    lexicalRank: rank,
    ...over,
  };
}

function textRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: "fact",
    title: `Memory ${id}`,
    summary: null,
    content: `Catatan ${id}. ${filler(id, 40)}`,
    sourceType: "user",
    sourceId: null,
    createdByUserId: null,
    createdByAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    enrichedAt: NOW,
    confidence: 0.9,
    importance: 0.5,
    confirmationCount: 0,
    lastConfirmedAt: null,
    validityState: "active",
    supersededById: null,
    ...over,
  };
}

/** `count` memories, ranked in id order, each with a body of its own words. */
function brainWith(count: number, contentWords = 40): Fake {
  const ids = Array.from({ length: count }, (_, index) => `m${String(index).padStart(2, "0")}`);
  return fakeDb({
    lexical: ids.map((id, index) => lexicalRow(id, (count - index) / count)),
    context: ids.map((id) => textRow(id, { content: `Catatan ${id}. ${filler(id, contentWords)}` })),
  });
}

describe("distinctiveWords / wordOverlap", () => {
  it("ignores words that carry no signal", () => {
    expect([...distinctiveWords("Yang ini adalah PostgreSQL di VPS")]).toEqual([
      "postgresql",
      "vps",
    ]);
  });

  it("is 1 for the same text and 0 when either side is too short to judge", () => {
    const long = "postgresql pgvector retrieval ranking embedding storage";
    expect(wordOverlap(distinctiveWords(long), distinctiveWords(long))).toBe(1);
    expect(wordOverlap(distinctiveWords("redis cache"), distinctiveWords("redis cache"))).toBe(0);
  });
});

describe("buildContext — the token budget", () => {
  it("never exceeds the usable budget, at any budget", async () => {
    // The invariant the whole engine exists for, checked against the real tokenizer
    // at four scales with 20 memories that together are far larger than any of them.
    for (const tokenBudget of [CONTEXT_TOKEN_BUDGET_MIN, 600, 2_000, 8_000]) {
      const result = await buildContext(brainWith(20, 120).db, {
        brainId: BRAIN,
        task: "postgres storage",
        tokenBudget,
        maxMemories: 20,
        now: NOW,
      });

      expect(result.usableBudget).toBe(usableTokenBudget(tokenBudget));
      expect(result.tokensUsed).toBeLessThanOrEqual(result.usableBudget);
      // `tokensUsed` is a measurement of the text, not a running sum of guesses.
      expect(result.tokensUsed).toBe(estimateTokens(result.contextText));
      expect(result.tokenModel).toBe(TOKEN_MODEL);
    }
  });

  it("clamps a budget the caller had no business asking for", async () => {
    const tiny = await buildContext(brainWith(2).db, {
      brainId: BRAIN,
      task: "x",
      tokenBudget: 1,
      now: NOW,
    });
    expect(tiny.tokenBudget).toBe(CONTEXT_TOKEN_BUDGET_MIN);

    const huge = await buildContext(brainWith(2).db, {
      brainId: BRAIN,
      task: "x",
      tokenBudget: 10_000_000,
      now: NOW,
    });
    expect(huge.tokenBudget).toBe(CONTEXT_TOKEN_BUDGET_MAX);
  });

  it("spends the budget on several memories instead of one long one", async () => {
    // "Jangan mengirim 100 memory kalau 8 memory cukup" cuts both ways: one memory
    // must not be allowed to spend everyone else's tokens either.
    const result = await buildContext(brainWith(8, 600).db, {
      brainId: BRAIN,
      task: "postgres",
      tokenBudget: 4_000,
      now: NOW,
    });

    expect(result.memories.length).toBeGreaterThan(3);
    for (const memory of result.memories) {
      expect(memory.tokens).toBeLessThanOrEqual(MEMORY_TOKENS_MAX + 40);
      expect(memory.truncated).toBe(true);
      expect(memory.text.endsWith("…")).toBe(true);
    }
  });
});

describe("buildContext — what was left out, and why", () => {
  it("stops at maxMemories and says so", async () => {
    const result = await buildContext(brainWith(10).db, {
      brainId: BRAIN,
      task: "postgres",
      maxMemories: 3,
      tokenBudget: 8_000,
      now: NOW,
    });

    expect(result.memories).toHaveLength(3);
    expect(result.memories.map((memory) => memory.id)).toEqual(["m00", "m01", "m02"]);
    const capped = result.omitted.filter((row) => row.reason === "max_memories");
    expect(capped.length).toBeGreaterThan(0);
    expect(capped[0].rank).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("reports what retrieval itself ranked out, bounded", async () => {
    // maxMemories 2 means a shortlist of 6; the rest never had their text loaded and
    // are reported as `rank` rather than silently vanishing.
    const result = await buildContext(brainWith(40).db, {
      brainId: BRAIN,
      task: "postgres",
      maxMemories: 2,
      tokenBudget: 8_000,
      now: NOW,
    });

    expect(result.memories).toHaveLength(2);
    expect(result.candidates).toBe(40);
    expect(result.omitted.length).toBeLessThanOrEqual(CONTEXT_OMITTED_MAX);
    expect(result.omitted.some((row) => row.reason === "rank")).toBe(true);
    for (const row of result.omitted) {
      expect(row.reason).toBeTruthy();
      expect(row.rank).toBeGreaterThan(0);
    }
  });

  it("drops a memory that repeats one already selected, naming the original", async () => {
    const body = `Deploy berjalan di VPS Hetzner dengan Postgres 17 dan Redis. ${filler("sama", 30)}`;
    const { db } = fakeDb({
      lexical: [lexicalRow("original", 0.9), lexicalRow("copy", 0.8), lexicalRow("other", 0.7)],
      context: [
        textRow("original", { content: body }),
        textRow("copy", { content: body }),
        textRow("other", { content: `Beda total. ${filler("lain", 30)}` }),
      ],
    });

    const result = await buildContext(db, {
      brainId: BRAIN,
      task: "deploy",
      tokenBudget: 8_000,
      now: NOW,
    });

    expect(result.memories.map((memory) => memory.id)).toEqual(["original", "other"]);
    const redundant = result.omitted.find((row) => row.reason === "redundant");
    expect(redundant?.id).toBe("copy");
    expect(redundant?.redundantWithId).toBe("original");
  });
});

describe("buildContext — the rendered package", () => {
  it("labels every memory with its position, score and audited reason", async () => {
    const result = await buildContext(brainWith(2).db, {
      brainId: BRAIN,
      task: "postgres storage",
      tokenBudget: 4_000,
      now: NOW,
    });

    expect(result.contextText).toContain('Brain context for task: "postgres storage"');
    expect(result.contextText).toContain("Relevant memories (most relevant first):");
    expect(result.contextText).toContain("[1] (fact) Memory m00 · relevance");
    expect(result.contextText).toContain("via lexical");
    expect(result.memories[0].whyMatched).toContain("lexical");
    expect(result.memories[0].legs).toEqual(["lexical"]);
  });

  it("says so plainly when there is nothing to say", async () => {
    const { db, reads } = fakeDb({});
    const result = await buildContext(db, { brainId: BRAIN, task: "", now: NOW });

    expect(reads).toEqual([]);
    expect(result.memories).toEqual([]);
    expect(result.contextText).toContain("(no memory in this brain matched)");
    expect(result.tokensUsed).toBeLessThanOrEqual(result.usableBudget);
  });

  it("reads memory bodies exactly once, and only for the shortlist", async () => {
    const { db, reads } = brainWith(6);
    await buildContext(db, { brainId: BRAIN, task: "postgres", maxMemories: 2, now: NOW });

    const bodyReads = reads.filter((read) => read.columns.includes("content"));
    expect(bodyReads).toHaveLength(1);
    expect(bodyReads[0].table).toBe("memories");
  });

  it("is deterministic: the same request renders the same package", async () => {
    const params = { brainId: BRAIN, task: "postgres storage", tokenBudget: 900, now: NOW };
    const first = await buildContext(brainWith(12, 90).db, params);
    const second = await buildContext(brainWith(12, 90).db, params);

    expect(second.contextText).toBe(first.contextText);
    expect(second.tokensUsed).toBe(first.tokensUsed);
    expect(second.omitted).toEqual(first.omitted);
  });
});

describe("buildContext — graph, contradictions, provenance", () => {
  const graphed = (derivedEdges: unknown[] = []) =>
    fakeDb({
      lexical: [lexicalRow("m00", 0.9), lexicalRow("m01", 0.8)],
      context: [textRow("m00"), textRow("m01")],
      contextEdges: [{ sourceId: "m00", targetId: "m01", linkType: "supersedes" }],
      derivedEdges,
      sharedEntities: [
        { entityId: "e1", name: "PostgreSQL", type: "technology", memoryIds: ["m01", "m00"] },
      ],
    });

  it("only reads the graph when the caller asked for it", async () => {
    const { db, reads } = graphed();
    const result = await buildContext(db, { brainId: BRAIN, task: "postgres", now: NOW });

    expect(result.graph).toBeNull();
    // The retrieval walk reads `memory_links` too; the engine's own edge read is the
    // one projecting `sourceId`, and it must not happen unless it was asked for.
    expect(
      reads.filter((read) => read.table === "memory_links" && read.columns.includes("sourceId"))
    ).toEqual([]);
    expect(reads.filter((read) => read.table === "memory_derived_links")).toEqual([]);
    expect(result.contextText).not.toContain("Knowledge graph:");
  });

  it("renders edges and shared entities against positions in the same package", async () => {
    const result = await buildContext(graphed().db, {
      brainId: BRAIN,
      task: "postgres",
      includeGraph: true,
      tokenBudget: 4_000,
      now: NOW,
    });

    expect(result.graph?.edges).toEqual([
      { sourceId: "m00", targetId: "m01", linkType: "supersedes", explicit: true },
    ]);
    // Sorted, so the same graph never renders two different ways.
    expect(result.graph?.entities[0].memoryIds).toEqual(["m00", "m01"]);
    expect(result.contextText).toContain("Knowledge graph:");
    expect(result.contextText).toContain("- [1] --supersedes--> [2]");
    expect(result.contextText).toContain("- PostgreSQL (technology) mentioned in [1], [2]");
  });

  it("labels a computed edge as derived and never as an assertion", async () => {
    const { db } = graphed([
      { sourceId: "m00", targetId: "m01", relation: "semantic", weight: 0.62, confidence: 0.45 },
    ]);
    const result = await buildContext(db, {
      brainId: BRAIN,
      task: "postgres",
      includeGraph: true,
      tokenBudget: 4_000,
      now: NOW,
    });

    // Asserted first, computed second, and the two are distinguishable both in the
    // structured graph and in the rendered text (PRINSIP 3).
    expect(result.graph?.edges).toEqual([
      { sourceId: "m00", targetId: "m01", linkType: "supersedes", explicit: true },
      {
        sourceId: "m00",
        targetId: "m01",
        linkType: "derived_semantic",
        explicit: false,
        weight: 0.62,
        confidence: 0.45,
      },
    ]);
    expect(result.contextText).toContain(
      "- [1] --derived_semantic--> [2] (derived, w=0.62 c=0.45)"
    );
    // The asserted edge is rendered bare: no derived suffix may attach to it.
    expect(result.contextText).toContain("- [1] --supersedes--> [2]\n");
  });

  it("reports a contradiction without resolving it", async () => {
    const shared = "deploy aplikasi produksi memakai Vercel Postgres Redis caching";
    const { db } = fakeDb({
      lexical: [lexicalRow("a", 0.9), lexicalRow("b", 0.8)],
      context: [
        textRow("a", { title: "Deploy target", content: `We ${shared} setiap rilis.` }),
        textRow("b", {
          title: "Deploy target moved",
          content: `We no longer ${shared} sejak audit.`,
        }),
      ],
    });

    const result = await buildContext(db, {
      brainId: BRAIN,
      task: "deploy",
      tokenBudget: 4_000,
      now: NOW,
    });

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].memoryId).toBe("b");
    expect(result.contradictions[0].conflictsWithId).toBe("a");
    expect(result.contextText).toContain("Possible contradictions (reported, not resolved):");
  });

  it("attaches provenance only on request", async () => {
    const plain = await buildContext(brainWith(2).db, {
      brainId: BRAIN,
      task: "postgres",
      tokenBudget: 4_000,
      now: NOW,
    });
    expect(plain.memories[0].provenance).toBeUndefined();
    expect(plain.contextText).not.toContain("Provenance:");

    const withProvenance = await buildContext(brainWith(2).db, {
      brainId: BRAIN,
      task: "postgres",
      includeProvenance: true,
      tokenBudget: 4_000,
      now: NOW,
    });
    expect(withProvenance.memories[0].provenance).toMatchObject({
      sourceType: "user",
      confidence: 0.9,
      importance: 0.5,
      validityState: "active",
    });
    expect(withProvenance.contextText).toContain("Provenance:");
    expect(withProvenance.contextText).toContain("source user · confidence 0.90");
  });

  it("marks a superseded memory in its provenance line rather than hiding it", async () => {
    const { db } = fakeDb({
      lexical: [lexicalRow("old", 0.9, { validityState: "superseded" })],
      context: [textRow("old", { validityState: "superseded", supersededById: "new" })],
    });

    const result = await buildContext(db, {
      brainId: BRAIN,
      task: "postgres",
      includeProvenance: true,
      tokenBudget: 4_000,
      now: NOW,
    });

    expect(result.memories[0].provenance?.supersededById).toBe("new");
    expect(result.contextText).toContain("superseded");
  });

  it("never selects a memory the text loader refused to return", async () => {
    // The loader re-applies the tenant and visibility scope. An id it does not answer
    // for is not "omitted" — for this request it does not exist.
    const { db } = fakeDb({
      lexical: [lexicalRow("visible", 0.9), lexicalRow("hidden", 0.8)],
      context: [textRow("visible")],
    });

    const result = await buildContext(db, { brainId: BRAIN, task: "postgres", now: NOW });

    expect(result.memories.map((memory) => memory.id)).toEqual(["visible"]);
    expect(result.omitted.every((row) => row.id !== "hidden")).toBe(true);
    expect(result.contextText).not.toContain("hidden");
  });
});

describe("the SQL and the constants keep the engine's invariants", () => {
  const source = readFileSync("src/features/brain/application/queries/context-engine.ts", "utf8");

  it("never writes anything", () => {
    // Recording that a memory was used is P10's job, and it belongs to the caller
    // that used it — not to the act of assembling context.
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
  });

  it("scopes every read by brain", () => {
    expect(source).toContain("eq(memories.brainId, brainId)");
    expect(source).toContain("eq(memoryLinks.brainId, brainId)");
    expect(source).toContain("eq(memoryMentions.brainId, brainId)");
    expect(source).toContain("eq(brainEntities.brainId, brainId)");
  });

  it("reads bodies by id, for the shortlist only", () => {
    expect(source).toContain("inArray(memories.id, [...ids])");
    expect(source).toContain("isNull(memories.deletedAt)");
  });

  it("budgets in tokens, never in characters", () => {
    expect(source).toContain("usableTokenBudget(tokenBudget)");
    expect(source).toContain("estimateTokens(");
    expect(source).toContain("truncateToTokens(");
    // The old character-budget shape, explicitly ruled out (P3).
    expect(source).not.toMatch(/slice\(0,\s*\w*[Bb]udget/);
    expect(source).not.toMatch(/contentChars\s*[<>]/);
  });

  it("keeps both endpoints of an edge inside the package", () => {
    // A link to a memory the caller cannot see is a dangling reference, not context.
    expect(source).toContain("inArray(memoryLinks.sourceMemoryId, selected)");
    expect(source).toContain("inArray(memoryLinks.targetMemoryId, selected)");
  });

  it("reuses contradiction detection instead of writing a second one", () => {
    expect(source).toContain("detectConflicts(");
    expect(source).not.toMatch(/no longer|NEGATION/);
  });

  it("caps every read and every section", () => {
    expect(source).toContain("limit(GRAPH_EDGE_MAX)");
    expect(source).toContain("limit(GRAPH_ENTITY_MAX)");
    expect(MEMORY_TOKENS_MIN).toBeLessThan(MEMORY_TOKENS_MAX);
    expect(SHORTLIST_FACTOR).toBeGreaterThanOrEqual(1);
    expect(CONTEXT_MAX_MEMORIES_DEFAULT * SHORTLIST_FACTOR).toBeGreaterThan(
      CONTEXT_MAX_MEMORIES_DEFAULT
    );
    expect(REDUNDANCY_THRESHOLD).toBeGreaterThan(0.5);
    expect(REDUNDANCY_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe("brain_recall is left alone", () => {
  const recall = readFileSync("src/features/brain/application/queries/recall.ts", "utf8");

  it("still uses its own package shape and budget", () => {
    // P3 adds a surface; `brain_recall`'s contract predates it and callers depend on
    // its sections. Migrating it is a separate, breaking decision.
    expect(recall).toContain("RECALL_CHAR_BUDGET");
    expect(recall).not.toContain("buildContext");
  });
});
