import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { explainMemoryProvenance } from "./provenance-service";

/**
 * Provenance (P7): "where did this come from, and who changed it?"
 *
 * The report is an explanation a person has to be able to trust, so these tests hold
 * it to three things: every read is fenced to one brain, an unresolvable pointer is
 * omitted rather than guessed at, and authorship is reported from the record instead
 * of inferred.
 *
 * The database is a recorder — it captures each statement and returns queued rows.
 */

type SelectCall = { table: string; columns: string[]; limit: number | null; where: unknown };

/** Flatten a Drizzle predicate into a searchable string (columns are circular). */
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

/**
 * `queues` maps a table to the results of its successive selects, in order. The
 * `memories` table is read up to four times — the memory, its replacement, what it
 * supersedes, and its source memories — and each read must answer differently.
 */
function recordingDb(queues: Record<string, unknown[][]> = {}) {
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
          return Promise.resolve(queues[call.table]?.[index] ?? []).then(resolve);
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
const OLDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const MEMORY_TABLE = getTableName(schema.memories);
const VERSION_TABLE = getTableName(schema.memoryVersions);
const LINK_TABLE = getTableName(schema.memoryLinks);
const AGENT_TABLE = getTableName(schema.brainAgents);

const t = (iso: string) => new Date(iso);

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEM,
    title: "We deploy on Hetzner",
    type: "fact",
    sourceType: "manual",
    sourceId: null,
    createdAt: t("2026-01-01T00:00:00.000Z"),
    updatedAt: t("2026-03-01T00:00:00.000Z"),
    createdBy: USER,
    createdByAgent: null,
    confidence: 0.8,
    importance: 0.5,
    confirmationCount: 2,
    lastConfirmedAt: t("2026-02-01T00:00:00.000Z"),
    validityState: "active",
    supersededById: null,
    ...overrides,
  };
}

describe("explainMemoryProvenance — tenant isolation", () => {
  it("returns null for a memory this brain does not hold", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await expect(explainMemoryProvenance(db, BRAIN, MEM)).resolves.toBeNull();
    // Nothing else was read: no version history, no links, no agent name.
    expect(selects).toHaveLength(1);
  });

  it("fences the first read to the brain, the id, and undeleted rows", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await explainMemoryProvenance(db, OTHER_BRAIN, MEM);

    const where = describeSql(selects[0].where);
    expect(where).toContain(OTHER_BRAIN);
    expect(where).toContain(MEM);
    expect(where).toContain("deleted_at");
  });

  it("scopes every memory and link read to the same brain", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow({ supersededById: NEWER })], [{ id: NEWER, title: "newer" }], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });
    await explainMemoryProvenance(db, BRAIN, MEM);

    for (const call of selects.filter(
      (candidate) => candidate.table === MEMORY_TABLE || candidate.table === LINK_TABLE
    )) {
      expect(describeSql(call.where)).toContain(BRAIN);
    }
  });
});

describe("explainMemoryProvenance — authorship", () => {
  it("reports a user-created memory as such and does not look up an agent", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.createdBy).toBe("user");
    expect(provenance?.createdByUserId).toBe(USER);
    expect(provenance?.createdByAgentId).toBeNull();
    expect(provenance?.createdByAgentName).toBeNull();
    expect(selects.some((call) => call.table === AGENT_TABLE)).toBe(false);
  });

  it("names the agent that wrote an agent-created memory", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow({ createdBy: null, createdByAgent: AGENT })], []],
      [AGENT_TABLE]: [[{ name: "OpenClaw" }]],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.createdBy).toBe("agent");
    expect(provenance?.createdByAgentId).toBe(AGENT);
    expect(provenance?.createdByAgentName).toBe("OpenClaw");
  });

  it("keeps the agent id without a name when the agent record is gone", async () => {
    // A revoked credential must not turn into a fabricated author.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow({ createdBy: null, createdByAgent: AGENT })], []],
      [AGENT_TABLE]: [[]],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.createdByAgentId).toBe(AGENT);
    expect(provenance?.createdByAgentName).toBeNull();
  });

  it("carries the source that produced it verbatim", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow({ sourceType: "import", sourceId: "archive-42" })], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.sourceType).toBe("import");
    expect(provenance?.sourceId).toBe("archive-42");
  });
});

describe("explainMemoryProvenance — evolution", () => {
  it("reports no edits for a memory that was never changed", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.versionCount).toBe(0);
    expect(provenance?.lastUpdatedBy).toBeNull();
    expect(provenance?.lastChangeReason).toBeNull();
    expect(provenance?.lastUpdated).toEqual(t("2026-03-01T00:00:00.000Z"));
  });

  it("attributes the most recent edit to the user who made it", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [
        [
          {
            versionNumber: 3,
            createdAt: t("2026-03-01T00:00:00.000Z"),
            changedBy: USER,
            changedByAgent: null,
            changeReason: "corrected the region",
          },
        ],
        [{ count: 3 }],
      ],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.versionCount).toBe(3);
    expect(provenance?.lastUpdatedBy).toBe("user");
    expect(provenance?.lastChangeReason).toBe("corrected the region");
  });

  it("attributes an agent edit to the agent", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [
        [
          {
            versionNumber: 2,
            createdAt: t("2026-02-01T00:00:00.000Z"),
            changedBy: null,
            changedByAgent: AGENT,
            changeReason: null,
          },
        ],
        [{ count: 2 }],
      ],
      [LINK_TABLE]: [[]],
    });

    expect((await explainMemoryProvenance(db, BRAIN, MEM))?.lastUpdatedBy).toBe("agent");
  });

  it("reads the newest version first", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });
    await explainMemoryProvenance(db, BRAIN, MEM);

    const versionRead = selects.find((call) => call.table === VERSION_TABLE)!;
    expect(versionRead.limit).toBe(1);
    expect(describeSql(versionRead.where)).toContain(MEM);
  });
});

describe("explainMemoryProvenance — supersession chains", () => {
  it("names the memory that replaced this one, and the ones it replaced", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [memoryRow({ validityState: "superseded", supersededById: NEWER })],
        [{ id: NEWER, title: "We deploy on Fly" }],
        [{ id: OLDER, title: "We deploy on Vercel" }],
      ],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.supersededById).toBe(NEWER);
    expect(provenance?.supersededBy).toEqual({ id: NEWER, title: "We deploy on Fly" });
    expect(provenance?.supersedes).toEqual([{ id: OLDER, title: "We deploy on Vercel" }]);
  });

  it("keeps the pointer but reports no replacement it cannot resolve", async () => {
    // No dangling edge is ever presented as a resolved one.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow({ supersededById: NEWER })], [], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.supersededById).toBe(NEWER);
    expect(provenance?.supersededBy).toBeNull();
  });

  it("does not query for a replacement when there is no pointer", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });
    await explainMemoryProvenance(db, BRAIN, MEM);

    // Two memory reads: the memory itself and its backlinks — not three.
    expect(selects.filter((call) => call.table === MEMORY_TABLE)).toHaveLength(2);
  });

  it("looks for what it supersedes by backlink, excluding deleted rows", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });
    await explainMemoryProvenance(db, BRAIN, MEM);

    const backlinkRead = selects.filter((call) => call.table === MEMORY_TABLE)[1];
    const where = describeSql(backlinkRead.where);
    expect(where).toContain("superseded_by_id");
    expect(where).toContain("deleted_at");
    expect(where).toContain(BRAIN);
  });
});

describe("explainMemoryProvenance — lineage", () => {
  it("reports the memories this one was derived from, with the link that says so", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [memoryRow()],
        [],
        [
          { id: OLDER, title: "Meeting notes" },
          { id: NEWER, title: "Runbook" },
        ],
      ],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [
        [
          { targetMemoryId: OLDER, linkType: "derived_from" },
          { targetMemoryId: NEWER, linkType: "consolidated_from" },
        ],
      ],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.sourceMemories).toEqual([
      { id: OLDER, title: "Meeting notes", linkType: "derived_from" },
      { id: NEWER, title: "Runbook", linkType: "consolidated_from" },
    ]);
  });

  it("asks only for lineage link types, never every link", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });
    await explainMemoryProvenance(db, BRAIN, MEM);

    const where = describeSql(selects.find((call) => call.table === LINK_TABLE)!.where);
    expect(where).toContain("derived_from");
    expect(where).toContain("consolidated_from");
    expect(where).toContain("extracted_from");
    // A plain "relates_to" is not provenance and must not be presented as it.
    expect(where).not.toContain("relates_to");
  });

  it("drops a source it cannot see rather than showing an id with no title", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], [], [{ id: OLDER, title: "Meeting notes" }]],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [
        [
          { targetMemoryId: OLDER, linkType: "derived_from" },
          { targetMemoryId: NEWER, linkType: "derived_from" },
        ],
      ],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.sourceMemories.map((source) => source.id)).toEqual([OLDER]);
  });

  it("skips the source lookup entirely when there is no lineage", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.sourceMemories).toEqual([]);
    expect(selects.filter((call) => call.table === MEMORY_TABLE)).toHaveLength(2);
  });

  it("ignores a lineage link whose target is not a memory", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[{ targetMemoryId: null, linkType: "derived_from" }]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);
    expect(provenance?.sourceMemories).toEqual([]);
  });
});

/**
 * PHASE 2. A provenance report that blurred "somebody said so" with "the scorer
 * suspects so" would be exactly the wrong answer to "where did this come from?", so
 * the computed edges get their own field, their evidence, and their scorer version.
 */
const DERIVED_TABLE = getTableName(schema.memoryDerivedLinks);

function derivedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "edge-1",
    brainId: BRAIN,
    sourceMemoryId: MEM,
    targetMemoryId: OLDER,
    origin: "derived",
    status: "applied",
    relation: "semantic",
    weight: 0.51,
    confidence: 0.4,
    reason: "shared terms: hetzner, deploy",
    evidence: { sharedTerms: ["hetzner", "deploy"], signalFamilyCount: 1 },
    computedBy: "relate-v1",
    updatedAt: t("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("explainMemoryProvenance — algorithmic inferences", () => {
  it("reports a computed edge with the evidence needed to audit it", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], [], [{ id: OLDER, title: "Meeting notes" }]],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
      [DERIVED_TABLE]: [[derivedRow()]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);

    expect(provenance?.derivedRelationships).toEqual([
      {
        id: OLDER,
        title: "Meeting notes",
        origin: "derived",
        status: "applied",
        relation: "semantic",
        weight: 0.51,
        confidence: 0.4,
        reason: "shared terms: hetzner, deploy",
        evidence: { sharedTerms: ["hetzner", "deploy"], signalFamilyCount: 1 },
        computedBy: "relate-v1",
        computedAt: t("2026-04-01T00:00:00.000Z"),
      },
    ]);
    // Lineage the user asserted stays empty: an inference never becomes lineage.
    expect(provenance?.sourceMemories).toEqual([]);
    expect(provenance?.supersedes).toEqual([]);
  });

  it("resolves the other endpoint whichever end of the edge this memory sits on", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], [], [{ id: NEWER, title: "Newer note" }]],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
      [DERIVED_TABLE]: [[derivedRow({ sourceMemoryId: NEWER, targetMemoryId: MEM })]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);

    expect(provenance?.derivedRelationships.map((r) => r.id)).toEqual([NEWER]);
  });

  it("reports suggestions too, because this is an audit surface", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [
        [memoryRow()],
        [],
        [
          { id: OLDER, title: "Meeting notes" },
          { id: NEWER, title: "Newer note" },
        ],
      ],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
      [DERIVED_TABLE]: [
        [
          derivedRow(),
          derivedRow({
            id: "edge-2",
            targetMemoryId: NEWER,
            origin: "inferred",
            status: "suggested",
          }),
        ],
      ],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);

    expect(provenance?.derivedRelationships.map((r) => [r.id, r.status, r.origin])).toEqual([
      [OLDER, "applied", "derived"],
      [NEWER, "suggested", "inferred"],
    ]);
    // "The scorer suspected this but did not apply it" is information the reader wants,
    // so unlike brain_related this read must not filter by status.
    const [derivedCall] = selects.filter((call) => call.table === DERIVED_TABLE);
    expect(describeSql(derivedCall.where)).not.toContain("applied");
  });

  it("omits an inference whose other endpoint this brain cannot see", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], [], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
      [DERIVED_TABLE]: [[derivedRow()]],
    });

    const provenance = await explainMemoryProvenance(db, BRAIN, MEM);

    // Deleted, or in another brain: a dangling id is worse than silence.
    expect(provenance?.derivedRelationships).toEqual([]);
  });

  it("fences the inference read to this brain and bounds it", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[memoryRow()], [], []],
      [VERSION_TABLE]: [[], [{ count: 0 }]],
      [LINK_TABLE]: [[]],
      [DERIVED_TABLE]: [[]],
    });

    await explainMemoryProvenance(db, BRAIN, MEM);

    const [derivedCall] = selects.filter((call) => call.table === DERIVED_TABLE);
    expect(describeSql(derivedCall.where)).toContain("brain_id");
    expect(derivedCall.limit).toBe(40);
  });

  it("does not look for inferences in another brain's copy of the memory", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });

    const provenance = await explainMemoryProvenance(db, OTHER_BRAIN, MEM);

    expect(provenance).toBeNull();
    expect(selects.filter((call) => call.table === DERIVED_TABLE)).toEqual([]);
  });
});
