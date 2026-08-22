import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { analyzeBrainHealth } from "./health-service";
import { CONSOLIDATION_SCAN_MAX } from "./consolidation-service";

/**
 * `brain_health` (P6). A diagnostic surface, so the properties worth pinning are the
 * ones a person would rely on when acting on it: the numbers describe one brain and
 * nothing else, an isolated memory is reported rather than missed, contradictions come
 * from both the recorded links and the shared detector without being double counted,
 * nothing that cannot be resolved is reported or counted, and the whole pass is
 * read-only — health analysis never fixes anything by itself.
 */

type SelectCall = {
  /** `table#projection` — the shape of a read is what identifies it here. */
  key: string;
  table: string;
  columns: string[];
  limit: number | null;
  where: unknown;
};

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
    if (value instanceof Date) {
      parts.push(value.toISOString());
      return;
    }
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

/**
 * The service issues twenty-odd reads, so queueing them by position would be
 * unreadable. Results are keyed by `table#projection` instead — the same key covers
 * repeats of the same read shape, in order.
 *
 * Any write method is fatal: `analyzeBrainHealth` is a diagnostic and must never
 * mutate the brain it is describing.
 */
function recordingDb(queues: Record<string, unknown[][]> = {}) {
  const selects: SelectCall[] = [];
  const cursors = new Map<string, number>();

  const forbid = (verb: string) => () => {
    throw new Error(`health analysis must not ${verb}`);
  };

  const db = {
    insert: forbid("insert"),
    update: forbid("update"),
    delete: forbid("delete"),
    execute: forbid("execute raw sql"),
    transaction: forbid("open a transaction"),
    select(projection?: Record<string, unknown>) {
      const columns = Object.keys(projection ?? {});
      const call: SelectCall = { key: "", table: "", columns, limit: null, where: null };
      const chain = {
        from(table: unknown) {
          call.table = getTableName(table as never);
          call.key = `${call.table}#${columns.join(",")}`;
          return chain;
        },
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        orderBy: () => chain,
        groupBy: () => chain,
        limit(value: number) {
          call.limit = value;
          return chain;
        },
        then<T>(resolve: (value: unknown[]) => T) {
          selects.push(call);
          const index = cursors.get(call.key) ?? 0;
          cursors.set(call.key, index + 1);
          // A count(*) always returns a row, even in an empty brain.
          const fallback = columns.length === 1 && columns[0] === "count" ? [{ count: 0 }] : [];
          return Promise.resolve(queues[call.key]?.[index] ?? fallback).then(resolve);
        },
      };
      return chain;
    },
  };

  return { db: db as unknown as PostgresJsDatabase<typeof schema>, selects };
}

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const MEMORY = getTableName(schema.memories);
const LINKS = getTableName(schema.memoryLinks);
const ENTITIES = getTableName(schema.brainEntities);

/** The eight `count(*)` reads on `memories`, answered in this order. */
const COUNTS = `${MEMORY}#count`;
const LINK_COUNT = `${LINKS}#count`;
const ENTITY_COUNT = `${ENTITIES}#count`;
/** The active-memory id list that orphan and weak-link detection is measured against. */
const ACTIVE_IDS = `${MEMORY}#id`;
const GRAPH_LINKS = `${LINKS}#sourceMemoryId,targetMemoryId,linkType`;
const CONTRADICTION_LINKS = `${LINKS}#sourceMemoryId,targetMemoryId`;
const CANDIDATES = `${MEMORY}#id,type,title,content,summary`;
/** `id,title` reads, in order: contradiction titles, orphans, weak links, unconfirmed. */
const TITLES = `${MEMORY}#id,title`;
const LOW_CONFIDENCE = `${MEMORY}#id,title,confidence`;
const STALE = `${MEMORY}#id,title,updatedAt`;

type CountName =
  | "total"
  | "active"
  | "archived"
  | "superseded"
  | "stale"
  | "lowConfidence"
  | "unconfirmed"
  | "agentCreated";

const COUNT_ORDER: CountName[] = [
  "total",
  "active",
  "archived",
  "superseded",
  "stale",
  "lowConfidence",
  "unconfirmed",
  "agentCreated",
];

function counts(overrides: Partial<Record<CountName, number>> = {}): unknown[][] {
  return COUNT_ORDER.map((name) => [{ count: overrides[name] ?? 0 }]);
}

const ids = (...values: string[]) => values.map((id) => ({ id }));
const titled = (id: string, title: string) => ({ id, title });
const memoryLink = (source: string, target: string | null, linkType = "related_to") => ({
  sourceMemoryId: source,
  targetMemoryId: target,
  linkType,
});

describe("analyzeBrainHealth — metrics", () => {
  it("reports each class of memory from its own count and derives links per memory", async () => {
    const { db } = recordingDb({
      [COUNTS]: counts({
        total: 10,
        active: 7,
        archived: 2,
        superseded: 1,
        stale: 3,
        lowConfidence: 4,
        unconfirmed: 5,
        agentCreated: 6,
      }),
      [LINK_COUNT]: [[{ count: 8 }]],
      [ENTITY_COUNT]: [[{ count: 9 }]],
    });

    const { metrics } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics).toMatchObject({
      brainId: BRAIN,
      totalMemories: 10,
      activeMemories: 7,
      archivedMemories: 2,
      supersededMemories: 1,
      staleMemories: 3,
      lowConfidenceMemories: 4,
      unconfirmedMemories: 5,
      agentCreatedMemories: 6,
      totalLinks: 8,
      totalEntities: 9,
      avgLinksPerMemory: 0.8,
    });
  });

  it("does not divide by zero in an empty brain", async () => {
    const { db } = recordingDb({ [LINK_COUNT]: [[{ count: 0 }]] });
    const { metrics, issues } = await analyzeBrainHealth(db, BRAIN);

    expect(metrics.totalMemories).toBe(0);
    expect(metrics.avgLinksPerMemory).toBe(0);
    expect(issues).toEqual([]);
  });

  it("fences every read to the one brain it was asked about", async () => {
    const { db, selects } = recordingDb({
      [COUNTS]: counts({ total: 2, active: 2 }),
      [ACTIVE_IDS]: [ids(A, B)],
      [GRAPH_LINKS]: [[memoryLink(A, B)]],
      [TITLES]: [[titled(A, "One"), titled(B, "Two")]],
    });
    await analyzeBrainHealth(db, BRAIN);

    expect(selects.length).toBeGreaterThan(10);
    for (const call of selects) {
      expect(describeSql(call.where)).toContain(BRAIN);
      expect(describeSql(call.where)).not.toContain(OTHER_BRAIN);
    }
  });

  it("echoes the staleness threshold it was given and measures it from update or access", async () => {
    const { db, selects } = recordingDb({});
    const { metrics } = await analyzeBrainHealth(db, BRAIN, 45);

    expect(metrics.staleDays).toBe(45);
    const staleCount = selects.filter((call) => call.key === COUNTS)[4];
    const where = describeSql(staleCount.where);
    expect(where).toContain("GREATEST");
    expect(where).toContain("COALESCE");
    expect(where).toContain("updated_at");
    expect(where).toContain("last_accessed_at");
    expect(where).toContain("active");
  });
});

describe("analyzeBrainHealth — structure", () => {
  /** A—B—C, and D linked to nothing. */
  const shape = {
    [COUNTS]: counts({ total: 4, active: 4 }),
    [ACTIVE_IDS]: [ids(A, B, C, D)],
    [GRAPH_LINKS]: [[memoryLink(A, B), memoryLink(B, C)]],
    [TITLES]: [[titled(D, "Island")], [titled(A, "One"), titled(C, "Three")]],
  };

  it("separates an unconnected memory from a barely connected one", async () => {
    const { db } = recordingDb(shape);
    const { metrics } = await analyzeBrainHealth(db, BRAIN);

    expect(metrics.orphanMemories).toBe(1);
    expect(metrics.weaklyConnectedMemories).toBe(2);
  });

  it("counts each orphan as its own cluster alongside the connected one", async () => {
    const { db } = recordingDb(shape);
    expect((await analyzeBrainHealth(db, BRAIN)).metrics.isolatedClusters).toBe(2);
  });

  it("reports the orphan as a knowledge gap rather than hiding it", async () => {
    const { db } = recordingDb(shape);
    const { issues } = await analyzeBrainHealth(db, BRAIN);

    expect(issues.find((issue) => issue.type === "orphan")).toMatchObject({
      severity: "medium",
      memoryId: D,
      memoryTitle: "Island",
    });
    expect(issues.filter((issue) => issue.type === "weak_link").map((issue) => issue.memoryId)).toEqual([A, C]);
  });

  it("treats a memory with no link row as degree zero, not as an absent node", async () => {
    // The adjacency list never mentions an unlinked memory, so orphans have to be
    // measured against the active list — otherwise the most isolated memories in the
    // brain are exactly the ones that go unreported.
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 3, active: 3 }),
      [ACTIVE_IDS]: [ids(A, B, C)],
      [GRAPH_LINKS]: [[]],
      [TITLES]: [[titled(A, "One"), titled(B, "Two"), titled(C, "Three")]],
    });

    const { metrics, issues } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics.orphanMemories).toBe(3);
    expect(metrics.isolatedClusters).toBe(3);
    expect(issues.every((issue) => issue.type === "orphan")).toBe(true);
  });

  it("does not treat an entity-anchored link row as a connection between memories", async () => {
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 1, active: 1 }),
      [ACTIVE_IDS]: [ids(A)],
      [GRAPH_LINKS]: [[memoryLink(A, null, "mentions")]],
      [TITLES]: [[titled(A, "One")]],
    });

    const { metrics } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics.orphanMemories).toBe(1);
  });

  it("reads only this brain's memory-anchored links to build the graph", async () => {
    const { db, selects } = recordingDb(shape);
    await analyzeBrainHealth(db, BRAIN);

    const where = describeSql(selects.find((call) => call.key === GRAPH_LINKS)!.where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("memory");
  });
});

/** Two same-type memories that say the same thing, one of them negated. */
const NEGATED = {
  id: A,
  type: "fact",
  title: "Deploy target moved",
  content: "We no longer deploy the api on Vercel for every release",
  summary: null,
};
const ORIGINAL = {
  id: B,
  type: "fact",
  title: "Deploy target",
  content: "We deploy the api on Vercel for every release",
  summary: null,
};

describe("analyzeBrainHealth — contradictions", () => {
  it("reports a recorded contradiction, naming both sides", async () => {
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 2, active: 2 }),
      [ACTIVE_IDS]: [ids(A, B)],
      [GRAPH_LINKS]: [[memoryLink(A, B, "contradicts")]],
      [CONTRADICTION_LINKS]: [[{ sourceMemoryId: A, targetMemoryId: B }]],
      [TITLES]: [[titled(A, "Vercel"), titled(B, "Hetzner")], []],
    });

    const { metrics, issues } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics.contradictionCount).toBe(1);
    expect(issues[0]).toMatchObject({
      type: "contradiction",
      severity: "high",
      memoryId: A,
      memoryTitle: "Vercel",
      conflictsWith: { id: B, title: "Hetzner" },
    });
    expect(issues[0].reason).toContain("Recorded");
  });

  it("also finds a contradiction nobody recorded, through the shared detector", async () => {
    // A brain that has never run consolidation still sees its conflicts, and the
    // definition of "conflict" is the consolidation service's, not a second one.
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 2, active: 2 }),
      [ACTIVE_IDS]: [ids(A, B)],
      [CANDIDATES]: [[NEGATED, ORIGINAL]],
      [TITLES]: [[titled(A, NEGATED.title), titled(B, ORIGINAL.title)], [], []],
    });

    const { metrics, issues } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics.contradictionCount).toBe(1);
    expect(issues[0]).toMatchObject({
      type: "contradiction",
      severity: "high",
      memoryId: A,
      conflictsWith: { id: B, title: ORIGINAL.title },
    });
    expect(issues[0].reason).toContain("word overlap");
    expect(issues[0].reason).toContain("no longer");
  });

  it("counts a pair once when the link and the detector agree, keeping the record", async () => {
    // The link row was written deliberately, so its reason survives; the detector's
    // reading of the same pair, in either order, must not become a second issue.
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 2, active: 2 }),
      [ACTIVE_IDS]: [ids(A, B)],
      [CONTRADICTION_LINKS]: [[{ sourceMemoryId: B, targetMemoryId: A }]],
      [CANDIDATES]: [[NEGATED, ORIGINAL]],
      [TITLES]: [[titled(A, NEGATED.title), titled(B, ORIGINAL.title)], [], []],
    });

    const { metrics, issues } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics.contradictionCount).toBe(1);
    expect(issues.filter((issue) => issue.type === "contradiction")).toHaveLength(1);
    expect(issues[0].reason).toContain("Recorded");
  });

  it("neither reports nor counts a contradiction it cannot resolve", async () => {
    // The other side is deleted or in another brain. Reporting it would put a memory
    // this brain cannot see into its health report; counting it would leave the metric
    // disagreeing with the list.
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 1, active: 1 }),
      [ACTIVE_IDS]: [ids(A)],
      [CONTRADICTION_LINKS]: [[{ sourceMemoryId: A, targetMemoryId: B }]],
      [TITLES]: [[titled(A, "Vercel")], [titled(A, "Vercel")]],
    });

    const { metrics, issues } = await analyzeBrainHealth(db, BRAIN);
    expect(metrics.contradictionCount).toBe(0);
    expect(issues.some((issue) => issue.type === "contradiction")).toBe(false);
  });

  it("ignores a contradiction link that does not point at a memory", async () => {
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 1, active: 1 }),
      [ACTIVE_IDS]: [ids(A)],
      [CONTRADICTION_LINKS]: [[{ sourceMemoryId: A, targetMemoryId: null }]],
      [TITLES]: [[titled(A, "Vercel")]],
    });

    expect((await analyzeBrainHealth(db, BRAIN)).metrics.contradictionCount).toBe(0);
  });

  it("resolves contradiction titles inside the brain, excluding deleted rows", async () => {
    const { db, selects } = recordingDb({
      [COUNTS]: counts({ total: 2, active: 2 }),
      [ACTIVE_IDS]: [ids(A, B)],
      [CONTRADICTION_LINKS]: [[{ sourceMemoryId: A, targetMemoryId: B }]],
      [TITLES]: [[titled(A, "Vercel"), titled(B, "Hetzner")], []],
    });
    await analyzeBrainHealth(db, BRAIN);

    const where = describeSql(selects.filter((call) => call.key === TITLES)[0].where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("deleted_at");
    expect(where).toContain(A);
    expect(where).toContain(B);
  });

  it("bounds the conflict scan instead of reading the whole brain", async () => {
    const { db, selects } = recordingDb({ [COUNTS]: counts({ total: 5000, active: 5000 }) });
    await analyzeBrainHealth(db, BRAIN);

    const scan = selects.find((call) => call.key === CANDIDATES)!;
    expect(scan.limit).toBe(CONSOLIDATION_SCAN_MAX);
    const where = describeSql(scan.where);
    expect(where).toContain("active");
    expect(where).toContain("deleted_at");
    expect(where).toContain("archived_at");
  });
});

describe("analyzeBrainHealth — quality signals", () => {
  it("flags a low-confidence memory with the number that made it one", async () => {
    const { db, selects } = recordingDb({
      [COUNTS]: counts({ total: 1, active: 1, lowConfidence: 1 }),
      [LOW_CONFIDENCE]: [[{ id: A, title: "A guess", confidence: 0.2 }]],
    });

    const { issues } = await analyzeBrainHealth(db, BRAIN, 180, 0.5);
    expect(issues[0]).toMatchObject({ type: "low_confidence", severity: "medium", memoryId: A });
    expect(issues[0].reason).toContain("0.20");
    expect(issues[0].reason).toContain("0.5");

    const where = describeSql(selects.find((call) => call.key === LOW_CONFIDENCE)!.where);
    expect(where).toContain("0.5");
    expect(where).toContain("active");
  });

  it("flags a memory nothing has ever confirmed", async () => {
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 1, active: 1, unconfirmed: 1 }),
      [TITLES]: [[titled(A, "Never checked")]],
    });

    const { issues } = await analyzeBrainHealth(db, BRAIN);
    expect(issues).toEqual([
      {
        type: "unconfirmed",
        severity: "low",
        memoryId: A,
        memoryTitle: "Never checked",
        reason: "Never confirmed by user or agent.",
      },
    ]);
  });

  it("says how long a stale memory has been untouched, and never deletes it", async () => {
    const updatedAt = new Date(Date.now() - 200 * 86_400_000);
    const { db } = recordingDb({
      [COUNTS]: counts({ total: 1, active: 1, stale: 1 }),
      [STALE]: [[{ id: A, title: "Old runbook", updatedAt }]],
    });

    const { issues } = await analyzeBrainHealth(db, BRAIN, 180);
    expect(issues[0]).toMatchObject({ type: "stale", severity: "low", memoryId: A });
    expect(issues[0].reason).toContain("200 days");
  });
});

describe("analyzeBrainHealth — what a truncated report keeps", () => {
  /** One contradiction (high), two orphans (medium), two weak links (low). */
  const mixed = {
    [COUNTS]: counts({ total: 4, active: 4 }),
    [ACTIVE_IDS]: [ids(A, B, C, D)],
    [GRAPH_LINKS]: [[memoryLink(C, D)]],
    [CONTRADICTION_LINKS]: [[{ sourceMemoryId: A, targetMemoryId: B }]],
    [TITLES]: [
      [titled(A, "Vercel"), titled(B, "Hetzner")],
      [titled(A, "Vercel"), titled(B, "Hetzner")],
      [titled(C, "Runbook"), titled(D, "Notes")],
      [],
    ],
  };

  it("orders issues by severity, most serious first", async () => {
    const { db } = recordingDb(mixed);
    const { issues } = await analyzeBrainHealth(db, BRAIN);

    expect(issues.map((issue) => issue.severity)).toEqual([
      "high",
      "medium",
      "medium",
      "low",
      "low",
    ]);
  });

  it("keeps the contradiction when maxIssues leaves room for only one issue", async () => {
    // Low-severity noise is plentiful and cheap to find; a contradiction is the one
    // thing the report exists to surface, so truncation must not spend the budget on
    // orphans collected afterwards.
    const { db } = recordingDb(mixed);
    const { issues } = await analyzeBrainHealth(db, BRAIN, 180, 0.5, 1);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("contradiction");
  });

  it("diagnoses without writing anything", async () => {
    // The recorder throws on any insert, update, delete, raw execute or transaction:
    // health analysis reports problems, it never resolves them (contradictions in
    // particular are resolved only through an explicit review decision).
    const { db } = recordingDb(mixed);
    await expect(analyzeBrainHealth(db, BRAIN)).resolves.toBeDefined();
  });
});
