import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { findMemoryPath } from "./path-service";

/**
 * `brain_path` (P4): "how is A connected to B?" answered as a chain a person can
 * read, not a list of ids.
 *
 * The contract these tests hold it to: only recorded links are traversed (never a
 * guessed similarity edge), every hop names its relationship, the search stays inside
 * one brain, and a path that cannot be fully resolved is reported as no path rather
 * than as a chain with a gap in it.
 */

type SelectCall = { table: string; columns: string[]; where: unknown };

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

function recordingDb(rows: Record<string, unknown[]> = {}) {
  const selects: SelectCall[] = [];

  const db = {
    select(projection?: Record<string, unknown>) {
      const call: SelectCall = { table: "", columns: Object.keys(projection ?? {}), where: null };
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
        limit: () => chain,
        then<T>(resolve: (value: unknown[]) => T) {
          selects.push(call);
          return Promise.resolve(rows[call.table] ?? []).then(resolve);
        },
      };
      return chain;
    },
  };

  return { db: db as unknown as PostgresJsDatabase<typeof schema>, selects };
}

const BRAIN = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UNREACHABLE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const MEMORY_TABLE = getTableName(schema.memories);
const LINK_TABLE = getTableName(schema.memoryLinks);

const link = (source: string, target: string, linkType = "related_to") => ({
  sourceMemoryId: source,
  targetMemoryId: target,
  linkType,
});

const node = (id: string, title: string) => ({ id, title, type: "fact" });

/** A → B → C, plus an island. */
const chain = {
  [LINK_TABLE]: [link(A, B, "supersedes"), link(B, C, "derived_from")],
  [MEMORY_TABLE]: [node(A, "Vercel"), node(B, "Hetzner"), node(C, "Runbook")],
};

describe("findMemoryPath — explainability", () => {
  it("returns each hop with both endpoints named and the relationship that joins them", async () => {
    const { db } = recordingDb(chain);
    const result = await findMemoryPath(db, BRAIN, A, C);

    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(2);
    expect(result.path[0]).toMatchObject({
      source: { id: A, title: "Vercel", type: "fact" },
      target: { id: B, title: "Hetzner", type: "fact" },
      relationshipType: "supersedes",
    });
    expect(result.path[1].relationshipType).toBe("derived_from");
    expect(result.path[1].target.title).toBe("Runbook");
  });

  it("joins up: each hop starts where the previous one ended", async () => {
    const { db } = recordingDb(chain);
    const { path } = await findMemoryPath(db, BRAIN, A, C);

    for (let index = 1; index < path.length; index += 1) {
      expect(path[index].source.id).toBe(path[index - 1].target.id);
    }
    expect(path[0].source.id).toBe(A);
    expect(path[path.length - 1].target.id).toBe(C);
  });

  it("counts distance in hops of weight 1, because a recorded link is a certainty", async () => {
    const { db } = recordingDb(chain);
    const result = await findMemoryPath(db, BRAIN, A, C);

    expect(result.distance).toBe(2);
    expect(result.path.every((hop) => hop.weight === 1)).toBe(true);
  });

  it("walks a link backwards: connection is not direction", async () => {
    const { db } = recordingDb({
      [LINK_TABLE]: [link(B, A, "supersedes")],
      [MEMORY_TABLE]: [node(A, "Vercel"), node(B, "Hetzner")],
    });

    const result = await findMemoryPath(db, BRAIN, A, B);
    expect(result.found).toBe(true);
    expect(result.path[0].source.id).toBe(A);
    expect(result.path[0].target.id).toBe(B);
  });
});

describe("findMemoryPath — when there is no path", () => {
  it("reports a miss for two memories in different components", async () => {
    const { db } = recordingDb({
      [LINK_TABLE]: [link(A, B)],
      [MEMORY_TABLE]: [node(A, "Vercel"), node(B, "Hetzner")],
    });

    const result = await findMemoryPath(db, BRAIN, A, UNREACHABLE);
    expect(result).toEqual({ found: false, path: [], distance: Infinity });
  });

  it("reports a miss in a brain with no links at all, without reading memories", async () => {
    const { db, selects } = recordingDb({});
    await expect(findMemoryPath(db, BRAIN, A, C)).resolves.toMatchObject({ found: false });
    expect(selects.map((call) => call.table)).toEqual([LINK_TABLE]);
  });

  it("stops at maxDepth rather than following an arbitrarily long chain", async () => {
    const { db } = recordingDb({
      [LINK_TABLE]: [link(A, B), link(B, C), link(C, D)],
      [MEMORY_TABLE]: [node(A, "a"), node(B, "b"), node(C, "c"), node(D, "d")],
    });

    await expect(findMemoryPath(db, BRAIN, A, D, 3)).resolves.toMatchObject({ found: true });
    await expect(findMemoryPath(db, BRAIN, A, D, 2)).resolves.toMatchObject({ found: false });
  });

  it("does not claim a path from a memory to itself over a link it does not have", async () => {
    const { db } = recordingDb(chain);
    const result = await findMemoryPath(db, BRAIN, A, A);
    expect(result.path).toEqual([]);
  });

  it("refuses to report a chain with an unresolvable hop", async () => {
    // The link rows still describe A → B → C, but B's row is gone (soft-deleted, or
    // it belongs to another brain). Returning A → C over that gap would be a lie, so
    // the whole path is withdrawn.
    const { db } = recordingDb({
      [LINK_TABLE]: [link(A, B), link(B, C)],
      [MEMORY_TABLE]: [node(A, "Vercel"), node(C, "Runbook")],
    });

    const result = await findMemoryPath(db, BRAIN, A, C);
    expect(result.found).toBe(false);
    expect(result.path).toEqual([]);
    expect(result.distance).toBe(Infinity);
  });
});

describe("findMemoryPath — what it is allowed to traverse", () => {
  it("reads only this brain's memory-anchored links", async () => {
    const { db, selects } = recordingDb(chain);
    await findMemoryPath(db, BRAIN, A, C);

    const linkRead = selects.find((call) => call.table === LINK_TABLE)!;
    const where = describeSql(linkRead.where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("memory");
  });

  it("resolves node metadata inside the brain, excluding deleted rows", async () => {
    const { db, selects } = recordingDb(chain);
    await findMemoryPath(db, BRAIN, A, C);

    const memoryRead = selects.find((call) => call.table === MEMORY_TABLE)!;
    const where = describeSql(memoryRead.where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("deleted_at");
    // Only the nodes on the path are fetched, not the whole brain.
    expect(where).toContain(A);
    expect(where).toContain(B);
    expect(where).not.toContain(D);
  });

  it("ignores a link row with no memory on the far end", async () => {
    // Entity-anchored rows share the table; treating one as an edge would invent a
    // connection between memories that are not connected.
    const { db } = recordingDb({
      [LINK_TABLE]: [
        { sourceMemoryId: A, targetMemoryId: null, linkType: "mentions" },
        { sourceMemoryId: C, targetMemoryId: null, linkType: "mentions" },
      ],
      [MEMORY_TABLE]: [node(A, "Vercel"), node(C, "Runbook")],
    });

    await expect(findMemoryPath(db, BRAIN, A, C)).resolves.toMatchObject({ found: false });
  });

  it("takes the shorter of two routes", async () => {
    const { db } = recordingDb({
      [LINK_TABLE]: [link(A, D, "related_to"), link(A, B), link(B, C), link(C, D)],
      [MEMORY_TABLE]: [node(A, "a"), node(B, "b"), node(C, "c"), node(D, "d")],
    });

    const result = await findMemoryPath(db, BRAIN, A, D);
    expect(result.path).toHaveLength(1);
    expect(result.distance).toBe(1);
  });

  it("is symmetric: the same two memories are the same distance apart either way", async () => {
    const forward = recordingDb(chain);
    const backward = recordingDb(chain);

    const there = await findMemoryPath(forward.db, BRAIN, A, C);
    const back = await findMemoryPath(backward.db, BRAIN, C, A);
    expect(back.found).toBe(there.found);
    expect(back.distance).toBe(there.distance);
    expect(back.path.map((hop) => hop.source.id)).toEqual([C, B]);
  });
});
