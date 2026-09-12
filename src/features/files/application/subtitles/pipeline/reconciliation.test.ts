import { describe, expect, it } from "vitest";
import { ensureSubtitlePipeline } from "./ensure";
import { MemorySubtitlePipelineStore } from "./memory-store";
import { backfillSubtitlePipelines, reconcileSubtitleLocales } from "./reconciliation";
import { pipelineTestSource } from "./ensure.test";

describe("pipeline reconciliation", () => {
  it("resumes a keyset backfill without skipping equal timestamps", async () => {
    const createdAt = new Date("2026-02-01T00:00:00Z");
    const store = new MemorySubtitlePipelineStore([
      pipelineTestSource({ fileId: "a", r2Key: "a", createdAt }),
      pipelineTestSource({ fileId: "b", r2Key: "b", createdAt }),
      pipelineTestSource({ fileId: "c", r2Key: "c", createdAt: new Date(createdAt.getTime() + 1) }),
    ]);
    const first = await backfillSubtitlePipelines(store, { limit: 2 });
    expect(first.processed).toBe(2);
    expect(first.cursor?.fileId).toBe("b");
    const second = await backfillSubtitlePipelines(store, { limit: 2, cursor: first.cursor });
    expect(second.processed).toBe(1);
    expect(store.runs.size).toBe(3);
  });

  it("adds newly introduced locales and never removes old targets", async () => {
    const store = new MemorySubtitlePipelineStore([pipelineTestSource()]);
    const { run } = await ensureSubtitlePipeline({ fileId: "f1", locales: ["en", "id"] }, store);
    const reconciled = await reconcileSubtitleLocales(store, { runId: run.id, locales: ["en", "id", "zh-CN"] });
    expect(reconciled.added).toBe(1);
    expect((await store.listTargets(run.id)).map((item) => item.language)).toEqual(["en", "id", "zh-CN"]);
  });
});
