import { describe, it, expect } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { recordFeedback, hashQuery, type FeedbackSignalType } from "./feedback-loop";

/**
 * The feedback loop is the one part of retrieval that writes. These tests pin what
 * it writes, that every write is brain-scoped, and that telemetry can never take a
 * read down with it.
 *
 * How usage affects ranking is NOT tested here — that lives in the scorer's
 * `reinforcement` signal (`lib/brain/retrieval/score.test.ts`). This module only
 * records; keeping the two apart is what stops usage being counted twice.
 */

type UpdateCall = { table: string; set: Record<string, unknown>; where: unknown };
type InsertCall = { table: string; values: Record<string, unknown> };

type Recorder = {
  db: PostgresJsDatabase<typeof schema>;
  updates: UpdateCall[];
  inserts: InsertCall[];
};

/** Minimal chainable stand-in: captures update/insert calls, executes nothing. */
function recordingDb(options: { failInserts?: boolean } = {}): Recorder {
  const updates: UpdateCall[] = [];
  const inserts: InsertCall[] = [];

  const db = {
    update(table: unknown) {
      const call: UpdateCall = { table: getTableName(table as never), set: {}, where: null };
      return {
        set(values: Record<string, unknown>) {
          call.set = values;
          return {
            where(condition: unknown) {
              call.where = condition;
              updates.push(call);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      const tableName = getTableName(table as never);
      return {
        values(values: Record<string, unknown>) {
          if (options.failInserts) {
            return Promise.reject(new Error("telemetry table unavailable"));
          }
          inserts.push({ table: tableName, values });
          return Promise.resolve([]);
        },
      };
    },
  };

  return { db: db as unknown as PostgresJsDatabase<typeof schema>, updates, inserts };
}

/**
 * Flatten a Drizzle SQL fragment (or column/param) into a searchable string.
 *
 * `JSON.stringify` cannot be used here: a `PgColumn` holds a back-reference to its
 * table, so the structure is circular. This walks only the parts that describe the
 * statement — nested `queryChunks`, literal string chunks, bound param values and
 * column names — which is exactly what the assertions below need.
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
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
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

const BRAIN = "11111111-1111-4111-8111-111111111111";
const MEMORY = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const ALL_SIGNALS: FeedbackSignalType[] = [
  "recalled",
  "opened",
  "confirmed",
  "corrected",
  "superseded",
];

describe("recordFeedback writes", () => {
  it("bumps recall counters and both timestamps on a recall", async () => {
    const { db, updates } = recordingDb();
    await recordFeedback(db, BRAIN, MEMORY, "recalled", USER, null, { tool: "brain_recall" });

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(getTableName(schema.memories));
    expect(Object.keys(updates[0].set).sort()).toEqual([
      "lastAccessedAt",
      "lastRecalledAt",
      "recallCount",
    ]);
  });

  it("raises confidence on a confirmation and lowers it on a correction", async () => {
    const confirmed = recordingDb();
    await recordFeedback(confirmed.db, BRAIN, MEMORY, "confirmed", USER, null, { tool: "t" });
    expect(Object.keys(confirmed.updates[0].set)).toContain("confirmationCount");
    expect(describeSql(confirmed.updates[0].set.confidence)).toContain("LEAST");

    const corrected = recordingDb();
    await recordFeedback(corrected.db, BRAIN, MEMORY, "corrected", USER, null, { tool: "t" });
    expect(describeSql(corrected.updates[0].set.confidence)).toContain("GREATEST");
    // A correction must not inflate the recall counters.
    expect(Object.keys(corrected.updates[0].set)).not.toContain("recallCount");
  });

  it("marks a superseded memory without deleting it", async () => {
    const { db, updates } = recordingDb();
    await recordFeedback(db, BRAIN, MEMORY, "superseded", USER, null, { tool: "t" });

    expect(updates[0].set.validityState).toBe("superseded");
    expect(Object.keys(updates[0].set)).not.toContain("deletedAt");
  });

  it("scopes every counter update to the brain, never to the memory id alone", async () => {
    for (const signal of ALL_SIGNALS) {
      const { db, updates } = recordingDb();
      await recordFeedback(db, BRAIN, MEMORY, signal, USER, null, { tool: "t" });

      expect(updates, `signal ${signal} wrote nothing`).toHaveLength(1);
      const where = describeSql(updates[0].where);
      expect(where, `signal ${signal} is not brain-scoped`).toContain(BRAIN);
      expect(where).toContain(MEMORY);
    }
  });
});

describe("telemetry rows", () => {
  it("maps every signal onto the retrieval-outcome enum", async () => {
    const expected: Record<FeedbackSignalType, string> = {
      recalled: "retrieved",
      opened: "opened",
      confirmed: "confirmed",
      corrected: "corrected",
      superseded: "superseded",
    };

    for (const signal of ALL_SIGNALS) {
      const { db, inserts } = recordingDb();
      await recordFeedback(db, BRAIN, MEMORY, signal, USER, null, { tool: "brain_read" });

      expect(inserts).toHaveLength(1);
      expect(inserts[0].table).toBe(getTableName(schema.brainRetrievalEvents));
      expect(inserts[0].values.outcome).toBe(expected[signal]);
      expect(inserts[0].values.brainId).toBe(BRAIN);
      expect(inserts[0].values.tool).toBe("brain_read");
    }
  });

  it("stores the query hash and never the query text", async () => {
    const query = "what did we decide about the upload quota";
    const { db, inserts } = recordingDb();

    await recordFeedback(db, BRAIN, MEMORY, "recalled", USER, null, {
      tool: "brain_context",
      queryHash: hashQuery(query),
      rank: 3,
      score: 0.42,
    });

    const row = JSON.stringify(inserts[0].values);
    expect(row).not.toContain("upload quota");
    expect(row).not.toContain(query);
    expect(inserts[0].values.queryHash).toBe(hashQuery(query));
    expect(inserts[0].values.rank).toBe(3);
  });

  it("leaves the hash null when the caller has no query", async () => {
    const { db, inserts } = recordingDb();
    await recordFeedback(db, BRAIN, MEMORY, "opened", USER, null, { tool: "brain_read" });

    expect(inserts[0].values.queryHash).toBeNull();
  });

  it("does not fail the caller when the telemetry insert fails", async () => {
    const { db, updates } = recordingDb({ failInserts: true });

    await expect(
      recordFeedback(db, BRAIN, MEMORY, "opened", USER, null, { tool: "brain_read" })
    ).resolves.toBeUndefined();

    // The counter update — the part ranking reads — still happened.
    expect(updates).toHaveLength(1);
  });
});

describe("hashQuery", () => {
  it("is stable and normalizes case and whitespace", () => {
    expect(hashQuery("Upload  Quota ")).toBe(hashQuery("upload quota"));
    expect(hashQuery("upload quota")).toBe(hashQuery("upload quota"));
  });

  it("separates different queries", () => {
    expect(hashQuery("upload quota")).not.toBe(hashQuery("download quota"));
  });

  it("is not reversible: the output carries no query text", () => {
    const hash = hashQuery("secret project codename");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain("secret");
  });
});
