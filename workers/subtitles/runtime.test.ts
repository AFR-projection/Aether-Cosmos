import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { dispatchRegisteredHandler, workerConcurrency } from "./runtime";

describe("subtitle worker runtime", () => {
  it("uses bounded role defaults and validated overrides", () => {
    expect(workerConcurrency("prepare", {} as Record<string, string>)).toBe(1);
    expect(workerConcurrency("translate", { SUBTITLE_TRANSLATE_CONCURRENCY: "6" } as Record<string, string>)).toBe(6);
    expect(() => workerConcurrency("asr", { SUBTITLE_ASR_CONCURRENCY: "0" } as Record<string, string>)).toThrow();
    expect(() => workerConcurrency("control", { SUBTITLE_CONTROL_CONCURRENCY: "1.5" } as Record<string, string>)).toThrow();
  });

  it("dispatches by sanitized data type and falls back to the BullMQ job name", async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    await dispatchRegisteredHandler(
      { name: "fallback", data: { type: "work", secret: "not logged" } } as Job,
      { work }
    );
    await dispatchRegisteredHandler({ name: "fallback", data: {} } as Job, { fallback: work });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("fails closed for unregistered work", async () => {
    await expect(
      dispatchRegisteredHandler({ name: "unknown", data: {} } as Job, {})
    ).rejects.toThrow("No handler registered");
  });
});
