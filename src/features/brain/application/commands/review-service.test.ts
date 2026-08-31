import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import type { BrainHealthReport, HealthIssue } from "@brain/application/queries/health-service";
import {
  listReviewItems,
  resolveReviewItem,
  reviewDedupeKey,
  syncReviewQueue,
  upsertReviewItems,
} from "./review-service";

/**
 * The review queue is where findings become durable, so these tests are about the
 * three properties that make it usable rather than annoying: a re-scan updates
 * instead of flooding, a human decision is never overwritten by a machine, and no
 * statement crosses a brain boundary.
 *
 * There is no live Postgres here — the database is a recorder that captures each
 * statement's shape and executes nothing.
 */

type InsertCall = {
  table: string;
  values: Record<string, unknown>[];
  conflictTarget: string[];
  conflictSet: Record<string, unknown>;
};
type UpdateCall = { table: string; set: Record<string, unknown>; where: unknown };
type SelectCall = { table: string; columns: string[]; limit: number | null; where: unknown };

type Recorder = {
  db: PostgresJsDatabase<typeof schema>;
  inserts: InsertCall[];
  updates: UpdateCall[];
  selects: SelectCall[];
};

function columnNames(columns: unknown[]): string[] {
  return columns.map((column) => String((column as { name?: string }).name ?? column));
}

/**
 * Flatten a Drizzle predicate into a searchable string. `JSON.stringify` cannot be
 * used: a column holds a back-reference to its table, so the structure is circular.
 */
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

function recordingDb(options: { rows?: Record<string, unknown[]>; updated?: unknown[] } = {}): Recorder {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  const selects: SelectCall[] = [];
  const rows = options.rows ?? {};

  const db = {
    insert(table: unknown) {
      const call: InsertCall = {
        table: getTableName(table as never),
        values: [],
        conflictTarget: [],
        conflictSet: {},
      };
      const chain = {
        onConflictDoUpdate(clause: { target: unknown[]; set: Record<string, unknown> }) {
          call.conflictTarget = columnNames(clause.target);
          call.conflictSet = clause.set;
          return chain;
        },
        then<T>(resolve: (value: unknown) => T) {
          inserts.push(call);
          return Promise.resolve([]).then(resolve);
        },
      };
      return {
        values(values: Record<string, unknown> | Record<string, unknown>[]) {
          call.values = Array.isArray(values) ? values : [values];
          return chain;
        },
      };
    },

    update(table: unknown) {
      const call: UpdateCall = { table: getTableName(table as never), set: {}, where: null };
      return {
        set(values: Record<string, unknown>) {
          call.set = values;
          return {
            where(condition: unknown) {
              call.where = condition;
              return {
                returning() {
                  updates.push(call);
                  return Promise.resolve(options.updated ?? [{ id: "row" }]);
                },
              };
            },
          };
        },
      };
    },

    select(projection?: Record<string, unknown>) {
      const call: SelectCall = {
        table: "",
        columns: Object.keys(projection ?? {}),
        limit: null,
        where: null,
      };
      const chain = {
        from(table: unknown) {
          call.table = getTableName(table as never);
          return chain;
        },
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        groupBy: () => chain,
        orderBy: () => chain,
        limit(value: number) {
          call.limit = value;
          return chain;
        },
        then<T>(resolve: (value: unknown[]) => T) {
          selects.push(call);
          return Promise.resolve(rows[call.table] ?? []).then(resolve);
        },
      };
      return chain;
    },
  };

  return { db: db as unknown as PostgresJsDatabase<typeof schema>, inserts, updates, selects };
}

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const MEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "33333333-3333-4333-8333-333333333333";

const REVIEW_TABLE = getTableName(schema.brainReviewItems);

function issue(overrides: Partial<HealthIssue> = {}): HealthIssue {
  return {
    type: "orphan",
    severity: "medium",
    memoryId: MEM_A,
    memoryTitle: "Deploy target",
    reason: "No connections to other memories or entities.",
    ...overrides,
  };
}

function report(issues: HealthIssue[]): BrainHealthReport {
  return { metrics: {} as BrainHealthReport["metrics"], issues };
}

describe("reviewDedupeKey", () => {
  it("is independent of the order the pair is given in", () => {
    expect(reviewDedupeKey("contradiction", [MEM_A, MEM_B])).toBe(
      reviewDedupeKey("contradiction", [MEM_B, MEM_A])
    );
  });

  it("separates kinds over the same memories", () => {
    expect(reviewDedupeKey("contradiction", [MEM_A, MEM_B])).not.toBe(
      reviewDedupeKey("duplicate", [MEM_A, MEM_B])
    );
  });

  it("names the kind and every memory it covers", () => {
    const key = reviewDedupeKey("orphan", [MEM_A]);
    expect(key.startsWith("orphan:")).toBe(true);
    expect(key).toContain(MEM_A);
  });
});

describe("upsertReviewItems", () => {
  it("writes nothing when there is nothing to review", async () => {
    const { db, inserts } = recordingDb();
    await expect(upsertReviewItems(db, BRAIN, [])).resolves.toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("collapses the same finding reported twice in one batch", async () => {
    const { db, inserts } = recordingDb();
    const written = await upsertReviewItems(db, BRAIN, [
      { kind: "contradiction", memoryId: MEM_A, relatedMemoryId: MEM_B, reason: "first" },
      { kind: "contradiction", memoryId: MEM_B, relatedMemoryId: MEM_A, reason: "second" },
    ]);

    expect(written).toBe(1);
    expect(inserts[0].values).toHaveLength(1);
    expect(inserts[0].values[0].reason).toBe("second");
  });

  it("stamps every row with the brain it was scanned for", async () => {
    const { db, inserts } = recordingDb();
    await upsertReviewItems(db, BRAIN, [
      { kind: "orphan", memoryId: MEM_A, reason: "isolated" },
      { kind: "stale", memoryId: MEM_B, reason: "old" },
    ]);

    expect(inserts[0].table).toBe(REVIEW_TABLE);
    expect(inserts[0].values.map((row) => row.brainId)).toEqual([BRAIN, BRAIN]);
  });

  it("re-scans onto the deterministic key, so the queue cannot flood", async () => {
    const { db, inserts } = recordingDb();
    await upsertReviewItems(db, BRAIN, [
      { kind: "contradiction", memoryId: MEM_A, relatedMemoryId: MEM_B, reason: "conflict" },
    ]);

    expect(inserts[0].conflictTarget).toEqual(["brain_id", "dedupe_key"]);
    expect(inserts[0].values[0].dedupeKey).toBe(reviewDedupeKey("contradiction", [MEM_A, MEM_B]));
  });

  it("never lets a re-scan overwrite a human decision", async () => {
    const { db, inserts } = recordingDb();
    await upsertReviewItems(db, BRAIN, [
      { kind: "contradiction", memoryId: MEM_A, relatedMemoryId: MEM_B, reason: "conflict" },
    ]);

    // A dismissed item must stay dismissed through the next hundred scans, and a
    // resolved one must not silently reopen: the conflict clause refreshes evidence
    // only.
    const refreshed = Object.keys(inserts[0].conflictSet);
    expect(refreshed).not.toContain("status");
    expect(refreshed).not.toContain("resolvedAt");
    expect(refreshed).not.toContain("resolvedBy");
    expect(refreshed.sort()).toEqual(["evidence", "priority", "reason", "updatedAt"]);
  });

  it("keeps evidence structural: no memory text is copied into the queue", async () => {
    const { db, inserts } = recordingDb();
    await syncReviewQueue(
      db,
      BRAIN,
      report([
        issue({
          type: "contradiction",
          severity: "high",
          memoryTitle: "We deploy on Vercel",
          reason: 'Says "no longer" about the same subject (71% word overlap).',
          conflictsWith: { id: MEM_B, title: "We no longer deploy on Vercel" },
        }),
      ])
    );

    const row = JSON.stringify(inserts[0].values[0].evidence);
    expect(row).not.toContain("Vercel");
    expect(inserts[0].values[0].evidence).toMatchObject({
      issueType: "contradiction",
      severity: "high",
      conflictsWithId: MEM_B,
    });
  });
});

describe("syncReviewQueue", () => {
  it("queues the findings that need a decision and skips the ones that do not", async () => {
    const { db, inserts } = recordingDb();
    const written = await syncReviewQueue(
      db,
      BRAIN,
      report([
        issue({ type: "contradiction", severity: "high", conflictsWith: { id: MEM_B, title: "b" } }),
        issue({ type: "orphan" }),
        issue({ type: "stale", severity: "low" }),
        issue({ type: "low_confidence" }),
        // Neither of these is a defect: one link is still a link, and every memory is
        // unconfirmed on the day it is written.
        issue({ type: "weak_link", severity: "low" }),
        issue({ type: "unconfirmed", severity: "low" }),
      ])
    );

    const kinds = inserts[0].values.map((row) => row.kind);
    expect(kinds).toContain("contradiction");
    expect(kinds).toContain("orphan");
    expect(kinds).toContain("stale");
    expect(kinds).toContain("low_confidence_important");
    expect(kinds).not.toContain("weak_link");
    expect(kinds).not.toContain("unconfirmed");
    expect(written).toBe(kinds.length);
  });

  it("ranks a contradiction above structural noise", async () => {
    const { db, inserts } = recordingDb();
    await syncReviewQueue(
      db,
      BRAIN,
      report([
        issue({ type: "stale", severity: "low" }),
        issue({
          type: "contradiction",
          severity: "high",
          memoryId: MEM_B,
          conflictsWith: { id: MEM_A, title: "a" },
        }),
      ])
    );

    const priorityOf = (kind: string) =>
      Number(inserts[0].values.find((row) => row.kind === kind)!.priority);
    expect(priorityOf("contradiction")).toBeGreaterThan(priorityOf("stale"));
  });

  it("carries the other side of a contradiction so the queue can show both", async () => {
    const { db, inserts } = recordingDb();
    await syncReviewQueue(
      db,
      BRAIN,
      report([
        issue({ type: "contradiction", severity: "high", conflictsWith: { id: MEM_B, title: "b" } }),
      ])
    );

    expect(inserts[0].values[0].memoryId).toBe(MEM_A);
    expect(inserts[0].values[0].relatedMemoryId).toBe(MEM_B);
  });

  it("writes nothing for a healthy brain", async () => {
    const { db, inserts } = recordingDb();
    await expect(syncReviewQueue(db, BRAIN, report([]))).resolves.toBe(0);
    expect(inserts).toHaveLength(0);
  });
});

describe("listReviewItems", () => {
  const queueRow = {
    id: "44444444-4444-4444-8444-444444444444",
    kind: "contradiction",
    status: "open",
    memoryId: MEM_A,
    relatedMemoryId: MEM_B,
    reason: "conflict",
    evidence: null,
    priority: 0.9,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };

  it("reads only the requested brain and status", async () => {
    const { db, selects } = recordingDb({ rows: { [REVIEW_TABLE]: [queueRow] } });
    await listReviewItems(db, BRAIN, { status: "dismissed" });

    const queueRead = selects.find((call) => call.table === REVIEW_TABLE)!;
    const where = describeSql(queueRead.where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("dismissed");
  });

  it("defaults to the open queue", async () => {
    const { db, selects } = recordingDb({ rows: { [REVIEW_TABLE]: [] } });
    await listReviewItems(db, BRAIN);

    expect(describeSql(selects[0].where)).toContain("open");
  });

  it("clamps the page size instead of trusting the caller", async () => {
    const { db, selects } = recordingDb({ rows: { [REVIEW_TABLE]: [] } });
    await listReviewItems(db, BRAIN, { limit: 100_000 });
    expect(selects[0].limit).toBe(200);

    const small = recordingDb({ rows: { [REVIEW_TABLE]: [] } });
    await listReviewItems(small.db, BRAIN, { limit: 0 });
    expect(small.selects[0].limit).toBe(1);
  });

  it("resolves both titles through a brain-scoped lookup", async () => {
    const memoryTable = getTableName(schema.memories);
    const { db, selects } = recordingDb({
      rows: {
        [REVIEW_TABLE]: [queueRow],
        [memoryTable]: [
          { id: MEM_A, title: "We deploy on Vercel" },
          { id: MEM_B, title: "We no longer deploy on Vercel" },
        ],
      },
    });

    const [item] = await listReviewItems(db, BRAIN);
    expect(item.memoryTitle).toBe("We deploy on Vercel");
    expect(item.relatedMemoryTitle).toBe("We no longer deploy on Vercel");

    const titleRead = selects.find((call) => call.table === memoryTable)!;
    expect(describeSql(titleRead.where)).toContain(BRAIN);
  });

  it("shows a null title rather than inventing one for a memory it cannot see", async () => {
    const { db } = recordingDb({
      rows: { [REVIEW_TABLE]: [queueRow], [getTableName(schema.memories)]: [] },
    });

    const [item] = await listReviewItems(db, BRAIN);
    expect(item.memoryTitle).toBeNull();
    expect(item.relatedMemoryTitle).toBeNull();
    expect(item.reason).toBe("conflict");
  });

  it("does not query for titles when the queue is empty", async () => {
    const { db, selects } = recordingDb({ rows: { [REVIEW_TABLE]: [] } });
    await listReviewItems(db, BRAIN);
    expect(selects.map((call) => call.table)).toEqual([REVIEW_TABLE]);
  });
});

describe("resolveReviewItem", () => {
  const ITEM = "44444444-4444-4444-8444-444444444444";

  it("records the decision and who made it", async () => {
    const { db, updates } = recordingDb();
    await expect(resolveReviewItem(db, BRAIN, ITEM, "resolved", USER)).resolves.toBe(true);

    expect(updates[0].table).toBe(REVIEW_TABLE);
    expect(updates[0].set.status).toBe("resolved");
    expect(updates[0].set.resolvedBy).toBe(USER);
    expect(updates[0].set.resolvedAt).toBeInstanceOf(Date);
  });

  it("keeps dismissal distinct from resolution", async () => {
    const { db, updates } = recordingDb();
    await resolveReviewItem(db, BRAIN, ITEM, "dismissed", USER);
    expect(updates[0].set.status).toBe("dismissed");
  });

  it("cannot be used to reach across a brain boundary", async () => {
    // The item id alone is not enough: the brain is part of the predicate, so an id
    // belonging to another brain matches no row.
    const { db, updates } = recordingDb({ updated: [] });
    await expect(resolveReviewItem(db, OTHER_BRAIN, ITEM, "resolved", USER)).resolves.toBe(false);

    const where = describeSql(updates[0].where);
    expect(where).toContain(OTHER_BRAIN);
    expect(where).toContain(ITEM);
  });

  it("reports false when the item does not exist", async () => {
    const { db } = recordingDb({ updated: [] });
    await expect(resolveReviewItem(db, BRAIN, ITEM, "resolved")).resolves.toBe(false);
  });
});





