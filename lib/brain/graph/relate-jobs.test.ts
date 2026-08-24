import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import {
  RELATE_SWEEP_LIMIT,
  RELATE_SWEEP_MAX,
  relateJobId,
  runRelateBrainJob,
  runRelateMemoryJob,
} from "./relate-jobs";

/**
 * The two PHASE 2 job bodies, audited for the things a queue does to a job: run it
 * twice, run it after a crash, run it while another copy is already queued.
 *
 * These are the DB-free half of that audit — what the job *decides*. What it writes is
 * verified against real Postgres in `tests/brain-phase2-db.test.ts`.
 */

vi.mock("./relate-candidates", () => ({
  generateAndLoadCandidates: vi.fn(),
}));
vi.mock("./derived-link-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./derived-link-service")>();
  return { ...actual, reconcileDerivedEdges: vi.fn() };
});

const { generateAndLoadCandidates } = await import("./relate-candidates");
const { reconcileDerivedEdges } = await import("./derived-link-service");

const BRAIN = "brain-1";
const OTHER_BRAIN = "brain-2";
const SEED = "mem-seed";

const db = {} as PostgresJsDatabase<typeof schema>;

const memory = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: "Deploy notes",
  content: "Always run migrations before deploying to hetzner production",
  tags: [] as string[],
  projectId: null,
  entityIds: [] as string[],
  ...overrides,
});

const emptyReport = {
  inserted: 0,
  updated: 0,
  deleted: 0,
  pruned: { droppedTopK: 0, droppedDegree: 0, droppedGlobalCap: 0 },
};

beforeEach(() => {
  vi.mocked(generateAndLoadCandidates).mockReset();
  vi.mocked(reconcileDerivedEdges).mockReset();
  vi.mocked(reconcileDerivedEdges).mockResolvedValue({ ...emptyReport });
});

describe("runRelateMemoryJob", () => {
  it("reconciles with an empty set when the seed has no candidates left", async () => {
    vi.mocked(generateAndLoadCandidates).mockResolvedValue({
      seed: memory(SEED),
      candidates: [],
      hashes: new Map([[SEED, "h"]]),
    });
    vi.mocked(reconcileDerivedEdges).mockResolvedValue({ ...emptyReport, deleted: 3 });

    const report = await runRelateMemoryJob(db, BRAIN, SEED);

    // A memory edited into irrelevance has to *lose* its edges. Skipping the reconcile
    // here would leave the relationships it had when it was still relevant.
    expect(reconcileDerivedEdges).toHaveBeenCalledWith(db, BRAIN, SEED, []);
    expect(report).toMatchObject({ candidates: 0, scored: 0, survived: 0, deleted: 3 });
  });

  it("scores the candidates it was given and writes the survivors", async () => {
    const near = memory("mem-near", {
      title: "Migration notes",
      content: "Always run migrations before deploying to hetzner production",
    });
    vi.mocked(generateAndLoadCandidates).mockResolvedValue({
      seed: memory(SEED),
      candidates: [near],
      hashes: new Map([
        [SEED, "hash-seed"],
        ["mem-near", "hash-near"],
      ]),
    });

    const report = await runRelateMemoryJob(db, BRAIN, SEED);

    expect(report.candidates).toBe(1);
    expect(report.scored).toBeGreaterThan(0);
    const [, brainId, seedId, edges] = vi.mocked(reconcileDerivedEdges).mock.calls[0];
    expect(brainId).toBe(BRAIN);
    expect(seedId).toBe(SEED);
    expect(edges).toHaveLength(report.survived);
    // Provenance travels with the edge, so a later staleness check has something to
    // compare against.
    for (const edge of edges) {
      expect(edge.hashA).toBeTruthy();
      expect(edge.hashB).toBeTruthy();
      expect(["derived", "inferred"]).toContain(edge.origin);
    }
  });

  it("is idempotent: the same input produces the same write twice", async () => {
    const candidates = [memory("mem-a"), memory("mem-b", { title: "Hetzner migrations" })];
    vi.mocked(generateAndLoadCandidates).mockResolvedValue({
      seed: memory(SEED),
      candidates,
      hashes: new Map(candidates.concat(memory(SEED)).map((m) => [m.id, `h-${m.id}`])),
    });

    const first = await runRelateMemoryJob(db, BRAIN, SEED);
    const second = await runRelateMemoryJob(db, BRAIN, SEED);

    expect(second).toEqual(first);
    const calls = vi.mocked(reconcileDerivedEdges).mock.calls;
    expect(JSON.stringify(calls[1][3])).toBe(JSON.stringify(calls[0][3]));
  });

  it("lets a failure escape, so the queue can retry it", async () => {
    vi.mocked(generateAndLoadCandidates).mockRejectedValue(new Error("connection terminated"));

    await expect(runRelateMemoryJob(db, BRAIN, SEED)).rejects.toThrow("connection terminated");
    // Nothing written on the way out: a half-finished pass must not leave the graph
    // describing a state that never existed.
    expect(reconcileDerivedEdges).not.toHaveBeenCalled();
  });

  it("does not swallow a write failure either", async () => {
    vi.mocked(generateAndLoadCandidates).mockResolvedValue({
      seed: memory(SEED),
      candidates: [memory("mem-a")],
      hashes: new Map(),
    });
    vi.mocked(reconcileDerivedEdges).mockRejectedValue(new Error("deadlock detected"));

    await expect(runRelateMemoryJob(db, BRAIN, SEED)).rejects.toThrow("deadlock detected");
  });

  it("stores an empty hash rather than guessing when one is missing", async () => {
    vi.mocked(generateAndLoadCandidates).mockResolvedValue({
      seed: memory(SEED),
      candidates: [memory("mem-near", { title: "Hetzner migrations" })],
      hashes: new Map([[SEED, "hash-seed"]]),
    });

    await runRelateMemoryJob(db, BRAIN, SEED);

    const edges = vi.mocked(reconcileDerivedEdges).mock.calls[0][3];
    // The staleness check reads a missing hash as "recompute me", which is the safe
    // reading. An invented hash would read as fresh forever.
    for (const edge of edges) expect(edge.hashB).toBe("");
  });
});

/** Minimal recording select chain: one `.select().from().where().orderBy().limit()`. */
function sweepDb(rows: Array<{ id: string }>) {
  const calls: Array<{ where: unknown; limit: number }> = [];
  const chain = {
    select: () => chain,
    from: () => chain,
    where(where: unknown) {
      calls.push({ where, limit: 0 });
      return chain;
    },
    orderBy: () => chain,
    limit(limit: number) {
      calls[calls.length - 1].limit = limit;
      return Promise.resolve(rows);
    },
  };
  return { db: chain as unknown as PostgresJsDatabase<typeof schema>, calls };
}

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
    if ("name" in record) parts.push(String(record.name));
    for (const [key, item] of Object.entries(record)) {
      if (key === "queryChunks" || key === "value" || key === "name") continue;
      walk(item);
    }
  };
  walk(node);
  return parts.join(" ");
}

describe("runRelateBrainJob", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `mem-${i}` }));

  it("enqueues one job per memory, keyed for dedupe", async () => {
    const { db: fake } = sweepDb(rows(3));
    const queued: Array<{ memoryId: string; jobId: string }> = [];

    const report = await runRelateBrainJob(fake, BRAIN, undefined, async (memoryId, jobId) => {
      queued.push({ memoryId, jobId });
    });

    expect(report).toEqual({ found: 3, enqueued: 3 });
    expect(queued).toEqual([
      { memoryId: "mem-0", jobId: "relate:mem-0" },
      { memoryId: "mem-1", jobId: "relate:mem-1" },
      { memoryId: "mem-2", jobId: "relate:mem-2" },
    ]);
    // One key per memory, so a memory already queued by its own write path is not
    // scored twice by a sweep that happens to overlap it.
    expect(new Set(queued.map((q) => q.jobId)).size).toBe(queued.length);
  });

  it("uses the same dedupe key the write path uses", () => {
    expect(relateJobId("mem-7")).toBe("relate:mem-7");
  });

  it("defaults to the sweep limit and never exceeds the hard ceiling", async () => {
    const a = sweepDb(rows(1));
    await runRelateBrainJob(a.db, BRAIN, undefined, null);
    expect(a.calls[0].limit).toBe(RELATE_SWEEP_LIMIT);

    const b = sweepDb(rows(1));
    await runRelateBrainJob(b.db, BRAIN, 50, null);
    expect(b.calls[0].limit).toBe(50);

    const c = sweepDb(rows(1));
    await runRelateBrainJob(c.db, BRAIN, 10_000, null);
    // A sweep is fan-out, not a licence to rewrite a whole brain in one job.
    expect(c.calls[0].limit).toBe(RELATE_SWEEP_MAX);
  });

  it("scopes the sweep to one brain and skips soft-deleted memories", async () => {
    const { db: fake, calls } = sweepDb(rows(2));

    await runRelateBrainJob(fake, BRAIN, undefined, null);

    const predicate = describeSql(calls[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).not.toContain(OTHER_BRAIN);
    expect(predicate).toContain("deleted_at");
  });

  it("reports what it found and queues nothing when there is no queue", async () => {
    const { db: fake } = sweepDb(rows(4));

    // A deployment without Redis should get a sweep that says "4 memories, no queue",
    // not an exception on a maintenance path.
    expect(await runRelateBrainJob(fake, BRAIN, undefined, null)).toEqual({
      found: 4,
      enqueued: 0,
    });
  });

  it("queues nothing for an empty brain", async () => {
    const { db: fake } = sweepDb([]);
    const enqueue = vi.fn();

    expect(await runRelateBrainJob(fake, BRAIN, undefined, enqueue)).toEqual({
      found: 0,
      enqueued: 0,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops the sweep when the queue rejects, rather than reporting a lie", async () => {
    const { db: fake } = sweepDb(rows(5));
    let seen = 0;

    await expect(
      runRelateBrainJob(fake, BRAIN, undefined, async () => {
        seen += 1;
        if (seen === 3) throw new Error("queue unreachable");
      })
    ).rejects.toThrow("queue unreachable");
    // The job fails and BullMQ retries it; the dedupe key means the two already-queued
    // memories are not duplicated on the second attempt.
    expect(seen).toBe(3);
  });
});
