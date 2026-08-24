import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brainAccess,
  brainProjects,
  brains,
  memories,
  memoryDerivedLinks,
  users,
} from "@/lib/db/schema";
import { rememberMemory } from "@/lib/brain/remember";
import { updateMemory } from "@/lib/brain/memory-service";
import { buildContext } from "@/lib/brain/context-engine";
import { findRelatedMemories } from "@/lib/brain/graph/related-service";
import { explainMemoryProvenance } from "@/lib/brain/provenance-service";
import {
  RELATE_POLICY,
  RELATE_VERSION,
  deleteDerivedEdgesFor,
  loadDerivedNeighbors,
  reconcileDerivedEdges,
  type DerivedEdgeInput,
} from "@/lib/brain/graph/derived-link-service";
import { runRelateBrainJob, runRelateMemoryJob } from "@/lib/brain/graph/relate-jobs";

/**
 * PHASE 2 against real PostgreSQL: migration 0020's constraints, the derived-link
 * lifecycle, the two job bodies, the three read paths, and brain isolation.
 *
 * Everything here needs a live database, because everything here is about what
 * Postgres itself enforces — CHECK constraints, the brain-scoped unique index, FK
 * CASCADE, and the `xmax = 0` insert/update split inside a transaction. A fake query
 * builder can only prove the SQL was *shaped* right; these prove it *holds*.
 *
 * Not run by default. Two conditions, both reported clearly when unmet:
 *   DATABASE_URL=postgres://... npx vitest run tests/brain-phase2-db.test.ts
 * and migration 0020 applied to that database (npx tsx scripts/apply-migration.ts
 * drizzle/0020_phase2_derived_relationships.sql, verified with
 * scripts/verify-derived-schema.ts).
 *
 * The suite writes only inside two brains it creates and deletes, both owned by a
 * throwaway user. It never touches an existing row.
 */

// No Redis in a test run: the write paths fire-and-forget a relate job, and a queue
// that is absent must not turn into a hanging connect attempt here.
process.env.REDIS_DISABLED = "true";

const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);

/** Is migration 0020 applied? Asked once, before the suite is declared. */
async function derivedTableExists(): Promise<boolean> {
  try {
    const rows = (await db.execute(
      sql`SELECT to_regclass('public.memory_derived_links')::text AS reg`
    )) as unknown as Array<{ reg: string | null }>;
    return Boolean(rows[0]?.reg);
  } catch {
    return false;
  }
}

const MIGRATED = DATABASE_AVAILABLE ? await derivedTableExists() : false;

if (DATABASE_AVAILABLE && !MIGRATED) {
  console.warn(
    "[brain-phase2-db] SKIPPED: memory_derived_links is missing from this database. " +
      "Apply drizzle/0020_phase2_derived_relationships.sql first."
  );
}

const principalOf = (userId: string) => ({ userId, agentId: null });

/** The corpus, by role. Titles are what a real brain would hold, not lorem. */
const CORPUS = {
  identity: {
    title: "Ari owns and operates Storage ByAFR",
    content: "Ari is the owner and sole operator of the Storage ByAFR platform.",
    type: "fact" as const,
    tags: ["identity"],
  },
  preference: {
    title: "Prefers concise Indonesian replies",
    content: "Ari prefers short replies in Indonesian, no emoji, and no unrequested refactors.",
    type: "preference" as const,
    tags: ["preference"],
  },
  deploy: {
    title: "Deployment runbook for the hetzner box",
    content:
      "Always run pending drizzle migrations against neon before deploying the app to the hetzner box.",
    type: "procedure" as const,
    tags: ["deployment", "hetzner"],
  },
  migration: {
    title: "Migration order matters before a hetzner deploy",
    content:
      "Pending drizzle migrations must be applied to neon first, otherwise the hetzner deploy serves a schema the app does not expect.",
    type: "knowledge" as const,
    tags: ["deployment", "hetzner"],
  },
  /** Near-duplicate of `deploy`: same instruction, reworded. */
  nearDuplicate: {
    title: "Hetzner deploy checklist",
    content:
      "Run the pending drizzle migrations against neon before you deploy the app to the hetzner box.",
    type: "procedure" as const,
    tags: ["deployment", "hetzner"],
  },
  /** Shares nothing with the deployment cluster: no terms, no tags, no project. */
  unrelated: {
    title: "Invoice PDF template uses the coral heading",
    content: "The generated invoice PDF renders its heading in coral with a serif subtitle.",
    type: "knowledge" as const,
    tags: ["billing"],
  },
  projectDecision: {
    title: "Chose R2 for object storage in Storage ByAFR",
    content:
      "Storage ByAFR keeps uploaded objects in cloudflare r2 because egress is free at our volume.",
    type: "decision" as const,
    tags: ["storage", "r2"],
  },
  projectNote: {
    title: "R2 lifecycle rules for Storage ByAFR uploads",
    content:
      "Cloudflare r2 lifecycle rules expire abandoned multipart uploads in Storage ByAFR after seven days.",
    type: "knowledge" as const,
    tags: ["storage", "r2"],
  },
} as const;

type CorpusKey = keyof typeof CORPUS;

type Fixture = {
  userId: string;
  brainId: string;
  otherBrainId: string;
  projectId: string;
  /** memory id per corpus role */
  ids: Record<CorpusKey, string>;
  /** contentHash per memory id, as the scorer records it on an edge */
  hashes: Map<string, string>;
  /** The same deployment runbook, stored in the *other* brain. */
  otherDeployId: string;
};

/**
 * Build the corpus through the real write path (`rememberMemory` → `createMemory`), so
 * tags, contentHash and the tsvector are whatever production would have produced.
 */
async function buildFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(users)
    .values({
      username: `brain-phase2-db-${crypto.randomUUID()}`,
      passwordHash: "integration-test-not-a-real-hash",
    })
    .returning();

  const [brain] = await db
    .insert(brains)
    .values({ name: "PHASE 2 DB Brain", ownerUserId: user.id })
    .returning();

  const [otherBrain] = await db
    .insert(brains)
    .values({ name: "PHASE 2 DB Other Brain", ownerUserId: user.id })
    .returning();

  for (const brainId of [brain.id, otherBrain.id]) {
    await db.insert(brainAccess).values({
      brainId,
      principalType: "user",
      principalId: user.id,
      role: "owner",
    });
  }

  const [project] = await db
    .insert(brainProjects)
    .values({ brainId: brain.id, name: "Storage ByAFR" })
    .returning();

  const ids = {} as Record<CorpusKey, string>;
  for (const [key, data] of Object.entries(CORPUS) as Array<[CorpusKey, typeof CORPUS[CorpusKey]]>) {
    const outcome = await rememberMemory({
      brainId: brain.id,
      principal: principalOf(user.id),
      data: { ...data, tags: [...data.tags], importance: 0.7, confidence: 0.9 },
    });
    ids[key] = outcome.memory.id;
  }

  // Project knowledge goes through the PATCH path on purpose: `updateMemory` with
  // `projectId` as the only change is the regression fixed in this pass, and here it
  // runs against the real column rather than a recording fake.
  for (const key of ["projectDecision", "projectNote"] as const) {
    const updated = await updateMemory({
      brainId: brain.id,
      memoryId: ids[key],
      principal: principalOf(user.id),
      data: { projectId: project.id },
    });
    if (updated.projectId !== project.id) {
      throw new Error(`fixture: projectId did not stick on ${key}`);
    }
  }

  const twin = await rememberMemory({
    brainId: otherBrain.id,
    principal: principalOf(user.id),
    data: {
      ...CORPUS.deploy,
      tags: [...CORPUS.deploy.tags],
      importance: 0.7,
      confidence: 0.9,
    },
  });

  const hashRows = await db
    .select({ id: memories.id, contentHash: memories.contentHash })
    .from(memories)
    .where(eq(memories.brainId, brain.id));

  return {
    userId: user.id,
    brainId: brain.id,
    otherBrainId: otherBrain.id,
    projectId: project.id,
    ids,
    hashes: new Map(hashRows.map((row) => [row.id, row.contentHash ?? ""])),
    otherDeployId: twin.memory.id,
  };
}

/**
 * 60s per test instead of the 5s default, for this file only.
 *
 * These tests speak to a hosted Postgres over the network: one `buildContext` call is
 * dozens of round trips, and at ~40ms each the read-path tests legitimately take 15-20
 * seconds. The default timeout would fail them for being remote rather than for being
 * wrong — and worse, a timed-out test's queries keep running into the next test, which
 * then fails on rows it never inserted. Set here rather than in vitest.config.ts so the
 * 1400 unit tests keep their tight timeout.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

describe.skipIf(!MIGRATED)("PHASE 2 derived links against real Postgres", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await buildFixture();
  }, 60_000);

  afterAll(async () => {
    // Brain delete cascades memories, tags, links and derived edges; the user follows.
    if (fx?.brainId) await db.delete(brains).where(eq(brains.id, fx.brainId));
    if (fx?.otherBrainId) await db.delete(brains).where(eq(brains.id, fx.otherBrainId));
    if (fx?.userId) await db.delete(users).where(eq(users.id, fx.userId));
  });

  /** Every test starts from an empty derived graph in both brains. */
  beforeEach(async () => {
    await db
      .delete(memoryDerivedLinks)
      .where(inArray(memoryDerivedLinks.brainId, [fx.brainId, fx.otherBrainId]));
  });

  /** One well-formed edge between two of the fixture's memories. */
  const edgeBetween = (a: string, b: string, overrides: Partial<DerivedEdgeInput> = {}): DerivedEdgeInput => ({
    memoryA: a,
    memoryB: b,
    origin: "derived",
    relation: "semantic",
    weight: 0.5,
    confidence: 0.5,
    evidence: { signals: { semantic: { similarity: 0.4 } }, signalFamilyCount: 1 },
    reason: "shared terms: hetzner, migrations",
    hashA: fx.hashes.get(a) ?? "",
    hashB: fx.hashes.get(b) ?? "",
    ...overrides,
  });

  const rowsFor = (brainId: string) =>
    db.select().from(memoryDerivedLinks).where(eq(memoryDerivedLinks.brainId, brainId));

  const edgesTouching = (brainId: string, memoryId: string) =>
    db
      .select()
      .from(memoryDerivedLinks)
      .where(
        and(
          eq(memoryDerivedLinks.brainId, brainId),
          sql`(${memoryDerivedLinks.sourceMemoryId} = ${memoryId} OR ${memoryDerivedLinks.targetMemoryId} = ${memoryId})`
        )
      );

  /**
   * Assert that the *database* rejected a write, for the stated reason.
   *
   * `rejects.toThrow(/constraint_name/)` does not work here: Drizzle wraps the driver
   * error and its `message` is only "Failed query: insert into …", so that assertion
   * would pass for any failed insert — including one that failed for a reason the test
   * was not looking for. The constraint name lives on the postgres.js error underneath,
   * so the whole cause chain is what gets matched.
   */
  async function expectRejection(run: () => Promise<unknown>, pattern: RegExp) {
    let caught: unknown;
    try {
      await run();
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected the database to reject this row, but it was accepted").toBeDefined();

    const parts: string[] = [];
    let error: unknown = caught;
    for (let depth = 0; error && depth < 5; depth += 1) {
      const fields = error as Record<string, unknown>;
      for (const key of ["message", "constraint_name", "detail", "code", "table_name"]) {
        if (fields[key]) parts.push(String(fields[key]));
      }
      error = fields.cause;
    }
    expect(parts.join(" | ")).toMatch(pattern);
  }

  describe("migration 0020: what the database itself refuses", () => {
    /** A raw row, bypassing the service layer — the point is the DDL, not the code. */
    const rawRow = (overrides: Record<string, unknown>) => ({
      brainId: fx.brainId,
      sourceMemoryId: fx.ids.deploy,
      targetMemoryId: fx.ids.migration,
      origin: "derived" as const,
      relation: "semantic",
      weight: 0.5,
      confidence: 0.5,
      reason: "raw insert",
      computedBy: RELATE_VERSION,
      ...overrides,
    });

    const insertRaw = (overrides: Record<string, unknown>) =>
      db.insert(memoryDerivedLinks).values(rawRow(overrides));

    it("accepts a canonical row", async () => {
      const [lo, hi] = [fx.ids.deploy, fx.ids.migration].sort();
      await insertRaw({ sourceMemoryId: lo, targetMemoryId: hi });
      expect(await rowsFor(fx.brainId)).toHaveLength(1);
    });

    it("rejects a pair stored in the wrong order", async () => {
      const [lo, hi] = [fx.ids.deploy, fx.ids.migration].sort();
      // Without this the same relationship could exist twice, once per direction, and
      // every reader would have to de-duplicate defensively.
      await expectRejection(
        () => insertRaw({ sourceMemoryId: hi, targetMemoryId: lo }),
        /memory_derived_links_canonical/
      );
    });

    it("rejects a self-edge", async () => {
      // Either guard is a correct answer. `source < target` already fails on equality,
      // so Postgres reports the canonical check first and never reaches no_self; that
      // constraint is deliberate redundancy for the day the ordering rule is relaxed.
      await expectRejection(
        () => insertRaw({ sourceMemoryId: fx.ids.deploy, targetMemoryId: fx.ids.deploy }),
        /memory_derived_links_(no_self|canonical)/
      );
    });

    it("rejects a weight or confidence outside 0..1", async () => {
      const [lo, hi] = [fx.ids.deploy, fx.ids.migration].sort();
      await expectRejection(
        () => insertRaw({ sourceMemoryId: lo, targetMemoryId: hi, weight: 1.5 }),
        /memory_derived_links_weight/
      );
      await expectRejection(
        () => insertRaw({ sourceMemoryId: lo, targetMemoryId: hi, confidence: -0.2 }),
        /memory_derived_links_confidence/
      );
    });

    it("rejects a second row for the same pair in the same brain", async () => {
      const [lo, hi] = [fx.ids.deploy, fx.ids.migration].sort();
      await insertRaw({ sourceMemoryId: lo, targetMemoryId: hi });
      await expectRejection(
        () => insertRaw({ sourceMemoryId: lo, targetMemoryId: hi, relation: "tag" }),
        /memory_derived_links_pair_unique/
      );
    });

    it("rejects an endpoint that is not a memory", async () => {
      const [lo] = [fx.ids.deploy, fx.ids.migration].sort();
      await expectRejection(
        () => insertRaw({ sourceMemoryId: lo, targetMemoryId: crypto.randomUUID() }),
        /foreign key|violates|23503/i
      );
    });

    it("drops a memory's edges when the memory row is hard-deleted", async () => {
      await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, [
        edgeBetween(fx.ids.deploy, fx.ids.migration),
      ]);
      expect(await rowsFor(fx.brainId)).toHaveLength(1);

      // A hard delete of an endpoint must not leave an edge pointing at nothing. (The
      // soft-delete path cannot rely on this, which is why `deleteMemory` calls
      // `deleteDerivedEdgesFor` explicitly.)
      const throwaway = await rememberMemory({
        brainId: fx.brainId,
        principal: principalOf(fx.userId),
        data: { title: "Temporary endpoint", content: "Deleted by the cascade test.", type: "fact" },
      });
      await reconcileDerivedEdges(db, fx.brainId, throwaway.memory.id, [
        edgeBetween(throwaway.memory.id, fx.ids.migration),
      ]);
      expect(await rowsFor(fx.brainId)).toHaveLength(2);

      await db.delete(memories).where(eq(memories.id, throwaway.memory.id));

      const left = await rowsFor(fx.brainId);
      expect(left).toHaveLength(1);
      expect(left[0].sourceMemoryId === throwaway.memory.id).toBe(false);
      expect(left[0].targetMemoryId === throwaway.memory.id).toBe(false);
    });

  });

  describe("the derived-link lifecycle", () => {
    it("inserts, then converges on the same rows when run again", async () => {
      const edges = [
        edgeBetween(fx.ids.deploy, fx.ids.migration),
        edgeBetween(fx.ids.deploy, fx.ids.nearDuplicate, { weight: 0.6, confidence: 0.6 }),
      ];

      const first = await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, edges);
      expect(first).toMatchObject({ inserted: 2, updated: 0, deleted: 0 });

      const second = await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, edges);
      // The reconcile deletes its own rows first, so a re-run re-inserts rather than
      // updating — what matters is that the graph does not grow.
      expect(second.inserted + second.updated).toBe(2);
      expect(second.deleted).toBe(2);
      expect(await rowsFor(fx.brainId)).toHaveLength(2);
    });

    it("stores the pair canonically and keeps each hash with its own memory", async () => {
      const [lo, hi] = [fx.ids.deploy, fx.ids.migration].sort();
      // Deliberately the wrong way round: the service has to swap the ids *and* the
      // hashes, or a correctly-scored edge would look permanently stale.
      await reconcileDerivedEdges(db, fx.brainId, hi, [edgeBetween(hi, lo)]);

      const [row] = await rowsFor(fx.brainId);
      expect(row.sourceMemoryId).toBe(lo);
      expect(row.targetMemoryId).toBe(hi);
      expect(row.sourceHashA).toBe(fx.hashes.get(lo));
      expect(row.sourceHashB).toBe(fx.hashes.get(hi));
    });

    it("removes an edge that is no longer scored", async () => {
      await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, [
        edgeBetween(fx.ids.deploy, fx.ids.migration),
        edgeBetween(fx.ids.deploy, fx.ids.nearDuplicate),
      ]);

      const report = await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, [
        edgeBetween(fx.ids.deploy, fx.ids.migration),
      ]);

      expect(report.deleted).toBe(2);
      const rows = await rowsFor(fx.brainId);
      expect(rows).toHaveLength(1);
      expect([rows[0].sourceMemoryId, rows[0].targetMemoryId]).toContain(fx.ids.migration);
    });

    it("empties a seed's edges when it has none left", async () => {
      await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, [
        edgeBetween(fx.ids.deploy, fx.ids.migration),
      ]);

      const report = await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, []);

      expect(report).toMatchObject({ inserted: 0, updated: 0, deleted: 1 });
      expect(await rowsFor(fx.brainId)).toHaveLength(0);
    });

    it("splits applied from suggested at the confidence threshold", async () => {
      const applied = edgeBetween(fx.ids.deploy, fx.ids.migration, {
        origin: "inferred",
        confidence: RELATE_POLICY.CONF_APPLY_MIN + 0.05,
      });
      const suggested = edgeBetween(fx.ids.deploy, fx.ids.nearDuplicate, {
        confidence: RELATE_POLICY.CONF_APPLY_MIN - 0.05,
      });

      await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, [applied, suggested]);

      const rows = await rowsFor(fx.brainId);
      const byStatus = new Map(rows.map((row) => [row.status, row]));
      expect(byStatus.get("applied")).toBeTruthy();
      expect(byStatus.get("suggested")).toBeTruthy();
      // The reader default: only applied edges are neighbours.
      const neighbours = await loadDerivedNeighbors(db, fx.brainId, fx.ids.deploy);
      expect(neighbours).toHaveLength(1);
      expect(neighbours[0].status).toBe("applied");
    });

    it("leaves another scorer version's rows alone", async () => {
      const [lo, hi] = [fx.ids.identity, fx.ids.preference].sort();
      await db.insert(memoryDerivedLinks).values({
        brainId: fx.brainId,
        sourceMemoryId: lo,
        targetMemoryId: hi,
        origin: "derived",
        relation: "semantic",
        weight: 0.5,
        confidence: 0.5,
        reason: "written by a future scorer",
        computedBy: "relate-v2",
      });

      await reconcileDerivedEdges(db, fx.brainId, lo, [edgeBetween(lo, fx.ids.deploy)]);

      const versions = (await rowsFor(fx.brainId)).map((row) => row.computedBy).sort();
      // Two algorithm versions have to be able to coexist, or a rollout would have to
      // delete the old graph before it could write the new one.
      expect(versions).toEqual([RELATE_VERSION, "relate-v2"]);
    });

  });

  describe("edge limits, counted against real rows", () => {
    it("keeps only the strongest K edges for one seed", async () => {
      const report = await reconcileDerivedEdges(
        db,
        fx.brainId,
        fx.ids.deploy,
        [
          edgeBetween(fx.ids.deploy, fx.ids.migration, { weight: 0.9 }),
          edgeBetween(fx.ids.deploy, fx.ids.nearDuplicate, { weight: 0.8 }),
          edgeBetween(fx.ids.deploy, fx.ids.unrelated, { weight: 0.3 }),
        ],
        { neighbours: 2 }
      );

      expect(report.pruned.droppedTopK).toBe(1);
      const kept = await rowsFor(fx.brainId);
      expect(kept).toHaveLength(2);
      const others = kept.map((row) =>
        row.sourceMemoryId === fx.ids.deploy ? row.targetMemoryId : row.sourceMemoryId
      );
      // The weakest is the one dropped, not an arbitrary one.
      expect(others).not.toContain(fx.ids.unrelated);
    });

    it("refuses an edge into an already saturated neighbour", async () => {
      // The degree count is deliberately over `status = 'applied'` rows only, so these
      // two have to clear CONF_APPLY_MIN to occupy any of the neighbour's budget.
      const applied = { confidence: RELATE_POLICY.CONF_APPLY_MIN + 0.1 };
      for (const seed of [fx.ids.identity, fx.ids.preference]) {
        await reconcileDerivedEdges(db, fx.brainId, seed, [
          edgeBetween(seed, fx.ids.migration, applied),
        ]);
      }

      const report = await reconcileDerivedEdges(
        db,
        fx.brainId,
        fx.ids.deploy,
        [edgeBetween(fx.ids.deploy, fx.ids.migration, applied)],
        { maxDegree: 2 }
      );

      // One popular memory must not become the hub the whole graph routes through.
      expect(report.pruned.droppedDegree).toBe(1);
      expect(report.inserted).toBe(0);
      expect(await edgesTouching(fx.brainId, fx.ids.deploy)).toHaveLength(0);
    });

    it("does not let a suggested edge occupy a neighbour's degree budget", async () => {
      // The other half of the same rule: a suggestion is not yet part of the graph, so
      // it must not crowd out an edge that would be. Without this the scorer could
      // silently starve real edges with rows nobody has approved.
      const suggested = { confidence: RELATE_POLICY.CONF_APPLY_MIN - 0.05 };
      for (const seed of [fx.ids.identity, fx.ids.preference]) {
        await reconcileDerivedEdges(db, fx.brainId, seed, [
          edgeBetween(seed, fx.ids.migration, suggested),
        ]);
      }

      const report = await reconcileDerivedEdges(
        db,
        fx.brainId,
        fx.ids.deploy,
        [edgeBetween(fx.ids.deploy, fx.ids.migration, { confidence: RELATE_POLICY.CONF_APPLY_MIN + 0.1 })],
        { maxDegree: 2 }
      );

      expect(report.pruned.droppedDegree).toBe(0);
      expect(report.inserted).toBe(1);
    });

    it("stops at the per-brain ceiling", async () => {
      await reconcileDerivedEdges(db, fx.brainId, fx.ids.identity, [
        edgeBetween(fx.ids.identity, fx.ids.preference),
      ]);

      const report = await reconcileDerivedEdges(
        db,
        fx.brainId,
        fx.ids.deploy,
        [edgeBetween(fx.ids.deploy, fx.ids.migration)],
        { maxEdges: 1 }
      );

      expect(report.pruned.droppedGlobalCap).toBe(1);
      expect(await rowsFor(fx.brainId)).toHaveLength(1);
    });
  });

  describe("the worker's job bodies", () => {
    it("relate_memory scores a real seed and writes only inside its brain", async () => {
      const report = await runRelateMemoryJob(db, fx.brainId, fx.ids.deploy);

      expect(report.candidates).toBeGreaterThan(0);
      expect(report.survived).toBeGreaterThan(0);

      const rows = await rowsFor(fx.brainId);
      expect(rows).toHaveLength(report.inserted);
      const brainMemoryIds = new Set(Object.values(fx.ids));
      for (const row of rows) {
        expect(row.brainId).toBe(fx.brainId);
        expect(brainMemoryIds.has(row.sourceMemoryId)).toBe(true);
        expect(brainMemoryIds.has(row.targetMemoryId)).toBe(true);
        expect(row.computedBy).toBe(RELATE_VERSION);
        expect(row.reason.length).toBeGreaterThan(0);
        expect(row.reason.length).toBeLessThanOrEqual(90);
      }
      // The deployment cluster is what it should have found.
      const partners = rows.map((row) =>
        row.sourceMemoryId === fx.ids.deploy ? row.targetMemoryId : row.sourceMemoryId
      );
      expect(partners).toContain(fx.ids.migration);
      expect(partners).toContain(fx.ids.nearDuplicate);
      // And the invoice memory shares no term, tag or project with it.
      expect(partners).not.toContain(fx.ids.unrelated);
    });

    it("relate_memory run twice leaves the same graph", async () => {
      const first = await runRelateMemoryJob(db, fx.brainId, fx.ids.deploy);
      const snapshot = async () =>
        (await rowsFor(fx.brainId))
          .map((row) =>
            [
              row.sourceMemoryId,
              row.targetMemoryId,
              row.origin,
              row.status,
              row.relation,
              row.weight.toFixed(6),
              row.confidence.toFixed(6),
              row.sourceHashA,
              row.sourceHashB,
            ].join("|")
          )
          .sort();

      const before = await snapshot();
      const second = await runRelateMemoryJob(db, fx.brainId, fx.ids.deploy);

      // Same decision, same rows: a duplicate job (or a retry after a crash) is a
      // no-op on the graph, which is what makes the queue's at-least-once delivery safe.
      expect(second.survived).toBe(first.survived);
      expect(await snapshot()).toEqual(before);
    });

    it("relate_memory re-scores after an edit and records the new hash", async () => {
      await runRelateMemoryJob(db, fx.brainId, fx.ids.migration);
      const [before] = await edgesTouching(fx.brainId, fx.ids.migration);
      expect(before).toBeTruthy();

      await updateMemory({
        brainId: fx.brainId,
        memoryId: fx.ids.migration,
        principal: principalOf(fx.userId),
        data: {
          content:
            "Pending drizzle migrations must reach neon before the hetzner deploy, or the app serves an unexpected schema.",
        },
        changeReason: "clarified",
      });

      const [hashRow] = await db
        .select({ contentHash: memories.contentHash })
        .from(memories)
        .where(eq(memories.id, fx.ids.migration));

      await runRelateMemoryJob(db, fx.brainId, fx.ids.migration);

      const after = await edgesTouching(fx.brainId, fx.ids.migration);
      expect(after.length).toBeGreaterThan(0);
      for (const row of after) {
        const own = row.sourceMemoryId === fx.ids.migration ? row.sourceHashA : row.sourceHashB;
        // The stored hash has to be the *new* one, or the staleness check would keep
        // reporting this edge as needing the recompute it just had.
        expect(own).toBe(hashRow.contentHash);
      }
      // Keep the fixture's hash map usable for the tests that follow.
      fx.hashes.set(fx.ids.migration, hashRow.contentHash ?? "");
    });

    it("relate_brain fans out one deduped job per live memory", async () => {
      const queued: Array<{ memoryId: string; jobId: string }> = [];
      const report = await runRelateBrainJob(db, fx.brainId, undefined, async (memoryId, jobId) => {
        queued.push({ memoryId, jobId });
      });

      const expected = Object.keys(CORPUS).length;
      expect(report).toEqual({ found: expected, enqueued: expected });
      expect(new Set(queued.map((q) => q.jobId)).size).toBe(expected);
      for (const { memoryId, jobId } of queued) expect(jobId).toBe(`relate:${memoryId}`);
    });

    it("relate_brain honours its batch limit and skips soft-deleted memories", async () => {
      expect(await runRelateBrainJob(db, fx.brainId, 3, null)).toEqual({ found: 3, enqueued: 0 });

      const gone = await rememberMemory({
        brainId: fx.brainId,
        principal: principalOf(fx.userId),
        data: { title: "Forgotten note", content: "Soft-deleted before the sweep ran.", type: "fact" },
      });
      await db.update(memories).set({ deletedAt: new Date() }).where(eq(memories.id, gone.memory.id));

      const report = await runRelateBrainJob(db, fx.brainId, undefined, null);
      expect(report.found).toBe(Object.keys(CORPUS).length);

      await db.delete(memories).where(eq(memories.id, gone.memory.id));
    });

  });

  describe("the read paths, over a real derived graph", () => {
    /** Score every memory in the brain, the way a relate_brain sweep would. */
    const scoreWholeBrain = async () => {
      for (const id of Object.values(fx.ids)) await runRelateMemoryJob(db, fx.brainId, id);
    };

    it("brain_related surfaces derived edges with their provenance", async () => {
      await scoreWholeBrain();

      const related = await findRelatedMemories(db, fx.brainId, fx.ids.deploy, 20, 2, false);
      const derivedOf = (list: typeof related) =>
        list.filter((row) => row.origin === "derived" || row.origin === "inferred");

      expect(derivedOf(related).length).toBeGreaterThan(0);
      for (const row of derivedOf(related)) {
        expect(row.id).not.toBe(fx.ids.deploy);
        expect(row.reason).toBeTruthy();
        expect(row.score).toBeGreaterThan(0);
      }
      expect(related.map((row) => row.id)).toContain(fx.ids.migration);

      const rows = await edgesTouching(fx.brainId, fx.ids.deploy);
      const partnerOf = (row: (typeof rows)[number]) =>
        row.sourceMemoryId === fx.ids.deploy ? row.targetMemoryId : row.sourceMemoryId;
      const suggestedOnly = new Set(
        rows.filter((row) => row.status === "suggested").map(partnerOf)
      );
      for (const row of rows.filter((r) => r.status === "applied")) {
        expect(related.map((r) => r.id)).toContain(partnerOf(row));
      }

      const appliedOnly = await findRelatedMemories(db, fx.brainId, fx.ids.deploy, 20, 2, true);
      // `appliedOnly` is about the derived tier only: a suggestion must not arrive
      // dressed as an applied relationship.
      for (const row of derivedOf(appliedOnly)) {
        expect(suggestedOnly.has(row.id)).toBe(false);
      }
    });

    it("brain_context labels derived edges and never dangles them", async () => {
      await scoreWholeBrain();

      const context = await buildContext(db, {
        brainId: fx.brainId,
        task: "how do I deploy to the hetzner box and what about migrations",
        tokenBudget: 8_000,
        maxMemories: 20,
        includeGraph: true,
        includeProvenance: true,
      });

      expect(context.tokensUsed).toBeLessThanOrEqual(context.usableBudget);
      const selected = new Set(context.memories.map((m) => m.id));
      const derivedEdges = (context.graph?.edges ?? []).filter((edge) => !edge.explicit);
      expect(derivedEdges.length).toBeGreaterThan(0);
      for (const edge of derivedEdges) {
        // An agent reading this package must never mistake "the scorer found these
        // similar" for "somebody said these are related".
        expect(edge.linkType.startsWith("derived_")).toBe(true);
        expect(edge.weight).toBeGreaterThan(0);
        expect(edge.confidence).toBeGreaterThan(0);
        expect(selected.has(edge.sourceId)).toBe(true);
        expect(selected.has(edge.targetId)).toBe(true);
      }
    });

    it("brain_explain shows the derived edges and keeps evidence bounded", async () => {
      await scoreWholeBrain();

      const provenance = await explainMemoryProvenance(db, fx.brainId, fx.ids.deploy);

      expect(provenance).not.toBeNull();
      expect(provenance!.derivedRelationships.length).toBeGreaterThan(0);
      for (const rel of provenance!.derivedRelationships) {
        expect(["derived", "inferred"]).toContain(rel.origin);
        expect(["applied", "suggested"]).toContain(rel.status);
        expect(rel.computedBy).toBe(RELATE_VERSION);
        expect(rel.title).toBeTruthy();
        expect(rel.reason).toBeTruthy();
        expect(rel.weight).toBeGreaterThan(0);
        expect(rel.confidence).toBeGreaterThan(0);

        const serialized = JSON.stringify(rel.evidence ?? {});
        // Evidence is a summary of *why*, not a copy of the memories. Storing content
        // here would duplicate the data and leak it to every reader of the edge.
        expect(serialized.length).toBeLessThan(2_000);
        for (const entry of Object.values(CORPUS)) {
          expect(serialized).not.toContain(entry.content);
        }
      }
    });

  });

  describe("brain isolation — the security invariant", () => {
    it("never scores across brains, even for identical content", async () => {
      // The other brain holds a byte-identical copy of the deployment runbook. If the
      // candidate probes were not brain-scoped, this is the pair they would find first.
      const mine = await runRelateMemoryJob(db, fx.brainId, fx.ids.deploy);
      const theirs = await runRelateMemoryJob(db, fx.otherBrainId, fx.otherDeployId);

      expect(mine.survived).toBeGreaterThan(0);
      expect(theirs).toMatchObject({ candidates: 0, scored: 0, survived: 0 });
      expect(await rowsFor(fx.otherBrainId)).toHaveLength(0);

      for (const row of await rowsFor(fx.brainId)) {
        expect(row.sourceMemoryId).not.toBe(fx.otherDeployId);
        expect(row.targetMemoryId).not.toBe(fx.otherDeployId);
      }
    });

    it("hides one brain's derived edges from the other's readers", async () => {
      for (const id of Object.values(fx.ids)) await runRelateMemoryJob(db, fx.brainId, id);
      expect((await rowsFor(fx.brainId)).length).toBeGreaterThan(0);

      // Same memory id, wrong brain: every reader has to come back empty.
      expect(await loadDerivedNeighbors(db, fx.otherBrainId, fx.ids.deploy)).toEqual([]);
      expect(await findRelatedMemories(db, fx.otherBrainId, fx.ids.deploy, 20, 2, false)).toEqual([]);
      expect(await explainMemoryProvenance(db, fx.otherBrainId, fx.ids.deploy)).toBeNull();

      const related = await findRelatedMemories(db, fx.otherBrainId, fx.otherDeployId, 20, 2, false);
      const mineIds = new Set(Object.values(fx.ids));
      for (const row of related) expect(mineIds.has(row.id)).toBe(false);

      const context = await buildContext(db, {
        brainId: fx.otherBrainId,
        task: "how do I deploy to the hetzner box",
        tokenBudget: 4_000,
        includeGraph: true,
      });
      for (const memory of context.memories) expect(mineIds.has(memory.id)).toBe(false);
    });

    it("deletes only the addressed brain's edges", async () => {
      await reconcileDerivedEdges(db, fx.brainId, fx.ids.deploy, [
        edgeBetween(fx.ids.deploy, fx.ids.migration),
      ]);

      // Wrong brain, right memory id: nothing to delete, and nothing deleted.
      expect(await deleteDerivedEdgesFor(db, fx.otherBrainId, fx.ids.deploy)).toBe(0);
      expect(await rowsFor(fx.brainId)).toHaveLength(1);

      expect(await deleteDerivedEdgesFor(db, fx.brainId, fx.ids.deploy)).toBe(1);
      expect(await rowsFor(fx.brainId)).toHaveLength(0);
    });

    it("removes every derived edge when the brain is deleted", async () => {
      const [user] = await db
        .insert(users)
        .values({
          username: `brain-phase2-cascade-${crypto.randomUUID()}`,
          passwordHash: "integration-test-not-a-real-hash",
        })
        .returning();
      const [brain] = await db
        .insert(brains)
        .values({ name: "Cascade Brain", ownerUserId: user.id })
        .returning();

      try {
        const a = await rememberMemory({
          brainId: brain.id,
          principal: principalOf(user.id),
          data: { title: "Alpha", content: "Shared hetzner deployment runbook text.", type: "fact" },
        });
        const b = await rememberMemory({
          brainId: brain.id,
          principal: principalOf(user.id),
          data: { title: "Beta", content: "Another hetzner deployment runbook text.", type: "fact" },
        });
        await reconcileDerivedEdges(db, brain.id, a.memory.id, [
          {
            memoryA: a.memory.id,
            memoryB: b.memory.id,
            origin: "derived",
            relation: "semantic",
            weight: 0.5,
            confidence: 0.5,
            evidence: { signalFamilyCount: 1 },
            reason: "cascade fixture",
            hashA: "",
            hashB: "",
          },
        ]);
        expect(await rowsFor(brain.id)).toHaveLength(1);

        await db.delete(brains).where(eq(brains.id, brain.id));
        expect(await rowsFor(brain.id)).toHaveLength(0);
      } finally {
        await db.delete(brains).where(eq(brains.id, brain.id));
        await db.delete(users).where(eq(users.id, user.id));
      }
    });
  });

});
