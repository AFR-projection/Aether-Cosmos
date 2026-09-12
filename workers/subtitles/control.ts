import "@/shared/lib/env/load-env";
import { workDeliveryHandlers } from "./handlers";
import { startSubtitleWorker } from "./runtime";
import { handleSubtitleWork } from "./handler-entry";
import { startOutboxPump } from "./outbox-pump";
import { runSubtitleReconciliation } from "./reconcile-run";

/** How often the control worker sweeps backfill/lease-repair/locale reconciliation. */
const RECONCILE_INTERVAL_MS = Number(process.env.SUBTITLE_RECONCILE_INTERVAL_MS ?? 300_000);

let sweeping = false;
/** One sweep, guarded so a slow pass never piles up behind itself on the interval. */
async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await runSubtitleReconciliation();
  } catch (error) {
    // The sweep releases its lease before rethrowing; log and keep the interval alive —
    // a failed sweep must not kill the worker or stop later sweeps from retrying.
    console.error(`Subtitle reconciliation sweep failed: ${(error as Error).message}`);
  } finally {
    sweeping = false;
  }
}

void startSubtitleWorker({ role: "control", handlers: workDeliveryHandlers(handleSubtitleWork) })
  .then(() => {
    // Only the control replica pumps the outbox, so N replicas cannot enqueue the
    // same row twice within one tick; BullMQ job ids dedupe across replicas anyway.
    if (process.env.SUBTITLE_OUTBOX_PUMP_DISABLED !== "true") startOutboxPump();
    // Reconciliation is one-shot by design (leases + fencing make sweeps safe to
    // overlap), so the control worker schedules it. The first sweep runs immediately:
    // a fresh deploy should start backfilling before the first interval elapses.
    if (process.env.SUBTITLE_RECONCILE_DISABLED !== "true") {
      void sweep();
      const timer = setInterval(() => void sweep(), RECONCILE_INTERVAL_MS);
      // The interval must not hold the process open if the worker is told to stop.
      timer.unref();
    }
  })
  .catch((error) => {
    console.error(`Subtitle control worker failed to start: ${(error as Error).message}`);
    process.exitCode = 1;
  });
