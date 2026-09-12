import { describe, expect, it } from "vitest";
import { dispatchSubtitleOutbox } from "./outbox";
import { ensureSubtitlePipeline } from "./ensure";
import { MemorySubtitlePipelineStore } from "./memory-store";
import { pipelineTestSource } from "./ensure.test";

describe("pipeline transactional outbox", () => {
  it("advances a durable delivery sequence and builds unique queue keys", async () => {
    const store = new MemorySubtitlePipelineStore([pipelineTestSource()]);
    await ensureSubtitlePipeline({ fileId: "f1" }, store);
    const delivered: string[] = [];
    await dispatchSubtitleOutbox(store, async (message) => { delivered.push(message.queueKey); });
    await dispatchSubtitleOutbox(store, async (message) => { delivered.push(message.queueKey); });
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatch(/:1$/);
    expect(delivered[1]).toMatch(/:2$/);
    expect(new Set(delivered).size).toBe(2);
  });
});
