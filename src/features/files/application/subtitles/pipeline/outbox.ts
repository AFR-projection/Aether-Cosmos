import type { OutboxMessage, SubtitlePipelineStore } from "./contracts";

/** Queue is only a wake-up hint. Delivery identity is durable `(work item, delivery sequence)`. */
export async function dispatchSubtitleOutbox(
  store: SubtitlePipelineStore,
  enqueue: (message: OutboxMessage) => Promise<void>,
  limit = 100
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("limit must be 1..1000");
  return store.enqueueOutbox(limit, enqueue);
}
