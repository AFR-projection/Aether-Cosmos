import { db } from "@/shared/infrastructure/db";
import { subtitleAudioChunks, subtitleCuePartitions, subtitlePipelineWorkItems, subtitlePipelineTargets } from "@/shared/infrastructure/db/schema";
import { and, eq, not, notInArray } from "drizzle-orm";
import { deleteR2Objects } from "@/shared/infrastructure/storage/r2-objects";
import type { PipelineDependencies } from "./compose";
import type { ClaimedWork, PipelineRun, SubtitlePipelineStore } from "@files/application/subtitles/pipeline/contracts";

/**
 * Deletes a run's R2 intermediates once every target is terminal.
 *
 * Final playback lives in PostgreSQL, so every object under the run's prefix is disposable.
 * Objects are deleted before their rows: a failed delete leaves the row behind for the next
 * sweep rather than orphaning the object.
 */

const TARGET_TERMINAL = ["ready", "satisfied", "failed", "cancelled", "skipped", "stale", "blocked"] as const;
const WORK_TERMINAL = ["succeeded", "failed", "cancelled", "blocked"] as const;

export async function handleCleanupStage(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string,
  deps: PipelineDependencies
): Promise<void> {
  const lease = { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken };

  if (["queued", "running", "blocked"].includes(run.status)) {
    // A live run still owns its checkpoints; park until it goes terminal.
    await store.retry(
      lease,
      { code: "RUN_NOT_TERMINAL", message: `Run is ${run.status}; cleanup waits for a terminal state`, availableAt: new Date(now.getTime() + 15 * 60_000) },
      now
    );
    return;
  }

  // Even on a completed run, never delete while any target or work item is still in flight —
  // a publish that lands after this point would lose the partitions it validates against.
  const openTargets = await db
    .select({ id: subtitlePipelineTargets.id })
    .from(subtitlePipelineTargets)
    .where(and(
      eq(subtitlePipelineTargets.runId, run.id),
      notInArray(subtitlePipelineTargets.status, [...TARGET_TERMINAL])
    ))
    .limit(1);
  if (openTargets.length > 0) {
    await store.retry(
      lease,
      { code: "TARGETS_OPEN", message: "Some targets are still in flight", availableAt: new Date(now.getTime() + 5 * 60_000) },
      now
    );
    return;
  }
  const openWork = await db
    .select({ id: subtitlePipelineWorkItems.id })
    .from(subtitlePipelineWorkItems)
    .where(and(
      eq(subtitlePipelineWorkItems.runId, run.id),
      not(eq(subtitlePipelineWorkItems.kind, "cleanup")),
      notInArray(subtitlePipelineWorkItems.status, [...WORK_TERMINAL])
    ))
    .limit(1);
  if (openWork.length > 0) {
    await store.retry(
      lease,
      { code: "WORK_OPEN", message: "Some work items are still in flight", availableAt: new Date(now.getTime() + 5 * 60_000) },
      now
    );
    return;
  }

  try {
    const audioRows = await db
      .select({ id: subtitleAudioChunks.id, objectKey: subtitleAudioChunks.objectKey })
      .from(subtitleAudioChunks)
      .where(eq(subtitleAudioChunks.runId, run.id));
    const partitionRows = await db
      .select({ id: subtitleCuePartitions.id, objectKey: subtitleCuePartitions.objectKey })
      .from(subtitleCuePartitions)
      .where(eq(subtitleCuePartitions.runId, run.id));

    const keys = [...audioRows, ...partitionRows].map((row) => row.objectKey);
    if (keys.length > 0) {
      await deleteR2Objects(keys);
      deps.log(`cleanup run ${run.id}: removed ${keys.length} intermediate objects`);
    }
    if (audioRows.length > 0) {
      await db.delete(subtitleAudioChunks).where(eq(subtitleAudioChunks.runId, run.id));
    }
    if (partitionRows.length > 0) {
      await db.delete(subtitleCuePartitions).where(eq(subtitleCuePartitions.runId, run.id));
    }

    await store.complete(lease, { outcome: "cleaned", objects: keys.length }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cleanup failed";
    await store.retry(lease, { code: "CLEANUP_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 10 * 60_000) }, now);
    throw error;
  }
}
