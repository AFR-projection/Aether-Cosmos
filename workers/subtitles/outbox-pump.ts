import { enqueueSubtitleWorkKind } from "@/shared/infrastructure/queue";
import { dispatchSubtitleOutbox } from "@files/application/subtitles/pipeline/outbox";
import { postgresSubtitlePipelineStore } from "@files/infrastructure/subtitles/pipeline-store";
import type { OutboxMessage } from "@files/application/subtitles/pipeline/contracts";

const DEFAULT_INTERVAL_MS = 2_000;
const BATCH_LIMIT = 100;

/**
 * Periodically move due ledger rows onto their BullMQ queues.
 *
 * The DB ledger is the retry authority; BullMQ is only a wake-up hint, so a missed
 * tick costs latency, never work. A failed enqueue leaves the row pending, and the
 * next tick re-picks it with a fresh delivery sequence.
 */
export function startOutboxPump(
  input: { intervalMs?: number; limit?: number } = {}
): () => void {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const limit = input.limit ?? BATCH_LIMIT;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // one pump per process; a slow Redis must not stack ticks
    running = true;
    try {
      const store = postgresSubtitlePipelineStore();
      const sent = await dispatchSubtitleOutbox(
        store,
        async (message: OutboxMessage) => {
          await enqueueSubtitleWorkKind(message.kind, {
            workItemId: message.workItemId,
            deliverySequence: message.deliverySequence,
          });
        },
        limit
      );
      if (sent > 0) console.log(`Subtitle outbox pump delivered ${sent} work item(s)`);
    } catch (error) {
      console.error(`Subtitle outbox pump failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
