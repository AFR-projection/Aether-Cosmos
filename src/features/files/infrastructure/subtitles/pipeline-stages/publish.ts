import { db } from "@/shared/infrastructure/db";
import { subtitleTracks, subtitlePipelineTargets, subtitlePipelineRuns } from "@/shared/infrastructure/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { workKey } from "@files/application/subtitles/pipeline/ledger";
import type { PipelineDependencies } from "./compose";
import type { ClaimedWork, PipelineRun, SubtitlePipelineStore } from "@files/application/subtitles/pipeline/contracts";

interface PublishCheckpoint {
  readonly targetLanguage: string;
  readonly trackId: string;
  readonly supersededTrackId: string | null;
  readonly revision: number;
}

const TARGET_TERMINAL = ["ready", "satisfied", "failed", "cancelled", "skipped", "stale", "blocked"] as const;

export async function handlePublishStage(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string,
  deps: PipelineDependencies
): Promise<void> {
  const lease = { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken };

  // Revalidate source
  const source = await store.revalidateSource(run);
  if (
    !source ||
    source.encrypted ||
    source.deletedAt ||
    source.version !== run.sourceVersion ||
    source.r2Key !== run.sourceR2Key ||
    source.mimeType !== run.sourceMimeType ||
    source.userId !== run.userId
  ) {
    await store.invalidateRun(run.id, "SOURCE_STALE", "The source changed before subtitle work completed.", now);
    await store.complete(lease, { outcome: "source-stale" }, now);
    return;
  }

  // Determine what we're publishing
  const isSource = claimed.targetId === null;
  let targetLanguage: string;
  let targetOrigin: "asr" | "translated";

  if (isSource) {
    // Source track: find the language from the candidate track
    const candidateTracks = await db
      .select()
      .from(subtitleTracks)
      .where(and(
        eq(subtitleTracks.fileId, run.fileId),
        eq(subtitleTracks.pipelineRunId, run.id),
        eq(subtitleTracks.origin, "asr"),
        eq(subtitleTracks.trackState, "candidate")
      ))
      .orderBy(sql`${subtitleTracks.revision} DESC`)
      .limit(1);

    if (!candidateTracks[0]) {
      await store.retry(lease, { code: "NO_CANDIDATE", message: "Source candidate track not found", availableAt: new Date(now.getTime() + 10_000) }, now);
      return;
    }

    targetLanguage = candidateTracks[0].language;
    targetOrigin = "asr";
  } else {
    // Translation track
    const targets = await store.listTargets(run.id);
    const target = targets.find((t) => t.id === claimed.targetId);
    if (!target) {
      await store.complete(lease, { outcome: "no-target" }, now);
      return;
    }

    targetLanguage = target.language;
    targetOrigin = "translated";
  }

  // Find candidate track
  const candidateTracks = await db
    .select()
    .from(subtitleTracks)
    .where(and(
      eq(subtitleTracks.fileId, run.fileId),
      eq(subtitleTracks.language, targetLanguage),
      eq(subtitleTracks.origin, targetOrigin),
      eq(subtitleTracks.pipelineRunId, run.id),
      eq(subtitleTracks.trackState, "candidate")
    ))
    .orderBy(sql`${subtitleTracks.revision} DESC`)
    .limit(1);

  if (!candidateTracks[0]) {
    await store.retry(lease, { code: "NO_CANDIDATE", message: `Candidate ${targetOrigin} track for ${targetLanguage} not found`, availableAt: new Date(now.getTime() + 10_000) }, now);
    return;
  }

  const candidate = candidateTracks[0];

  try {
    // Find current track to supersede (if any)
    const currentTrack = await db
      .select()
      .from(subtitleTracks)
      .where(and(
        eq(subtitleTracks.fileId, run.fileId),
        eq(subtitleTracks.language, targetLanguage),
        eq(subtitleTracks.origin, targetOrigin),
        eq(subtitleTracks.trackState, "current")
      ))
      .limit(1);

    const supersededTrackId = currentTrack[0]?.id ?? null;

    // Atomic promotion in transaction: demote old current, promote candidate to current
    await db.transaction(async (tx) => {
      if (supersededTrackId) {
        await tx
          .update(subtitleTracks)
          .set({ trackState: "superseded", supersededById: candidate.id, updatedAt: now })
          .where(eq(subtitleTracks.id, supersededTrackId));
      }
      await tx
        .update(subtitleTracks)
        .set({
          trackState: "current",
          status: "ready",
          readyAt: now,
          progress: 100,
          updatedAt: now,
        })
        .where(eq(subtitleTracks.id, candidate.id));
    });

    // Update target status if this is a translation
    if (!isSource && claimed.targetId) {
      await db
        .update(subtitlePipelineTargets)
        .set({ status: "ready", readyAt: now, updatedAt: now })
        .where(eq(subtitlePipelineTargets.id, claimed.targetId));
    }

    deps.log(`publish run ${run.id} lang ${targetLanguage} origin ${targetOrigin}: candidate ${candidate.id} → current${supersededTrackId ? ` (superseded ${supersededTrackId})` : ""}`);

    // Check if all targets for this run are now terminal; if so, mark run completed
    // and create the cleanup work item.
    const targets = await store.listTargets(run.id);
    const allTerminal = targets.every((t) => (TARGET_TERMINAL as readonly string[]).includes(t.status));
    if (allTerminal) {
      await db
        .update(subtitlePipelineRuns)
        .set({ status: "completed", stage: "completed", completedAt: now, updatedAt: now, progress: 100 })
        .where(eq(subtitlePipelineRuns.id, run.id));
      await store.createWork([{
        runId: run.id,
        targetId: null,
        userId: run.userId,
        kind: "cleanup",
        idempotencyKey: workKey(run, "cleanup"),
        ordinal: null,
        cursorStartMs: null,
        cursorEndMs: null,
      }], now);
    }

    const checkpoint: PublishCheckpoint = {
      targetLanguage,
      trackId: candidate.id,
      supersededTrackId,
      revision: candidate.revision,
    };
    await store.complete(lease, { outcome: "published", checkpoint }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish failed";
    await store.retry(lease, { code: "PUBLISH_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 60_000) }, now);
    throw error;
  }
}
