import { db } from "@/shared/infrastructure/db";
import { subtitleCuePartitions, subtitleAudioChunks, subtitlePipelineTargets, subtitlePipelineWorkItems } from "@/shared/infrastructure/db/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { downloadR2Stream } from "@/shared/infrastructure/storage/r2-stream";
import { mergeChunkTranscripts, normalizeCues, type TranscriptChunk } from "@files/domain/services/subtitles/cues";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";
import { subtitleLanguagesEquivalent } from "@files/domain/services/subtitles/locale-targets";
import { createCandidateTrack, replaceCues, findAsrTrack } from "@files/infrastructure/subtitles/tracks";
import { workKey } from "@files/application/subtitles/pipeline/ledger";
import type { PipelineDependencies } from "./compose";
import type { ClaimedWork, PipelineRun, SubtitlePipelineStore, WorkSeed } from "@files/application/subtitles/pipeline/contracts";

const WORK_TERMINAL = ["succeeded", "failed", "cancelled", "blocked"] as const;

/** True when every prepare and ASR item for the run has reached a terminal state. */
async function transcriptionComplete(runId: string): Promise<boolean> {
  const [open] = await db
    .select({ id: subtitlePipelineWorkItems.id })
    .from(subtitlePipelineWorkItems)
    .where(and(
      eq(subtitlePipelineWorkItems.runId, runId),
      notInArray(subtitlePipelineWorkItems.kind, ["materialize", "translate", "publish", "cleanup", "control"]),
      notInArray(subtitlePipelineWorkItems.status, [...WORK_TERMINAL])
    ))
    .limit(1);
  return !open;
}

async function readPartitionCues(objectKey: string): Promise<SubtitleCue[]> {
  const { body } = await downloadR2Stream(objectKey);
  if (!body) throw new Error(`Empty partition object: ${objectKey}`);
  const buffers: Buffer[] = [];
  for await (const piece of body) {
    buffers.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array));
  }
  const parsed = JSON.parse(Buffer.concat(buffers).toString("utf8")) as { cues: SubtitleCue[] };
  return parsed.cues;
}

export async function handleMaterializeStage(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string,
  deps: PipelineDependencies
): Promise<void> {
  const lease = { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken };

  // Source materialization: targetId is null. Translation: targetId is set.
  if (claimed.targetId === null) {
    await materializeSource(store, claimed, run, now, deps, lease);
  } else {
    await materializeTranslation(store, claimed, run, now, deps, lease);
  }
}

async function materializeSource(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  deps: PipelineDependencies,
  lease: { id: string; leaseOwner: string; fencingToken: number }
): Promise<void> {
  try {
    // The first ASR completion creates this item; wait for planning to finish and every
    // prepare/ASR item to reach a terminal state before stitching (later pages' items do not
    // exist until the planner creates them, so an empty open-items query alone is not enough).
    const planningDone = run.durationMs !== null && run.plannerCursorMs >= run.durationMs;
    if (!planningDone || !(await transcriptionComplete(run.id))) {
      await store.retry(lease, { code: "TRANSCRIPTION_INCOMPLETE", message: "Planning or ASR items are still open", availableAt: new Date(now.getTime() + 30_000) }, now);
      return;
    }

    const partitionRows = await db
      .select()
      .from(subtitleCuePartitions)
      .where(and(
        eq(subtitleCuePartitions.runId, run.id),
        eq(subtitleCuePartitions.kind, "source")
      ));

    if (partitionRows.length === 0) {
      await store.complete(lease, { outcome: "no-partitions" }, now);
      return;
    }

    // Partitions already carry absolute timeline cues (ASR offsets them at insert).
    // Sort and normalize directly: a second offset here would shift every cue past its time.
    const chunks: TranscriptChunk[] = [];
    for (const partition of partitionRows.sort((a, b) => a.ordinal - b.ordinal)) {
      chunks.push({ offsetMs: 0, cues: await readPartitionCues(partition.objectKey) });
    }

    const cues = normalizeCues(mergeChunkTranscripts(chunks));
    const durationMs = cues.length > 0 ? cues[cues.length - 1].endMs : 0;

    // Weighted language evidence: the most common non-null detection wins.
    const audioRows = await db
      .select({ detectedLanguage: subtitleAudioChunks.detectedLanguage })
      .from(subtitleAudioChunks)
      .where(eq(subtitleAudioChunks.runId, run.id));
    const tally = new Map<string, number>();
    for (const row of audioRows) {
      if (!row.detectedLanguage) continue;
      tally.set(row.detectedLanguage, (tally.get(row.detectedLanguage) ?? 0) + 1);
    }
    const sourceLanguage = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "und";

    const track = await createCandidateTrack({
      fileId: run.fileId,
      language: sourceLanguage,
      origin: "asr",
      createdBy: run.userId,
      trackState: "candidate",
      pipelineRunId: run.id,
      sourceVersion: run.sourceVersion,
      sourceR2Key: run.sourceR2Key,
      sourceMimeType: run.sourceMimeType,
      status: "processing",
      cueCount: cues.length,
      durationSeconds: Math.ceil(durationMs / 1000),
    });

    await replaceCues(track.id, cues);
    await db
      .update(subtitleCuePartitions)
      .set({ trackId: track.id, materializationState: "materialized", materializedAt: now })
      .where(and(
        eq(subtitleCuePartitions.runId, run.id),
        eq(subtitleCuePartitions.kind, "source")
      ));

    deps.log(`materialize source run ${run.id}: ${cues.length} cues → track ${track.id} (${sourceLanguage})`);

    // Fan out per-target translation work; languages equivalent to the source are satisfied
    // by the transcript itself and never billed a translation.
    const targets = await store.listTargets(run.id);
    const translateSeeds: WorkSeed[] = [];
    for (const target of targets) {
      if (target.status !== "pending") continue;
      if (subtitleLanguagesEquivalent(sourceLanguage, target.language)) {
        await db
          .update(subtitlePipelineTargets)
          .set({ status: "satisfied", terminalCode: "SOURCE_LANGUAGE_EQUIVALENT", updatedAt: now })
          .where(eq(subtitlePipelineTargets.id, target.id));
        continue;
      }
      translateSeeds.push({
        runId: run.id,
        targetId: target.id,
        userId: run.userId,
        kind: "translate",
        idempotencyKey: workKey(run, "translate", undefined, target.language),
        ordinal: null,
        cursorStartMs: null,
        cursorEndMs: null,
      });
    }
    await store.createWork(translateSeeds, now);

    // Publish the source track itself.
    await store.createWork([{
      runId: run.id,
      targetId: null,
      userId: run.userId,
      kind: "publish",
      idempotencyKey: workKey(run, "publish", undefined, sourceLanguage),
      ordinal: null,
      cursorStartMs: null,
      cursorEndMs: null,
    }], now);

    await store.complete(lease, {
      outcome: "materialized",
      checkpoint: { targetLanguage: sourceLanguage, trackId: track.id, cueCount: cues.length, durationMs },
    }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Materialize source failed";
    await store.retry(lease, { code: "MATERIALIZE_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 60_000) }, now);
    throw error;
  }
}

async function materializeTranslation(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  deps: PipelineDependencies,
  lease: { id: string; leaseOwner: string; fencingToken: number }
): Promise<void> {
  const targets = await store.listTargets(run.id);
  const target = targets.find((t) => t.id === claimed.targetId);
  if (!target) {
    await store.complete(lease, { outcome: "no-target" }, now);
    return;
  }

  try {
    const partitionRows = await db
      .select()
      .from(subtitleCuePartitions)
      .where(and(
        eq(subtitleCuePartitions.runId, run.id),
        eq(subtitleCuePartitions.targetId, target.id),
        eq(subtitleCuePartitions.kind, "translation")
      ));

    if (partitionRows.length === 0) {
      await store.retry(lease, { code: "NO_PARTITIONS", message: `No translation partitions for ${target.language}`, availableAt: new Date(now.getTime() + 10_000) }, now);
      return;
    }

    let cues: SubtitleCue[] = [];
    for (const partition of partitionRows.sort((a, b) => a.ordinal - b.ordinal)) {
      cues.push(...(await readPartitionCues(partition.objectKey)));
    }
    cues = normalizeCues(cues);
    const durationMs = cues.length > 0 ? cues[cues.length - 1].endMs : 0;

    const asrTrack = await findAsrTrack(run.fileId);

    const track = await createCandidateTrack({
      fileId: run.fileId,
      language: target.language,
      origin: "translated",
      createdBy: run.userId,
      translatedFromId: asrTrack?.id ?? null,
      trackState: "candidate",
      pipelineRunId: run.id,
      sourceVersion: run.sourceVersion,
      sourceR2Key: run.sourceR2Key,
      sourceMimeType: run.sourceMimeType,
      sourceTrackRevision: asrTrack?.revision ?? null,
      status: "processing",
      cueCount: cues.length,
      durationSeconds: Math.ceil(durationMs / 1000),
    });

    await replaceCues(track.id, cues);
    await db
      .update(subtitleCuePartitions)
      .set({ trackId: track.id, materializationState: "materialized", materializedAt: now })
      .where(and(
        eq(subtitleCuePartitions.runId, run.id),
        eq(subtitleCuePartitions.targetId, target.id),
        eq(subtitleCuePartitions.kind, "translation")
      ));

    deps.log(`materialize translation run ${run.id} ${target.language}: ${cues.length} cues → track ${track.id}`);

    await store.createWork([{
      runId: run.id,
      targetId: target.id,
      userId: run.userId,
      kind: "publish",
      idempotencyKey: workKey(run, "publish", undefined, target.language),
      ordinal: null,
      cursorStartMs: null,
      cursorEndMs: null,
    }], now);

    await store.complete(lease, {
      outcome: "materialized",
      checkpoint: { targetLanguage: target.language, trackId: track.id, cueCount: cues.length, durationMs },
    }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : `Materialize ${target.language} failed`;
    await store.retry(lease, { code: "MATERIALIZE_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 60_000) }, now);
    throw error;
  }
}
