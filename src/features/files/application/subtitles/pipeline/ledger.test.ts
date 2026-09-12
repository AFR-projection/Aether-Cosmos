import { describe, expect, it } from "vitest";
import { ensureSubtitlePipeline } from "./ensure";
import { mayMutateWithLease, planNextSubtitleWindow } from "./ledger";
import { MemorySubtitlePipelineStore } from "./memory-store";
import { pipelineTestSource } from "./ensure.test";

describe("durable work ledger", () => {
  it("plans sources over 24 hours in bounded pages of 24 ten-minute windows", async () => {
    const durationMs = 49 * 60 * 60 * 1_000 + 123;
    const store = new MemorySubtitlePipelineStore([pipelineTestSource({ durationMs })]);
    const { run } = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    let pages = 0;
    while ((await store.getRun(run.id))!.plannerCursorMs < durationMs) {
      const result = await planNextSubtitleWindow(run.id, store);
      expect(result.created).toBeLessThanOrEqual(24);
      pages += 1;
    }
    const planned = [...store.work.values()].filter((item) => item.kind === "prepare");
    expect(pages).toBeGreaterThan(1);
    expect(planned.at(-1)?.cursorEndMs).toBe(durationMs);
    expect(new Set(planned.map((item) => item.idempotencyKey)).size).toBe(planned.length);
  });

  it("prevents duplicate claims and fences an expired owner", async () => {
    const store = new MemorySubtitlePipelineStore([pipelineTestSource({ durationMs: 600_000 })]);
    const { run } = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    await planNextSubtitleWindow(run.id, store, new Date("2026-01-01T00:00:00Z"));
    const at = new Date("2026-01-01T00:00:01Z");
    const [first] = await store.claimDueWork({ workerId: "w1", now: at, leaseMs: 1_000, limit: 1 });
    const duplicate = await store.claimDueWork({ workerId: "w2", now: at, leaseMs: 1_000, limit: 1 });
    expect(duplicate.every((item) => item.id !== first.id)).toBe(true);
    const [replacement] = await store.claimDueWork({ workerId: "w2", now: new Date(at.getTime() + 1_001), leaseMs: 1_000, limit: 1 });
    expect(replacement.id).toBe(first.id);
    expect(replacement.fencingToken).toBe(first.fencingToken + 1);
    expect(await store.complete(first, null, new Date(at.getTime() + 1_002))).toBe(false);
    expect(mayMutateWithLease(replacement, replacement, new Date(at.getTime() + 1_002))).toBe(true);
  });

  it("round-robins due work by user before a user's second item", async () => {
    const store = new MemorySubtitlePipelineStore([pipelineTestSource()]);
    const a = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    store.sources.set("f2", pipelineTestSource({ fileId: "f2", userId: "u2", r2Key: "u2/f2.mp4" }));
    const b = await ensureSubtitlePipeline({ fileId: "f2" }, store);
    const now = new Date("2026-01-01T00:00:00Z");
    await store.createWork([0, 1].map((ordinal) => ({ runId: a.run.id, targetId: null, userId: "u1", kind: "prepare" as const,
      idempotencyKey: `a${ordinal}`, ordinal, cursorStartMs: ordinal, cursorEndMs: ordinal + 1 })), now);
    await store.createWork([{ runId: b.run.id, targetId: null, userId: "u2", kind: "prepare", idempotencyKey: "b0",
      ordinal: 0, cursorStartMs: 0, cursorEndMs: 1 }], now);
    const claimed = await store.claimDueWork({ workerId: "w", now, leaseMs: 1000, limit: 3 });
    expect(new Set(claimed.slice(0, 2).map((item) => item.userId))).toEqual(new Set(["u1", "u2"]));
  });

  it("invalidates all pending work when exact source identity changes", async () => {
    const store = new MemorySubtitlePipelineStore([pipelineTestSource()]);
    const { run } = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    store.sources.set("f1", pipelineTestSource({ version: 8, r2Key: "new.mp4" }));
    await planNextSubtitleWindow(run.id, store);
    expect((await store.getRun(run.id))?.status).toBe("stale");
    expect([...store.work.values()].every((item) => item.status === "cancelled")).toBe(true);
  });
});
