/**
 * Per-account restore sweeper: the two-pass order is load-bearing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sweepAbandonedRestores,
  type RestoreSweepStore,
  type SweepableBatch,
} from "@backup/account/application/sweep-restores";
import { RESTORE_ABANDONED_REASON } from "@backup/account/infrastructure/ledger";

describe("sweepAbandonedRestores", () => {
  let store: RestoreSweepStore;
  let findAbandonedCalls: Date[];
  let abortBatchCalls: Array<{ batch: SweepableBatch; reason: string; now: Date }>;
  let findCollectableCalls: number;
  let collectStagedRowsCalls: string[];

  beforeEach(() => {
    findAbandonedCalls = [];
    abortBatchCalls = [];
    findCollectableCalls = 0;
    collectStagedRowsCalls = [];

    store = {
      findAbandoned: vi.fn(async (cutoff: Date) => {
        findAbandonedCalls.push(cutoff);
        return [];
      }),
      abortBatch: vi.fn(async (batch: SweepableBatch, reason: string, now: Date) => {
        abortBatchCalls.push({ batch, reason, now });
        return true;
      }),
      findCollectable: vi.fn(async () => {
        findCollectableCalls += 1;
        return [];
      }),
      collectStagedRows: vi.fn(async (restoreBatchId: string) => {
        collectStagedRowsCalls.push(restoreBatchId);
        return { files: 0, folders: 0 };
      }),
    };
  });

  it("runs both passes in order: abort, then collect", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const report = await sweepAbandonedRestores(store, now);

    expect(findAbandonedCalls).toHaveLength(1);
    expect(findCollectableCalls).toBe(1);
    expect(report).toEqual({
      abandoned: 0,
      collected: 0,
      stagedFiles: 0,
      stagedFolders: 0,
    });
  });

  it("aborts staging batches older than the cutoff", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const batch1: SweepableBatch = {
      id: "batch-1",
      userId: "user-1",
      domain: "files",
    };
    const batch2: SweepableBatch = {
      id: "batch-2",
      userId: "user-2",
      domain: "brain",
    };

    store.findAbandoned = vi.fn(async () => [batch1, batch2]);

    const report = await sweepAbandonedRestores(store, now);

    expect(abortBatchCalls).toHaveLength(2);
    expect(abortBatchCalls[0]).toEqual({
      batch: batch1,
      reason: RESTORE_ABANDONED_REASON,
      now,
    });
    expect(abortBatchCalls[1]).toEqual({
      batch: batch2,
      reason: RESTORE_ABANDONED_REASON,
      now,
    });
    expect(report.abandoned).toBe(2);
  });

  it("does not count a batch whose abort returned false", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const batch: SweepableBatch = {
      id: "batch-already-committed",
      userId: "user-1",
      domain: "files",
    };

    store.findAbandoned = vi.fn(async () => [batch]);
    store.abortBatch = vi.fn(async () => false); // committed in the gap

    const report = await sweepAbandonedRestores(store, now);

    expect(report.abandoned).toBe(0);
  });

  it("swallows an abort error and continues", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const batch1: SweepableBatch = { id: "batch-1", userId: "user-1", domain: "files" };
    const batch2: SweepableBatch = { id: "batch-2", userId: "user-2", domain: "brain" };

    store.findAbandoned = vi.fn(async () => [batch1, batch2]);
    let callCount = 0;
    store.abortBatch = vi.fn(async (batch: SweepableBatch, reason: string, now: Date) => {
      abortBatchCalls.push({ batch, reason, now });
      callCount += 1;
      if (callCount === 1) throw new Error("DB unreachable");
      return true;
    });

    const report = await sweepAbandonedRestores(store, now);

    expect(report.abandoned).toBe(1); // only batch2 succeeded
    expect(abortBatchCalls).toHaveLength(2);
  });

  it("collects staged rows under non-staging batches", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    store.findCollectable = vi.fn(async () => ["batch-a", "batch-b"]);
    let callCount = 0;
    store.collectStagedRows = vi.fn(async (restoreBatchId: string) => {
      collectStagedRowsCalls.push(restoreBatchId);
      callCount += 1;
      if (callCount === 1) return { files: 10, folders: 3 };
      return { files: 5, folders: 1 };
    });

    const report = await sweepAbandonedRestores(store, now);

    expect(collectStagedRowsCalls).toEqual(["batch-a", "batch-b"]);
    expect(report.collected).toBe(2);
    expect(report.stagedFiles).toBe(15);
    expect(report.stagedFolders).toBe(4);
  });

  it("swallows a collect error and continues", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    store.findCollectable = vi.fn(async () => ["batch-1", "batch-2", "batch-3"]);
    let callCount = 0;
    store.collectStagedRows = vi.fn(async (restoreBatchId: string) => {
      collectStagedRowsCalls.push(restoreBatchId);
      callCount += 1;
      if (callCount === 1) return { files: 2, folders: 0 };
      if (callCount === 2) throw new Error("R2 unreachable");
      return { files: 7, folders: 2 };
    });

    const report = await sweepAbandonedRestores(store, now);

    expect(report.collected).toBe(2); // batch-1 and batch-3
    expect(report.stagedFiles).toBe(9);
    expect(report.stagedFolders).toBe(2);
  });

  it("continues to collect even if findAbandoned threw", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    store.findAbandoned = vi.fn(async () => {
      throw new Error("index unavailable");
    });
    store.findCollectable = vi.fn(async () => ["batch-x"]);
    store.collectStagedRows = vi.fn(async () => ({ files: 3, folders: 1 }));

    const report = await sweepAbandonedRestores(store, now);

    expect(report.abandoned).toBe(0);
    expect(report.collected).toBe(1);
    expect(report.stagedFiles).toBe(3);
    expect(report.stagedFolders).toBe(1);
  });

  it("returns zero when findCollectable threw", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    store.findCollectable = vi.fn(async () => {
      throw new Error("DB down");
    });

    const report = await sweepAbandonedRestores(store, now);

    expect(report.collected).toBe(0);
    expect(report.stagedFiles).toBe(0);
    expect(report.stagedFolders).toBe(0);
  });
});
