import "@/shared/lib/env/load-env";
import { runSubtitleReconciliation } from "./reconcile-run";

void runSubtitleReconciliation({
  backfillLimit: Number(process.env.SUBTITLE_BACKFILL_BATCH ?? 200),
  leaseRepairLimit: Number(process.env.SUBTITLE_LEASE_REPAIR_BATCH ?? 50),
}).catch((error) => {
  console.error(`Subtitle reconciliation failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
