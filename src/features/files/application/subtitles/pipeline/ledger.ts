import { automaticSubtitlePipelineKey, planSubtitleChunks } from "@files/domain/services/subtitles/pipeline-planning";
import type { PipelineRun, PipelineStage, SubtitlePipelineStore, WorkSeed } from "./contracts";

export function workKey(run: PipelineRun, kind: string, ordinal?: number, targetLanguage?: string): string {
  const pipelineKey = automaticSubtitlePipelineKey({
    fileId: run.fileId,
    sourceVersion: run.sourceVersion,
    policyVersion: run.policyVersion,
  });
  return [pipelineKey, kind, targetLanguage ?? "-", ordinal ?? "-"].join(":");
}

/** Pure state transition guard for run orchestration. */
export function transitionRun(
  run: Pick<PipelineRun, "status" | "stage">,
  event: "start" | "planned" | "source-ready" | "translated" | "published" | "finish" | "cancel" | "invalidate" | "fail"
): Pick<PipelineRun, "status" | "stage"> {
  if (["completed", "cancelled", "stale", "failed", "unsupported"].includes(run.status)) {
    throw new Error(`Cannot ${event} a terminal run`);
  }
  if (event === "invalidate") return { status: "stale", stage: run.stage };
  if (event === "cancel") return { status: "cancelled", stage: run.stage };
  if (event === "fail") return { status: "failed", stage: run.stage };
  if (event === "finish") return { status: "completed", stage: "completed" };

  const map: Record<"start" | "planned" | "source-ready" | "translated" | "published", PipelineStage> = {
    start: "planning",
    planned: "preparing",
    "source-ready": "materializing_source",
    translated: "publishing",
    published: "cleanup",
  };
  return { status: "running", stage: map[event] };
}

/** Pure fencing-aware work transition, useful to handlers before attempting a side effect. */
export function mayMutateWithLease(
  item: { status: string; leaseOwner: string | null; fencingToken: number; leaseExpiresAt: Date | null },
  lease: { leaseOwner: string; fencingToken: number },
  now: Date
): boolean {
  return item.status === "leased" &&
    item.leaseOwner === lease.leaseOwner &&
    item.fencingToken === lease.fencingToken &&
    item.leaseExpiresAt !== null &&
    item.leaseExpiresAt.getTime() > now.getTime();
}

/**
 * Writes one bounded planner page (at most 24 600-second windows). The cursor CAS allows many
 * planners to race without duplicating ranges; unique work keys make a retry after commit harmless.
 */
export async function planNextSubtitleWindow(
  runId: string,
  store: SubtitlePipelineStore,
  now: Date = new Date()
): Promise<{ created: number; complete: boolean; nextCursorMs: number }> {
  const run = await store.getRun(runId);
  if (!run) throw new Error("SUBTITLE_RUN_NOT_FOUND");
  if (run.durationMs === null) throw new Error("SUBTITLE_DURATION_UNKNOWN");
  const source = await store.revalidateSource(run);
  if (!source || source.encrypted || source.deletedAt ||
      source.version !== run.sourceVersion || source.r2Key !== run.sourceR2Key ||
      source.mimeType !== run.sourceMimeType || source.userId !== run.userId) {
    await store.invalidateRun(run.id, "SOURCE_STALE", "The source changed before subtitle work completed.", now);
    return { created: 0, complete: true, nextCursorMs: run.plannerCursorMs };
  }

  const nextOrdinal = Math.floor(run.plannerCursorMs / 600_000);
  const page = planSubtitleChunks({ durationMs: run.durationMs, cursorMs: run.plannerCursorMs, nextOrdinal });
  const seeds: WorkSeed[] = page.chunks.map((chunk) => ({
    runId: run.id,
    targetId: null,
    userId: run.userId,
    kind: "prepare",
    idempotencyKey: workKey(run, "prepare", chunk.ordinal),
    ordinal: chunk.ordinal,
    cursorStartMs: chunk.startMs,
    cursorEndMs: chunk.endMs,
  }));
  const created = await store.createWork(seeds, now);
  const stage: PipelineStage = page.complete ? "preparing" : "planning";
  const advanced = await store.advancePlan(run.id, run.plannerCursorMs, page.nextCursorMs, stage, now);
  return { created: advanced ? created.length : 0, complete: page.complete, nextCursorMs: advanced ? page.nextCursorMs : run.plannerCursorMs };
}

export function retryDelayMs(attemptCount: number, seed = 1_000, cap = 15 * 60_000): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) throw new RangeError("attemptCount must be positive");
  return Math.min(cap, seed * 2 ** Math.min(20, attemptCount - 1));
}
