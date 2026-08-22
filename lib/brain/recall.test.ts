import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

/**
 * brain_recall — the read side of the agent memory protocol.
 *
 * An agent's context window is the scarce resource here, so recall is bounded by
 * construction: every section has a row cap, every text field is truncated to a
 * snippet, a memory that already appeared in one section never burns budget again in
 * another, and the rendered package is clipped to a character budget with `truncated`
 * telling the caller it happened.
 *
 * The other property asserted here is the one that makes standing rules work:
 * instructions and preferences deliberately ignore the project filter — they are
 * brain-wide rules that apply to every task — while relevant/important/recent honour
 * it. And every statement, in all five sections, names the brain.
 */

type Rows = Record<string, unknown[][]>;
type ReadCall = { table: string; limit: number | null; where: unknown; order: unknown };

/** Flatten a Drizzle predicate into a searchable string (columns hold circular refs). */
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

const reads: ReadCall[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();

function selectChain() {
  const call: ReadCall = { table: "", limit: null, where: null, order: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy(...args: unknown[]) {
      call.order = args;
      return chain;
    },
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T) {
      reads.push(call);
      const index = cursors.get(call.table) ?? 0;
      cursors.set(call.table, index + 1);
      return Promise.resolve(rows[call.table]?.[index] ?? []).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/db", () => ({ db: { select: () => selectChain() } }));

const { recallBrainContext, RECALL_CHAR_BUDGET } = await import("./recall");
const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const MEMORY_TABLE = getTableName(schema.memories);
const ENTITY_TABLE = getTableName(schema.brainEntities);
const EDGE_TABLE = getTableName(schema.brainRelationships);

const memoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: "memory-1",
  type: "fact",
  title: "Deploy notes",
  summary: null,
  content: "Run update.sh on the VPS",
  importance: 0.5,
  confidence: 0.9,
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  ...overrides,
});

const entityRow = (overrides: Record<string, unknown> = {}) => ({
  id: "entity-1",
  brainId: BRAIN,
  name: "Redis",
  type: "technology",
  description: "queue backend",
  ...overrides,
});

/** Queue the four memory sections in the order recall issues them. */
function memorySections(sections: {
  directives?: unknown[];
  relevant?: unknown[];
  important?: unknown[];
  recent?: unknown[];
  withQuery?: boolean;
}): void {
  const queue = [sections.directives ?? []];
  if (sections.withQuery !== false) queue.push(sections.relevant ?? []);
  queue.push(sections.important ?? [], sections.recent ?? []);
  rows[MEMORY_TABLE] = queue;
}

const readsOf = (table: string): ReadCall[] => reads.filter((call) => call.table === table);
const readOf = (table: string, index = 0): ReadCall | undefined => readsOf(table)[index];

beforeEach(() => {
  reads.length = 0;
  rows = {};
  cursors.clear();
});

describe("the five sections", () => {
  it("issues one capped query per section, in prompt order", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[]];

    await recallBrainContext({ brainId: BRAIN, query: "redis queue" });

    const memoryReads = readsOf(MEMORY_TABLE);
    expect(memoryReads.map((read) => read.limit)).toEqual([8, 8, 5, 5]);
    // The entity section only runs once there is a query to match names against.
    expect(readsOf(ENTITY_TABLE)).toHaveLength(1);
    expect(readOf(ENTITY_TABLE)!.limit).toBe(8);
  });

  it("reads only live memories: neither deleted nor archived", async () => {
    memorySections({});

    await recallBrainContext({ brainId: BRAIN });

    for (const read of readsOf(MEMORY_TABLE)) {
      const predicate = describeSql(read.where);
      expect(predicate).toContain("deleted_at");
      expect(predicate).toContain("archived_at");
    }
  });

  it("takes directives from instructions and preferences only, most important first", async () => {
    memorySections({});

    await recallBrainContext({ brainId: BRAIN });

    const directives = readOf(MEMORY_TABLE, 0)!;
    const predicate = describeSql(directives.where);
    expect(predicate).toContain("instruction");
    expect(predicate).toContain("preference");
    const order = describeSql(directives.order);
    expect(order).toContain("importance");
    expect(order).toContain("updated_at");
  });

  it("gates the important section on a threshold, not on the query", async () => {
    memorySections({});

    await recallBrainContext({ brainId: BRAIN, query: "redis" });

    const important = describeSql(readOf(MEMORY_TABLE, 2)!.where);
    expect(important).toContain("0.7");
    expect(important).not.toContain("to_tsquery");
  });

  it("ranks the relevant section by full-text relevance, then importance", async () => {
    memorySections({});

    await recallBrainContext({ brainId: BRAIN, query: "redis queue" });

    const relevant = readOf(MEMORY_TABLE, 1)!;
    expect(describeSql(relevant.where)).toContain("search_vector");
    const order = describeSql(relevant.order);
    expect(order).toContain("ts_rank");
    expect(order).toContain("importance");
  });

  it("orders the recent section by nothing but recency", async () => {
    memorySections({});

    await recallBrainContext({ brainId: BRAIN });

    const recent = readOf(MEMORY_TABLE, 2)!;
    expect(describeSql(recent.order)).toContain("updated_at");
    expect(describeSql(recent.order)).not.toContain("importance");
  });
});

describe("standing rules are brain-wide, the rest is project-scoped", () => {
  it("keeps the project out of the directive query and in the other three", async () => {
    // An instruction like "always answer in English" applies to every task; filtering
    // it by project would silently drop the user's standing rules.
    memorySections({});
    rows[ENTITY_TABLE] = [[]];

    await recallBrainContext({ brainId: BRAIN, query: "redis", projectId: PROJECT });

    const [directives, relevant, important, recent] = readsOf(MEMORY_TABLE);
    expect(describeSql(directives.where)).not.toContain(PROJECT);
    for (const read of [relevant, important, recent]) {
      expect(describeSql(read.where)).toContain(PROJECT);
    }
  });

  it("adds no project predicate at all when none was given", async () => {
    memorySections({});

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.projectId).toBeNull();
    for (const read of readsOf(MEMORY_TABLE)) {
      expect(describeSql(read.where)).not.toContain("project_id");
    }
  });
});

describe("no memory is paid for twice", () => {
  it("keeps a memory in the first section that claimed it", async () => {
    // The same row legitimately comes back as a directive, an important memory and a
    // recent one; showing it three times would spend the budget on one fact.
    const shared = memoryRow({ id: "memory-shared", type: "instruction", importance: 0.9 });
    memorySections({
      directives: [shared],
      relevant: [shared],
      important: [shared],
      recent: [shared, memoryRow({ id: "memory-2" })],
      withQuery: false,
    });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.directives.map((row) => row.id)).toEqual(["memory-shared"]);
    expect(pkg.important).toEqual([]);
    expect(pkg.recent.map((row) => row.id)).toEqual(["memory-2"]);
    expect(pkg.contextText.match(/memory-shared/g)).toBeNull();
    expect(pkg.contextText.split("Deploy notes").length - 1).toBe(2);
  });

  it("dedupes within a section too", async () => {
    memorySections({
      recent: [memoryRow({ id: "memory-1" }), memoryRow({ id: "memory-1" })],
      withQuery: false,
    });

    const pkg = await recallBrainContext({ brainId: BRAIN });
    expect(pkg.recent).toHaveLength(1);
  });
});

describe("snippets", () => {
  it("prefers the summary, and falls back to the content when it is blank", async () => {
    memorySections({
      recent: [
        memoryRow({ id: "a", summary: "  short summary  ", content: "long content" }),
        memoryRow({ id: "b", summary: "   ", content: "long content" }),
        memoryRow({ id: "c", summary: null, content: "long content" }),
      ],
      withQuery: false,
    });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.recent.map((row) => row.snippet)).toEqual([
      "short summary",
      "long content",
      "long content",
    ]);
  });

  it("collapses whitespace so a wall of newlines cannot pad the budget", async () => {
    memorySections({
      recent: [memoryRow({ content: "line one\n\n\n   line two\t\tend" })],
      withQuery: false,
    });

    const pkg = await recallBrainContext({ brainId: BRAIN });
    expect(pkg.recent[0].snippet).toBe("line one line two end");
  });

  it("truncates a long body to 400 characters, ellipsis included", async () => {
    memorySections({ recent: [memoryRow({ content: "x".repeat(5000) })], withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.recent[0].snippet).toHaveLength(400);
    expect(pkg.recent[0].snippet.endsWith("…")).toBe(true);
  });

  it("leaves a body that exactly fits alone", async () => {
    memorySections({ recent: [memoryRow({ content: "x".repeat(400) })], withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN });
    expect(pkg.recent[0].snippet).toBe("x".repeat(400));
  });

  it("hands back timestamps as ISO strings, not Date objects", async () => {
    memorySections({ recent: [memoryRow()], withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN });
    expect(pkg.recent[0].updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });
});

describe("the query", () => {
  it("skips the relevant and entity sections entirely when there is none", async () => {
    memorySections({ withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.query).toBeNull();
    expect(pkg.relevant).toEqual([]);
    expect(pkg.entities).toEqual([]);
    expect(readsOf(MEMORY_TABLE)).toHaveLength(3);
    expect(readsOf(ENTITY_TABLE)).toHaveLength(0);
    expect(readsOf(EDGE_TABLE)).toHaveLength(0);
  });

  it("treats a whitespace-only query as no query at all", async () => {
    memorySections({ withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "   " });

    expect(pkg.query).toBeNull();
    expect(readsOf(MEMORY_TABLE)).toHaveLength(3);
  });

  it("trims the query it reports back and searches with", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[]];

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "  redis queue  " });

    expect(pkg.query).toBe("redis queue");
    expect(describeSql(readOf(MEMORY_TABLE, 1)!.where)).toContain("redis queue");
  });
});

describe("the character budget", () => {
  it("defaults to 6000 and reports an untruncated package as such", async () => {
    memorySections({ recent: [memoryRow()], withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(RECALL_CHAR_BUDGET).toBe(6000);
    expect(pkg.truncated).toBe(false);
    expect(pkg.contextText.endsWith("…")).toBe(false);
  });

  it("clips to the requested budget and says it did", async () => {
    memorySections({
      recent: Array.from({ length: 5 }, (_, index) =>
        memoryRow({ id: `memory-${index}`, content: "y".repeat(300) })
      ),
      withQuery: false,
    });

    const pkg = await recallBrainContext({ brainId: BRAIN, charBudget: 200 });

    expect(pkg.truncated).toBe(true);
    expect(pkg.contextText).toHaveLength(200);
    expect(pkg.contextText.endsWith("…")).toBe(true);
  });

  it("never exceeds the default budget either, however much came back", async () => {
    const filler = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        memoryRow({ id: `${prefix}-${index}`, content: "z".repeat(2000) })
      );
    memorySections({
      directives: filler("d", 8),
      important: filler("i", 5),
      recent: filler("r", 5),
      withQuery: false,
    });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.contextText.length).toBeLessThanOrEqual(RECALL_CHAR_BUDGET);
    expect(pkg.truncated).toBe(true);
    // The structured sections are still complete — only the rendered text is clipped.
    expect(pkg.directives).toHaveLength(8);
    expect(pkg.recent).toHaveLength(5);
  });

  it("leaves a package that exactly fits the budget alone", async () => {
    memorySections({ recent: [memoryRow()], withQuery: false });
    const exact = (await recallBrainContext({ brainId: BRAIN })).contextText.length;

    // Each call consumes the queued rows, so the second run needs its own.
    cursors.clear();
    memorySections({ recent: [memoryRow()], withQuery: false });
    const pkg = await recallBrainContext({ brainId: BRAIN, charBudget: exact });

    expect(pkg.truncated).toBe(false);
    expect(pkg.contextText).toHaveLength(exact);
  });
});

describe("the graph section", () => {
  it("matches entity names on word boundaries, not on substrings", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow()]];
    rows[EDGE_TABLE] = [[]];

    await recallBrainContext({ brainId: BRAIN, query: "Redis queue latency" });

    const predicate = describeSql(readOf(ENTITY_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    // "redis" must not also drag in a node merely containing those letters.
    expect(predicate).toContain("(^|[^[:alnum:]])(redis|queue|latency)([^[:alnum:]]|$)");
    expect(describeSql(readOf(ENTITY_TABLE)!.order)).toContain("updated_at");
  });

  it("ignores words shorter than three characters", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow()]];
    rows[EDGE_TABLE] = [[]];

    await recallBrainContext({ brainId: BRAIN, query: "is my db up" });

    // Every word is too short to be a useful node name, so no graph query runs at all.
    expect(readsOf(ENTITY_TABLE)).toHaveLength(0);
  });

  it("does not look for edges when no node matched", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[]];

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "redis" });

    expect(pkg.entities).toEqual([]);
    expect(readsOf(EDGE_TABLE)).toHaveLength(0);
  });

  it("reads edges on either end of the matched nodes, capped", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow(), entityRow({ id: "entity-2", name: "Queue" })]];
    rows[EDGE_TABLE] = [[]];

    await recallBrainContext({ brainId: BRAIN, query: "redis queue" });

    const edges = readOf(EDGE_TABLE)!;
    const predicate = describeSql(edges.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("entity-1");
    expect(predicate).toContain("entity-2");
    expect(predicate).toContain("source_entity_id");
    expect(predicate).toContain("target_entity_id");
    expect(edges.limit).toBe(40);
  });

  it("labels each edge with its direction and the name at the far end", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow(), entityRow({ id: "entity-2", name: "Queue" })]];
    rows[EDGE_TABLE] = [
      [
        { sourceId: "entity-1", targetId: "entity-2", type: "depends_on" },
        { sourceId: "entity-2", targetId: "entity-1", type: "feeds" },
      ],
    ];

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "redis queue" });

    expect(pkg.entities[0]).toEqual({
      id: "entity-1",
      name: "Redis",
      type: "technology",
      description: "queue backend",
      relationships: [
        { type: "depends_on", direction: "outgoing", entity: "Queue" },
        { type: "feeds", direction: "incoming", entity: "Queue" },
      ],
    });
    // Both nodes were already in the matched set, so no name lookup was needed.
    expect(readsOf(ENTITY_TABLE)).toHaveLength(1);
  });

  it("resolves a far end outside the matched set, in this brain only", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow()], [{ id: "entity-9", name: "Worker" }]];
    rows[EDGE_TABLE] = [[{ sourceId: "entity-1", targetId: "entity-9", type: "runs_on" }]];

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "redis" });

    expect(pkg.entities[0].relationships).toEqual([
      { type: "runs_on", direction: "outgoing", entity: "Worker" },
    ]);
    const lookup = readOf(ENTITY_TABLE, 1)!;
    const predicate = describeSql(lookup.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("entity-9");
    expect(predicate).not.toContain("entity-1");
  });

  it("says unknown rather than dropping an edge whose far end it cannot name", async () => {
    // Dropping it would understate the node's degree; inventing a name would be worse.
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow()], []];
    rows[EDGE_TABLE] = [[{ sourceId: "entity-1", targetId: "entity-9", type: "runs_on" }]];

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "redis" });

    expect(pkg.entities[0].relationships).toEqual([
      { type: "runs_on", direction: "outgoing", entity: "unknown" },
    ]);
  });
});

describe("the rendered context an agent pastes into a prompt", () => {
  it("labels every section, and names the query in the relevant one", async () => {
    memorySections({
      directives: [memoryRow({ id: "d1", type: "instruction", content: "Answer in English" })],
      relevant: [memoryRow({ id: "r1", content: "Redis is the queue backend" })],
      important: [memoryRow({ id: "i1", content: "Postgres is canonical" })],
      recent: [memoryRow({ id: "n1", content: "Rebuilt the VPS" })],
    });
    rows[ENTITY_TABLE] = [[entityRow()]];
    rows[EDGE_TABLE] = [[{ sourceId: "entity-1", targetId: "entity-1", type: "self" }]];

    const { contextText } = await recallBrainContext({ brainId: BRAIN, query: "redis" });

    expect(contextText.startsWith("Brain context:")).toBe(true);
    expect(contextText).toContain("Standing instructions and preferences:");
    expect(contextText).toContain('Relevant to "redis":');
    expect(contextText).toContain("Important long-term memories:");
    expect(contextText).toContain("Recently updated:");
    expect(contextText).toContain("Related knowledge graph:");
    expect(contextText).toContain("- [instruction] Deploy notes: Answer in English");
  });

  it("draws each edge with its direction", async () => {
    memorySections({});
    rows[ENTITY_TABLE] = [[entityRow(), entityRow({ id: "entity-2", name: "Queue" })]];
    rows[EDGE_TABLE] = [
      [
        { sourceId: "entity-1", targetId: "entity-2", type: "depends_on" },
        { sourceId: "entity-2", targetId: "entity-1", type: "feeds" },
      ],
    ];

    const { contextText } = await recallBrainContext({ brainId: BRAIN, query: "redis queue" });

    expect(contextText).toContain("- Redis (technology) --depends_on--> Queue; <--feeds-- Queue");
  });

  it("omits sections that came back empty", async () => {
    memorySections({ recent: [memoryRow()], withQuery: false });

    const { contextText } = await recallBrainContext({ brainId: BRAIN });

    expect(contextText).toContain("Recently updated:");
    expect(contextText).not.toContain("Standing instructions");
    expect(contextText).not.toContain("Related knowledge graph:");
  });

  it("says so plainly when the brain is empty, instead of returning a bare heading", async () => {
    memorySections({ withQuery: false });

    const pkg = await recallBrainContext({ brainId: BRAIN });

    expect(pkg.contextText).toContain("(this brain has no memories yet)");
    expect(pkg.truncated).toBe(false);
  });
});

describe("the brain id is folded into every statement", () => {
  it("names this brain in all four memory queries and all three graph queries", async () => {
    memorySections({
      directives: [memoryRow({ id: "d1", type: "instruction" })],
      relevant: [memoryRow({ id: "r1" })],
      important: [memoryRow({ id: "i1" })],
      recent: [memoryRow({ id: "n1" })],
    });
    rows[ENTITY_TABLE] = [[entityRow()], [{ id: "entity-9", name: "Worker" }]];
    rows[EDGE_TABLE] = [[{ sourceId: "entity-1", targetId: "entity-9", type: "runs_on" }]];

    const pkg = await recallBrainContext({ brainId: BRAIN, query: "redis", projectId: PROJECT });

    expect(pkg.brainId).toBe(BRAIN);
    expect(reads).toHaveLength(7);
    for (const read of reads) {
      const predicate = describeSql(read.where);
      expect(predicate, `read of ${read.table}`).toContain(BRAIN);
      expect(predicate, `read of ${read.table}`).not.toContain(OTHER_BRAIN);
    }
  });
});

