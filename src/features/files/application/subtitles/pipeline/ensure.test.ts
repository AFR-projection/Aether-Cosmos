import { describe, expect, it } from "vitest";
import { ensureSubtitlePipeline, ENCRYPTED_UNSUPPORTED_CODE } from "./ensure";
import { MemorySubtitlePipelineStore } from "./memory-store";

const source = (overrides: Partial<Parameters<MemorySubtitlePipelineStore["sources"]["set"]>[1]> = {}) => ({
  fileId: "f1", userId: "u1", version: 7, r2Key: "u1/f1/video.mp4", mimeType: "video/mp4",
  encrypted: false, deletedAt: null, durationMs: 2_000_000, createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("ensureSubtitlePipeline", () => {
  it("is idempotent and atomically establishes LOCALES plus control work", async () => {
    const store = new MemorySubtitlePipelineStore([source()]);
    const first = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    const second = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    expect(first.created).toBe(true);
    expect(second).toEqual({ run: first.run, created: false });
    expect((await store.listTargets(first.run.id)).map((item) => item.language)).toEqual(["en", "id", "zh-CN"]);
    expect([...store.work.values()].filter((item) => item.kind === "control")).toHaveLength(1);
    expect(first.run.requestKey).toBe("full:f1:v7:p1");
  });

  it("records encrypted files as explicitly unsupported without work", async () => {
    const store = new MemorySubtitlePipelineStore([source({ encrypted: true })]);
    const { run } = await ensureSubtitlePipeline({ fileId: "f1" }, store);
    expect(run.status).toBe("unsupported");
    expect(run.unsupportedCode).toBe(ENCRYPTED_UNSUPPORTED_CODE);
    expect([...store.work.values()]).toHaveLength(0);
    expect((await store.listTargets(run.id)).every((item) => item.status === "blocked")).toBe(true);
  });
});

export { source as pipelineTestSource };
