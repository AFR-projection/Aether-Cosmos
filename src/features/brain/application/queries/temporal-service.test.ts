import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import {
  buildMemoryTimeline,
  getRecentMemories,
  getStaleMemories,
  getSupersededChains,
} from "./temporal-service";

/**
 * Temporal memory (P5). The properties that matter here are behavioural, not
 * cosmetic: a timeline is chronological, it never invents an event that did not
 * happen, every read is fenced to one brain, and nothing is ever deleted because it
 * decayed — the service has no delete path at all.
 *
 * The database is a recorder: it captures each statement's shape and returns queued
 * rows without executing anything.
 */

type SelectCall = { table: string; columns: string[]; limit: number | null; where: unknown };

type Recorder = {
  db: PostgresJsDatabase<typeof schema>;
  selects: SelectCall[];
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

    // Bound date params matter here: staleness is a date comparison, and the tests
    // below read the threshold back out of the predicate.
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
 * `queues` maps a table name to the results of its successive selects, in order:
 * `buildMemoryTimeline` reads `memories` twice (the memory, then its replacement),
 * and each read must be able to answer differently.
 */
function recordingDb(queues: Record<string, unknown[][]> = {}): Recorder {
  const selects: SelectCall[] = [];
  const cursors = new Map<string, number>();

  const db = {
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
        orderBy: () => chain,
        groupBy: () => chain,
        limit(value: number) {
          call.limit = value;
          return chain;
        },
        then<T>(resolve: (value: unknown[]) => T) {
          selects.push(call);
          const index = cursors.get(call.table) ?? 0;
          cursors.set(call.table, index + 1);
          const rows = queues[call.table]?.[index] ?? [];
          return Promise.resolve(rows).then(resolve);
        },
      };
      return chain;
    },
  };

  return { db: db as unknown as PostgresJsDatabase<typeof schema>, selects };
}

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const MEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPLACEMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const MEMORY_TABLE = getTableName(schema.memories);
const VERSION_TABLE = getTableName(schema.memoryVersions);

const t = (iso: string) => new Date(iso);

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEM,
    title: "Deploy target",
    type: "fact",
    createdAt: t("2026-01-01T00:00:00.000Z"),
    updatedAt: t("2026-03-01T00:00:00.000Z"),
    lastAccessedAt: null,
    lastConfirmedAt: null,
    confidence: 0.8,
    importance: 0.5,
    confirmationCount: 0,
    validityState: "active",
    supersededById: null,
    ...overrides,
  };
}

describe("buildMemoryTimeline", () => {
  it("returns null for a memory the brain does not hold", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await expect(buildMemoryTimeline(db, BRAIN, MEM)).resolves.toBeNull();
    // It gave up after the first lookup: no version read, no replacement read.
    expect(selects).toHaveLength(1);
  });

  it("fences the lookup to the brain, the id, and undeleted rows", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await buildMemoryTimeline(db, OTHER_BRAIN, MEM);

    const where = describeSql(selects[0].where);
    expect(where).toContain(OTHER_BRAIN);
    expect(where).toContain(MEM);
    expect(where).toContain("deleted_at");
    expect(selects[0].limit).toBe(1);
  });

  it("always records creation, even for a memory nothing has happened to", async () => {
    const { db } = recordingDb({ [MEMORY_TABLE]: [[memoryRow()]], [VERSION_TABLE]: [[]] });
    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);

    expect(timeline?.memoryId).toBe(MEM);
    expect(timeline?.memoryTitle).toBe("Deploy target");
    expect(timeline?.events.map((event) => event.eventType)).toEqual(["created"]);
    expect(timeline?.events[0].timestamp).toEqual(t("2026-01-01T00:00:00.000Z"));
  });

  it("carries each edit's version number and reason", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()]],
      [VERSION_TABLE]: [
        [
          { versionNumber: 1, createdAt: t("2026-02-01T00:00:00.000Z"), changeReason: "typo" },
          { versionNumber: 2, createdAt: t("2026-03-01T00:00:00.000Z"), changeReason: null },
        ],
      ],
    });

    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);
    const updates = timeline!.events.filter((event) => event.eventType === "updated");
    expect(updates.map((event) => event.version)).toEqual([1, 2]);
    expect(updates[0].changeReason).toBe("typo");
    expect(updates[1].changeReason).toBeNull();
  });

  it("orders every event chronologically, whatever order it collected them in", async () => {
    // Access and confirmation are appended after the versions, so an unsorted
    // timeline would show the confirmation before the edit that followed it.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [
          memoryRow({
            updatedAt: t("2026-03-01T00:00:00.000Z"),
            lastAccessedAt: t("2026-04-01T00:00:00.000Z"),
            lastConfirmedAt: t("2026-02-15T00:00:00.000Z"),
          }),
        ],
      ],
      [VERSION_TABLE]: [
        [{ versionNumber: 1, createdAt: t("2026-03-01T00:00:00.000Z"), changeReason: null }],
      ],
    });

    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);
    const stamps = timeline!.events.map((event) => event.timestamp.getTime());
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(timeline!.events.map((event) => event.eventType)).toEqual([
      "created",
      "confirmed",
      "updated",
      "accessed",
    ]);
  });

  it("omits an access event that is really just the last edit", async () => {
    // `lastAccessedAt <= updatedAt` means reading and writing collapsed into one
    // moment; reporting both would invent an event.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [
          memoryRow({
            updatedAt: t("2026-03-01T00:00:00.000Z"),
            lastAccessedAt: t("2026-03-01T00:00:00.000Z"),
          }),
        ],
      ],
      [VERSION_TABLE]: [[]],
    });

    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);
    expect(timeline!.events.map((event) => event.eventType)).not.toContain("accessed");
  });
});

describe("buildMemoryTimeline — supersession and retraction", () => {
  it("names what replaced a superseded memory", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [
        [memoryRow({ validityState: "superseded", supersededById: REPLACEMENT })],
        [{ id: REPLACEMENT, title: "We deploy on Hetzner" }],
      ],
      [VERSION_TABLE]: [[]],
    });

    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);
    const superseded = timeline!.events.find((event) => event.eventType === "superseded");
    expect(superseded?.supersededBy).toEqual({ id: REPLACEMENT, title: "We deploy on Hetzner" });

    // The replacement lookup is brain-scoped too: a pointer across a tenant boundary
    // must not resolve.
    const replacementRead = selects[selects.length - 1];
    const where = describeSql(replacementRead.where);
    expect(where).toContain(BRAIN);
    expect(where).toContain(REPLACEMENT);
  });

  it("reports the supersession without a replacement it cannot see", async () => {
    // The row points somewhere this brain cannot read. Rather than invent a title,
    // the event is dropped — the memory's other history still stands.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [memoryRow({ validityState: "superseded", supersededById: REPLACEMENT })],
        [],
      ],
      [VERSION_TABLE]: [[]],
    });

    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);
    expect(timeline!.events.map((event) => event.eventType)).toEqual(["created"]);
  });

  it("does not look for a replacement when there is no pointer", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()]],
      [VERSION_TABLE]: [[]],
    });

    await buildMemoryTimeline(db, BRAIN, MEM);
    expect(selects.filter((call) => call.table === MEMORY_TABLE)).toHaveLength(1);
  });

  it("records a retraction, and never as a deletion", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow({ validityState: "retracted" })]],
      [VERSION_TABLE]: [[]],
    });

    const timeline = await buildMemoryTimeline(db, BRAIN, MEM);
    expect(timeline!.events.map((event) => event.eventType)).toEqual(["created", "retracted"]);
  });
});

describe("getRecentMemories", () => {
  it("reads one brain, skipping deleted and archived rows", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getRecentMemories(db, BRAIN);

    const where = describeSql(selects[0].where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("deleted_at");
    expect(where).toContain("archived_at");
    expect(where).not.toContain(OTHER_BRAIN);
  });

  it("defaults to a bounded page and honours an explicit one", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getRecentMemories(db, BRAIN);
    expect(selects[0].limit).toBe(20);

    const explicit = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getRecentMemories(explicit.db, BRAIN, 5);
    expect(explicit.selects[0].limit).toBe(5);
  });

  it("includes superseded and stale rows: recency is not a validity filter", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getRecentMemories(db, BRAIN);
    expect(describeSql(selects[0].where)).not.toContain("superseded");
  });
});

describe("getStaleMemories", () => {
  it("asks only for active memories past the threshold", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getStaleMemories(db, BRAIN, 180);

    const where = describeSql(selects[0].where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("active");
    expect(where).toContain("GREATEST");
    expect(where).toContain("COALESCE");
  });

  it("measures staleness from the later of update and access", async () => {
    // A memory read every week is not stale just because its text has not changed.
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getStaleMemories(db, BRAIN);

    const where = describeSql(selects[0].where);
    expect(where).toContain("updated_at");
    expect(where).toContain("last_accessed_at");
  });

  it("moves the threshold with staleDays", async () => {
    const near = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getStaleMemories(near.db, BRAIN, 1);
    const far = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getStaleMemories(far.db, BRAIN, 3650);

    const dateIn = (node: unknown) =>
      describeSql(node)
        .split(" ")
        .map((part) => Date.parse(part))
        .find((value) => !Number.isNaN(value));

    expect(dateIn(far.selects[0].where)!).toBeLessThan(dateIn(near.selects[0].where)!);
  });

  it("clamps nothing but still pages", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await getStaleMemories(db, BRAIN);
    expect(selects[0].limit).toBe(50);
  });
});

describe("getSupersededChains", () => {
  const superseded = memoryRow({ validityState: "superseded", supersededById: REPLACEMENT });
  const replacement = memoryRow({ id: REPLACEMENT, title: "We deploy on Hetzner" });

  it("pairs each superseded memory with what replaced it", async () => {
    const { db } = recordingDb({ [MEMORY_TABLE]: [[superseded], [replacement]] });
    const chains = await getSupersededChains(db, BRAIN);

    expect(chains).toHaveLength(1);
    expect(chains[0].superseded.id).toBe(MEM);
    expect(chains[0].replacement.title).toBe("We deploy on Hetzner");
  });

  it("skips the replacement query entirely when nothing is superseded", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await expect(getSupersededChains(db, BRAIN)).resolves.toEqual([]);
    expect(selects).toHaveLength(1);
  });

  it("drops a chain whose replacement is not in this brain", async () => {
    // No dangling edge is ever reported: an unresolvable pointer yields no chain
    // rather than a half-populated one.
    const { db } = recordingDb({ [MEMORY_TABLE]: [[superseded], []] });
    await expect(getSupersededChains(db, BRAIN)).resolves.toEqual([]);
  });

  it("scopes both sides of the chain to the brain", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[superseded], [replacement]] });
    await getSupersededChains(db, BRAIN);

    for (const call of selects) {
      expect(describeSql(call.where)).toContain(BRAIN);
    }
    expect(describeSql(selects[0].where)).toContain("superseded");
  });

  it("resolves replacements in one batched read, not one per chain", async () => {
    const second = memoryRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", supersededById: REPLACEMENT });
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[superseded, { ...second, validityState: "superseded" }], [replacement]],
    });

    const chains = await getSupersededChains(db, BRAIN);
    expect(chains).toHaveLength(2);
    expect(selects).toHaveLength(2);
  });
});
