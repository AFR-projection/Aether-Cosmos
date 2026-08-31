import { db } from "@/shared/infrastructure/db";
import { runScheduledCleanups } from "@/workers/cleanup";
import { CLEANUP_INTERVAL_MS } from "@/shared/lib/system/cleanup-state";

/**
 * In-app fallback scheduler for the retention sweeps.
 *
 * The BullMQ worker is the preferred runner, but it needs Redis — and when
 * REDIS_DISABLED is set it exits at boot, which silently turned the three
 * retention settings into no-ops. This runs the same sweep from the web server
 * so those settings work on every deployment.
 *
 * Safe to run alongside the worker and across multiple app instances: the sweep
 * itself claims a database lock, so duplicate ticks are cheap no-ops.
 */

/** First tick is delayed so a boot-time restart loop cannot hammer the DB. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

/** Ticks more often than the interval; the DB claim decides what actually runs. */
const TICK_MS = 15 * 60 * 1000;

let started = false;

async function tick(): Promise<void> {
  try {
    await runScheduledCleanups(db, "app");
  } catch (error) {
    console.error("[cleanup:app] sweep failed", error);
  }
}

export function startCleanupScheduler(): void {
  if (started) return;
  started = true;

  const timer = setTimeout(() => {
    void tick();
    const interval = setInterval(() => void tick(), TICK_MS);
    interval.unref?.();
  }, INITIAL_DELAY_MS);
  timer.unref?.();

  console.log(
    `[cleanup:app] scheduler armed (tick ${TICK_MS / 60000}m, min gap ${CLEANUP_INTERVAL_MS / 60000}m)`
  );
}
