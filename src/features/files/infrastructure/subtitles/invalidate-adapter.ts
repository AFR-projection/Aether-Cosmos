import { db } from "@/shared/infrastructure/db";
import { subtitlePipelineRuns } from "@/shared/infrastructure/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { postgresSubtitlePipelineStore } from "./pipeline-store";
import type { SubtitleSourceInvalidation } from "@files/application/commands/versions";

/**
 * Invalidate all active subtitle runs tied to a file whose source just changed.
 *
 * Wired as `invalidateSubtitleSource` in `VersionCommandHooks`. Each active run
 * (queued/running/blocked) is marked stale and its pending work items are cancelled
 * so no orphan publish can land on the old source version.
 */
export async function invalidateSubtitleSourceForFile(
  source: SubtitleSourceInvalidation
): Promise<void> {
  const store = postgresSubtitlePipelineStore();
  const now = new Date();

  // Find every active run for this file — the same file could have multiple
  // concurrent runs (one fresh upload plus a backfill retry, for example).
  const activeRuns = await db
    .select({ id: subtitlePipelineRuns.id })
    .from(subtitlePipelineRuns)
    .where(
      and(
        eq(subtitlePipelineRuns.fileId, source.fileId),
        inArray(subtitlePipelineRuns.status, ["queued", "running", "blocked"])
      )
    );

  for (const row of activeRuns) {
    await store.invalidateRun(
      row.id,
      "SOURCE_REPLACED",
      `Source v${source.sourceVersion} was replaced before subtitle work completed.`,
      now
    );
  }
}
