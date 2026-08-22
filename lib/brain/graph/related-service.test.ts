import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";

/**
 * `brain_related` (P4). The seed's relatives come from four independent readings of
 * the brain — recorded links, graph proximity, lexical relevance and shared entities
 * — and the value of the tool is entirely in how they are merged: a recorded link
 * must outrank a guess, every result must say why it is here, and nothing may be
 * reported that this brain cannot see.
 *
 * Retrieval is mocked because it is exercised in depth by its own suite; what matters
 * here is that its verdict is combined honestly.
 */

const retrieveMemories = vi.fn();

vi.mock("../retrieval/retrieve", () => ({
  retrieveMemories: (...args: unknown[]) => retrieveMemories(...args),
}));

const { findRelatedMemories } = await import("./related-service");

type SelectCall = { table: string; columns: string[]; limit: number | null; where: unknown };

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
 * The service reads `memories` twice (the seed, then the candidates' titles) and
 * `memory_links` three times (outbound, inbound, whole graph), so queued results are
 * ordered per table.
 */
function recordingDb(queues: Record<string, unknown[][]> = {}) {
  const selects: SelectCall[] = [];
  const cursors = new Map<string, number>();

  const db = {
    select(projection?: Record<string, unknown>) {
      const call: SelectCall = { table: "", columns: Object.keys(projection ?? {}), limit: null, where: null };
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
const SEED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEAR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FAR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEXICAL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const MEMORY_TABLE = getTableName(schema.memories);
const LINK_TABLE = getTableName(schema.memoryLinks);

const seedRow = { id: SEED, title: "Deploy target", projectId: null };

/** No candidate came back from retrieval. */
const noRetrieval = { results: [] };

function retrieval(results: Array<{ id: string; score: number; legs: string[] }>) {
  return {
    results: results.map((result) => ({
      id: result.id,
      score: { score: result.score },
      legs: result.legs,
    })),
  };
}

beforeEach(() => {
  retrieveMemories.mockReset();
  retrieveMemories.mockResolvedValue(noRetrieval);
});

describe("findRelatedMemories — the seed", () => {
  it("returns nothing for a seed this brain does not hold, and reads nothing further", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await expect(findRelatedMemories(db, BRAIN, SEED)).resolves.toEqual([]);
    expect(selects).toHaveLength(1);
    expect(retrieveMemories).not.toHaveBeenCalled();
  });

  it("fences the seed lookup to the brain and undeleted rows", async () => {
    const { db, selects } = recordingDb({ [MEMORY_TABLE]: [[]] });
    await findRelatedMemories(db, BRAIN, SEED);

    const where = describeSql(selects[0].where);
    expect(where).toContain(BRAIN);
    expect(where).toContain(SEED);
    expect(where).toContain("deleted_at");
  });

  it("never reports the seed as its own relative", async () => {
    retrieveMemories.mockResolvedValue(retrieval([{ id: SEED, score: 0.9, legs: ["lexical"] }]));
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: SEED, title: "Deploy target", type: "fact" }]],
      [LINK_TABLE]: [[], [], []],
    });

    await expect(findRelatedMemories(db, BRAIN, SEED)).resolves.toEqual([]);
  });

  it("searches with the seed's own title, inside the seed's project", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[{ ...seedRow, projectId: "project-1" }]],
      [LINK_TABLE]: [[], [], []],
    });
    await findRelatedMemories(db, BRAIN, SEED, 5);

    expect(retrieveMemories).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        brainId: BRAIN,
        query: "Deploy target",
        projectId: "project-1",
        includeArchived: false,
      })
    );
  });
});

describe("findRelatedMemories — recorded links", () => {
  it("reports an outbound link with its type and the top score", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "Hetzner runbook", type: "procedure" }]],
      [LINK_TABLE]: [[{ memoryId: NEAR, linkType: "supersedes" }], [], []],
    });

    const [related] = await findRelatedMemories(db, BRAIN, SEED);
    expect(related).toMatchObject({
      id: NEAR,
      title: "Hetzner runbook",
      type: "procedure",
      score: 1,
      reason: "direct_link",
      linkType: "supersedes",
    });
  });

  it("finds a backlink too: relatedness is not directional", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: FAR, title: "Older note", type: "fact" }]],
      [LINK_TABLE]: [[], [{ memoryId: FAR, linkType: "derived_from" }], []],
    });

    const [related] = await findRelatedMemories(db, BRAIN, SEED);
    expect(related.id).toBe(FAR);
    expect(related.linkType).toBe("derived_from");
  });

  it("keeps the outbound link type when both directions exist", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "Runbook", type: "fact" }]],
      [LINK_TABLE]: [
        [{ memoryId: NEAR, linkType: "supersedes" }],
        [{ memoryId: NEAR, linkType: "related_to" }],
        [],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);
    expect(results).toHaveLength(1);
    expect(results[0].linkType).toBe("supersedes");
  });

  it("scopes both link reads to the brain and to memory targets", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[seedRow]],
      [LINK_TABLE]: [[], [], []],
    });
    await findRelatedMemories(db, BRAIN, SEED);

    for (const call of selects.filter((candidate) => candidate.table === LINK_TABLE)) {
      const where = describeSql(call.where);
      expect(where).toContain(BRAIN);
      expect(where).toContain("memory");
    }
  });
});

describe("findRelatedMemories — graph proximity", () => {
  it("reaches a two-hop neighbour and says how far away it is", async () => {
    // SEED → NEAR → FAR, and only the whole-graph read knows about the second edge.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [seedRow],
        [
          { id: NEAR, title: "One hop", type: "fact" },
          { id: FAR, title: "Two hops", type: "fact" },
        ],
      ],
      [LINK_TABLE]: [
        [],
        [],
        [
          { sourceMemoryId: SEED, targetMemoryId: NEAR, linkType: "related_to" },
          { sourceMemoryId: NEAR, targetMemoryId: FAR, linkType: "related_to" },
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED, 20, 2);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get(NEAR)).toMatchObject({ reason: "graph_proximity", hops: 1 });
    expect(byId.get(FAR)).toMatchObject({ reason: "graph_proximity", hops: 2 });
    // Closer is stronger.
    expect(byId.get(NEAR)!.score).toBeGreaterThan(byId.get(FAR)!.score);
  });

  it("honours maxHops instead of walking the whole brain", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "One hop", type: "fact" }]],
      [LINK_TABLE]: [
        [],
        [],
        [
          { sourceMemoryId: SEED, targetMemoryId: NEAR, linkType: "related_to" },
          { sourceMemoryId: NEAR, targetMemoryId: FAR, linkType: "related_to" },
        ],
      ],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED, 20, 1);
    expect(results.map((result) => result.id)).toEqual([NEAR]);
  });

  it("ignores a link row whose memory target is null", async () => {
    // An entity-anchored row must not become a phantom memory edge.
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow]],
      [LINK_TABLE]: [[], [], [{ sourceMemoryId: SEED, targetMemoryId: null, linkType: "mentions" }]],
    });

    await expect(findRelatedMemories(db, BRAIN, SEED)).resolves.toEqual([]);
  });

  it("does not let proximity overwrite a recorded link", async () => {
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "Runbook", type: "fact" }]],
      [LINK_TABLE]: [
        [{ memoryId: NEAR, linkType: "supersedes" }],
        [],
        [{ sourceMemoryId: SEED, targetMemoryId: NEAR, linkType: "supersedes" }],
      ],
    });

    const [related] = await findRelatedMemories(db, BRAIN, SEED);
    expect(related.reason).toBe("direct_link");
    expect(related.score).toBe(1);
  });
});

describe("findRelatedMemories — retrieval legs and ranking", () => {
  it("names the legs that voted rather than calling everything 'semantic'", async () => {
    retrieveMemories.mockResolvedValue(
      retrieval([{ id: LEXICAL, score: 0.7, legs: ["lexical", "entity"] }])
    );
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: LEXICAL, title: "Also about deploys", type: "fact" }]],
      [LINK_TABLE]: [[], [], []],
    });

    const [related] = await findRelatedMemories(db, BRAIN, SEED);
    expect(related.reason).toContain("lexical_match");
    expect(related.reason).toContain("shared_entity");
  });

  it("falls back to a plain label when no leg is recognisable", async () => {
    retrieveMemories.mockResolvedValue(retrieval([{ id: LEXICAL, score: 0.4, legs: ["recency"] }]));
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: LEXICAL, title: "Recent note", type: "fact" }]],
      [LINK_TABLE]: [[], [], []],
    });

    expect((await findRelatedMemories(db, BRAIN, SEED))[0].reason).toBe("semantic");
  });

  it("discounts a retrieval-only match below a recorded link", async () => {
    // A perfect retrieval score still loses to an edge a person recorded.
    retrieveMemories.mockResolvedValue(retrieval([{ id: LEXICAL, score: 1, legs: ["lexical"] }]));
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [seedRow],
        [
          { id: NEAR, title: "Linked", type: "fact" },
          { id: LEXICAL, title: "Merely similar", type: "fact" },
        ],
      ],
      [LINK_TABLE]: [[{ memoryId: NEAR, linkType: "related_to" }], [], []],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);
    expect(results.map((result) => result.id)).toEqual([NEAR, LEXICAL]);
    expect(results[1].score).toBeLessThan(results[0].score);
  });

  it("adds retrieval's reason to a hit it already had, without double counting", async () => {
    retrieveMemories.mockResolvedValue(retrieval([{ id: NEAR, score: 1, legs: ["lexical"] }]));
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "Linked", type: "fact" }]],
      [LINK_TABLE]: [[{ memoryId: NEAR, linkType: "related_to" }], [], []],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);
    expect(results).toHaveLength(1);
    expect(results[0].reason).toBe("direct_link, lexical_match");
    // Scores are combined by max, never summed: relatedness stays in [0, 1].
    expect(results[0].score).toBe(1);
  });

  it("returns results in descending score order, capped at maxResults", async () => {
    retrieveMemories.mockResolvedValue(
      retrieval([
        { id: FAR, score: 0.9, legs: ["lexical"] },
        { id: LEXICAL, score: 0.2, legs: ["lexical"] },
      ])
    );
    const { db } = recordingDb({
      [MEMORY_TABLE]: [
        [seedRow],
        [
          { id: FAR, title: "Strong", type: "fact" },
          { id: LEXICAL, title: "Weak", type: "fact" },
        ],
      ],
      [LINK_TABLE]: [[], [], []],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED, 1);
    expect(results.map((result) => result.id)).toEqual([FAR]);
  });
});

describe("findRelatedMemories — tenant isolation", () => {
  it("drops a candidate whose row this brain cannot read", async () => {
    // The link exists, but the memory it names is deleted or belongs elsewhere: it is
    // omitted entirely rather than surfaced as an untitled id.
    retrieveMemories.mockResolvedValue(retrieval([{ id: FAR, score: 0.6, legs: ["lexical"] }]));
    const { db } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "Visible", type: "fact" }]],
      [LINK_TABLE]: [[{ memoryId: NEAR, linkType: "related_to" }], [], []],
    });

    const results = await findRelatedMemories(db, BRAIN, SEED);
    expect(results.map((result) => result.id)).toEqual([NEAR]);
  });

  it("fences the metadata read to the brain and undeleted rows", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[seedRow], [{ id: NEAR, title: "Visible", type: "fact" }]],
      [LINK_TABLE]: [[{ memoryId: NEAR, linkType: "related_to" }], [], []],
    });
    await findRelatedMemories(db, BRAIN, SEED);

    const metadataRead = selects.filter((call) => call.table === MEMORY_TABLE)[1];
    const where = describeSql(metadataRead.where);
    expect(where).toContain(BRAIN);
    expect(where).toContain("deleted_at");
    expect(where).toContain(NEAR);
  });

  it("skips the metadata read when nothing was found", async () => {
    const { db, selects } = recordingDb({
      [MEMORY_TABLE]: [[seedRow]],
      [LINK_TABLE]: [[], [], []],
    });

    await expect(findRelatedMemories(db, BRAIN, SEED)).resolves.toEqual([]);
    expect(selects.filter((call) => call.table === MEMORY_TABLE)).toHaveLength(1);
  });
});
