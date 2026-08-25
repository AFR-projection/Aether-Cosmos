import { describe, it, expect, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import type { EmbeddingProvider, EmbeddingVector } from "./provider";
import {
  EMBED_SWEEP_LIMIT,
  EMBED_SWEEP_MAX,
  embedJobId,
  runEmbedBrainJob,
  runEmbedMemoryJob,
} from "./embed-jobs";

/**
 * What the embed jobs DECIDE, audited DB-free: a duplicate job is cheap, a model change
 * or a content edit forces a re-embed, an unconfigured provider is a no-op, and the one
 * write the job makes touches ONLY the three embedding columns and is always scoped to a
 * single brain. What it actually persists is verified against real Postgres elsewhere;
 * here the SQL text is inspected so a stray column or a missing tenant predicate is
 * caught without a database.
 */

const BRAIN = "brain-1";
const OTHER_BRAIN = "brain-2";
const MEM = "mem-1";

type MemRow = {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  updatedAt: Date;
  embeddingModel: string | null;
  embeddingUpdatedAt: Date | null;
};

function memoryRow(overrides: Partial<MemRow> = {}): MemRow {
  return {
    id: MEM,
    title: "Deploy notes",
    summary: null,
    content: "Always run migrations before deploying.",
    updatedAt: new Date("2026-01-10T00:00:00Z"),
    embeddingModel: null,
    embeddingUpdatedAt: null,
    ...overrides,
  };
}

/** Records the read predicate and any executed SQL so writes can be inspected. */
function memoryDb(row: MemRow | null) {
  const reads: unknown[] = [];
  const executed: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (where: unknown) => ({
          limit: async () => {
            reads.push(where);
            return row ? [row] : [];
          },
        }),
      }),
    }),
    execute: async (query: unknown) => {
      executed.push(query);
      return [] as unknown[];
    },
  };
  return { db: db as unknown as PostgresJsDatabase<typeof schema>, reads, executed };
}

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    model: "test-encoder",
    dimensions: 3,
    available: async () => true,
    embed: vi.fn(async (texts: string[]): Promise<EmbeddingVector[]> =>
      texts.map(() => Float32Array.from([0.1, 0.2, 0.3]))
    ),
    ...overrides,
  };
}

/** Flatten a drizzle SQL node to a searchable string of its chunks and params. */
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

/**
 * Only the LITERAL SQL text of a `sql` template — the string chunks the job hard-codes,
 * not the columns or params it interpolates. A `${table}` reference expands to every
 * column name via {@link describeSql}, which would mask a stray column write; the literal
 * chunks are what actually name the columns the statement sets.
 */
function sqlText(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks ?? [];
  const parts: string[] = [];
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown }).value;
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      parts.push((value as string[]).join(""));
    }
  }
  return parts.join(" ");
}

describe("runEmbedMemoryJob", () => {
  it("is a no-op when no provider is available", async () => {
    const { db, reads, executed } = memoryDb(memoryRow());
    const report = await runEmbedMemoryJob(db, BRAIN, MEM, fakeProvider({ available: async () => false }));

    expect(report).toEqual({ embedded: false, skipped: true, reason: "unavailable" });
    // It must not even read the memory, let alone write: a disabled deployment pays nothing.
    expect(reads).toHaveLength(0);
    expect(executed).toHaveLength(0);
  });

  it("reports not_found without writing when the memory is absent in this brain", async () => {
    const { db, executed } = memoryDb(null);
    const report = await runEmbedMemoryJob(db, BRAIN, MEM, fakeProvider());
    expect(report).toEqual({ embedded: false, skipped: true, reason: "not_found" });
    expect(executed).toHaveLength(0);
  });

  it("skips a memory already fresh for the active model", async () => {
    const provider = fakeProvider();
    const { db, executed } = memoryDb(
      memoryRow({
        embeddingModel: "test-encoder",
        // Embedded AFTER the last content edit → nothing to do.
        updatedAt: new Date("2026-01-10T00:00:00Z"),
        embeddingUpdatedAt: new Date("2026-01-11T00:00:00Z"),
      })
    );

    const report = await runEmbedMemoryJob(db, BRAIN, MEM, provider);
    expect(report).toEqual({ embedded: false, skipped: true, reason: "fresh" });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });

  it("re-embeds when the configured model changed", async () => {
    const provider = fakeProvider();
    const { db, executed } = memoryDb(
      memoryRow({
        embeddingModel: "an-older-model",
        embeddingUpdatedAt: new Date("2026-02-01T00:00:00Z"),
      })
    );

    const report = await runEmbedMemoryJob(db, BRAIN, MEM, provider);
    expect(report).toEqual({ embedded: true, skipped: false });
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(1);
  });

  it("re-embeds when the content was edited after the last embed", async () => {
    const provider = fakeProvider();
    const { db, executed } = memoryDb(
      memoryRow({
        embeddingModel: "test-encoder",
        updatedAt: new Date("2026-02-10T00:00:00Z"),
        // Stale: embedded before the most recent edit.
        embeddingUpdatedAt: new Date("2026-02-01T00:00:00Z"),
      })
    );

    const report = await runEmbedMemoryJob(db, BRAIN, MEM, provider);
    expect(report.embedded).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it("skips a memory with no embeddable text instead of storing an empty vector", async () => {
    const provider = fakeProvider();
    const { db, executed } = memoryDb(memoryRow({ title: "  ", summary: "  ", content: "  " }));
    const report = await runEmbedMemoryJob(db, BRAIN, MEM, provider);
    expect(report).toEqual({ embedded: false, skipped: true, reason: "empty" });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
  });

  it("writes ONLY the embedding columns, scoped to the one brain", async () => {
    const provider = fakeProvider();
    const { db, executed } = memoryDb(memoryRow({ embeddingModel: "older" }));
    await runEmbedMemoryJob(db, BRAIN, MEM, provider);

    // The literal statement text sets exactly the three embedding columns…
    const literals = sqlText(executed[0]);
    expect(literals).toMatch(/update/i);
    expect(literals).toContain("embedding =");
    expect(literals).toContain("embedding_model =");
    expect(literals).toContain("embedding_updated_at = now()");
    // …and hard-codes nothing that belongs to enrichment/relate or the memory's content.
    expect(literals).not.toMatch(/\bcontent\b|\btitle\b|\bimportance\b|\bsearch_vector\b/);
    expect(literals).not.toMatch(/\binsert\b|\bdelete\b/i);

    // The tenant predicate is present and no other brain leaks in.
    const full = describeSql(executed[0]);
    expect(full).toContain("brain_id");
    expect(full).toContain(BRAIN);
    expect(full).toContain(MEM);
    expect(full).not.toContain(OTHER_BRAIN);
  });

  it("reads the memory scoped to the brain, never cross-tenant", async () => {
    const { db, reads } = memoryDb(memoryRow({ embeddingModel: "older" }));
    await runEmbedMemoryJob(db, BRAIN, MEM, fakeProvider());
    const predicate = describeSql(reads[0]);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain("deleted_at");
    expect(predicate).not.toContain(OTHER_BRAIN);
  });

  it("stores the vector as a pgvector literal cast", async () => {
    const provider = fakeProvider({
      embed: vi.fn(async () => [Float32Array.from([0.5, -0.25, 0.75])]),
    });
    const { db, executed } = memoryDb(memoryRow({ embeddingModel: "older" }));
    await runEmbedMemoryJob(db, BRAIN, MEM, provider);
    expect(describeSql(executed[0])).toContain("[0.5,-0.25,0.75]");
    expect(sqlText(executed[0])).toContain("::vector");
  });
});

/** Minimal sweep chain: select().from().where().orderBy().limit(). */
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

describe("runEmbedBrainJob", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `mem-${i}` }));

  it("fans out one embed job per memory, keyed for dedupe", async () => {
    const { db } = sweepDb(rows(3));
    const queued: Array<{ memoryId: string; jobId: string }> = [];

    const report = await runEmbedBrainJob(db, BRAIN, undefined, async (memoryId, jobId) => {
      queued.push({ memoryId, jobId });
    });

    expect(report).toEqual({ found: 3, enqueued: 3 });
    expect(queued).toEqual([
      { memoryId: "mem-0", jobId: "embed:mem-0" },
      { memoryId: "mem-1", jobId: "embed:mem-1" },
      { memoryId: "mem-2", jobId: "embed:mem-2" },
    ]);
    expect(new Set(queued.map((q) => q.jobId)).size).toBe(queued.length);
  });

  it("uses a stable per-memory dedupe key", () => {
    expect(embedJobId("mem-7")).toBe("embed:mem-7");
  });

  it("defaults to the sweep limit and never exceeds the hard ceiling", async () => {
    const a = sweepDb(rows(1));
    await runEmbedBrainJob(a.db, BRAIN, undefined, null);
    expect(a.calls[0].limit).toBe(EMBED_SWEEP_LIMIT);

    const b = sweepDb(rows(1));
    await runEmbedBrainJob(b.db, BRAIN, 25, null);
    expect(b.calls[0].limit).toBe(25);

    const c = sweepDb(rows(1));
    await runEmbedBrainJob(c.db, BRAIN, 999_999, null);
    expect(c.calls[0].limit).toBe(EMBED_SWEEP_MAX);
  });

  it("scopes the sweep to one brain and skips soft-deleted memories", async () => {
    const { db, calls } = sweepDb(rows(2));
    await runEmbedBrainJob(db, BRAIN, undefined, null);
    const predicate = describeSql(calls[0].where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).not.toContain(OTHER_BRAIN);
    expect(predicate).toContain("deleted_at");
  });

  it("reports what it found and queues nothing when there is no queue", async () => {
    const { db } = sweepDb(rows(4));
    expect(await runEmbedBrainJob(db, BRAIN, undefined, null)).toEqual({ found: 4, enqueued: 0 });
  });

  it("queues nothing for an empty brain", async () => {
    const { db } = sweepDb([]);
    const enqueue = vi.fn();
    expect(await runEmbedBrainJob(db, BRAIN, undefined, enqueue)).toEqual({ found: 0, enqueued: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops the sweep when the queue rejects rather than over-reporting", async () => {
    const { db } = sweepDb(rows(5));
    let seen = 0;
    await expect(
      runEmbedBrainJob(db, BRAIN, undefined, async () => {
        seen += 1;
        if (seen === 2) throw new Error("queue unreachable");
      })
    ).rejects.toThrow("queue unreachable");
    expect(seen).toBe(2);
  });
});
