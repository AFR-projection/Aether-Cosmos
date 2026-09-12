import { db } from "@/shared/infrastructure/db";
import { subtitleAudioChunks, subtitleCuePartitions } from "@/shared/infrastructure/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadR2Stream } from "@/shared/infrastructure/storage/r2-stream";
import { putR2Object } from "@/shared/infrastructure/storage/r2-objects";
import { OpenAiCompatibleTranscriber, type TranscriptionInput, type TranscriptionResult } from "@files/infrastructure/subtitles/transcriber";
import { loadSubtitleConfig } from "@files/infrastructure/subtitles/config";
import { createHash } from "node:crypto";
import { normalizeLanguageTag } from "@files/domain/services/subtitles/languages";
import { subtitleProviderRequestKey } from "@files/domain/services/subtitles/pipeline-planning";
import { workKey } from "@files/application/subtitles/pipeline/ledger";
import type { PipelineDependencies } from "./compose";
import type { ClaimedWork, PipelineRun, SubtitlePipelineStore, WorkSeed } from "@files/application/subtitles/pipeline/contracts";

interface AsrCheckpoint {
  readonly ordinal: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly providerResultKey: string;
  readonly providerResultChecksum: string;
  readonly language: string | null;
  readonly durationSeconds: number | null;
  readonly cues: TranscriptionResult["cues"];
}

export async function handleAsrStage(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string,
  deps: PipelineDependencies
): Promise<void> {
  if (claimed.cursorStartMs === null || claimed.cursorEndMs === null) {
    throw new Error("ASR work item missing cursor range");
  }
  if (claimed.ordinal === null) {
    throw new Error("ASR work item missing ordinal");
  }

  const lease = { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken };

  // Get the audio chunk from prepare stage
  const chunkRows = await db
    .select()
    .from(subtitleAudioChunks)
    .where(
      and(
        eq(subtitleAudioChunks.runId, run.id),
        eq(subtitleAudioChunks.ordinal, claimed.ordinal)
      )
    );

  if (chunkRows.length === 0) {
    // No audio chunks prepared yet - retry later
    await store.retry(lease, { code: "NO_CHUNKS", message: "Audio chunks not yet prepared", availableAt: new Date(now.getTime() + 10_000) }, now);
    return;
  }

  const chunk = chunkRows[0];

  // Checkpoint reuse: a previous attempt already paid for this chunk's transcription and
  // committed its partition, so retrying must not bill the provider a second time. The
  // partition row is the proof — it is inserted only after the R2 object is written.
  const [existingPartition] = await db
    .select({ objectKey: subtitleCuePartitions.objectKey })
    .from(subtitleCuePartitions)
    .where(and(
      eq(subtitleCuePartitions.runId, run.id),
      eq(subtitleCuePartitions.kind, "source"),
      eq(subtitleCuePartitions.ordinal, chunk.ordinal)
    ))
    .limit(1);
  if (chunk.providerResultKey && existingPartition) {
    deps.log(`asr run ${run.id} chunk ${chunk.ordinal}: reusing checkpoint, provider not called`);
    await store.createWork([{
      runId: run.id,
      targetId: null,
      userId: run.userId,
      kind: "materialize",
      idempotencyKey: workKey(run, "materialize", undefined, "source"),
      ordinal: null,
      cursorStartMs: null,
      cursorEndMs: null,
    }], now);
    await store.complete(lease, { outcome: "checkpoint-reuse", partitionKey: existingPartition.objectKey }, now);
    return;
  }

  // Load transcription config
  const config = await loadSubtitleConfig(db, true);
  if (!config.apiKey) {
    await store.complete(lease, { outcome: "no-config" }, now);
    return;
  }

  const transcriber = new OpenAiCompatibleTranscriber({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    requestId: subtitleProviderRequestKey({
      pipelineKey: `full:${run.fileId}:v${run.sourceVersion}:p${run.policyVersion}`,
      stage: "asr",
      ordinal: claimed.ordinal,
      inputHash: chunk.checksumSha256,
    }),
  });

  const checkpoints: AsrCheckpoint[] = [];

  try {
    const { body } = await downloadR2Stream(chunk.objectKey);
    if (!body) throw new Error(`Empty chunk object: ${chunk.objectKey}`);
    const buffers: Buffer[] = [];
    for await (const piece of body) {
      buffers.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array));
    }
    const audioBuffer = Buffer.concat(buffers);

    // Transcribe
    const input: TranscriptionInput = {
      audio: new Uint8Array(audioBuffer),
      fileName: `${run.id}-${chunk.ordinal}.${chunk.format}`,
      mimeType: chunk.format === "ogg" ? "audio/ogg" : chunk.format === "mp3" ? "audio/mpeg" : "audio/mp4",
      language: null, // let provider detect
    };

    const result = await transcriber.transcribe(input);

    // Write provider result to R2 checkpoint
    const resultChecksum = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    const providerResultKey = `subtitles/v2/${run.fileId}/v${run.sourceVersion}/${run.id}/asr/${chunk.ordinal}/${chunk.checksumSha256}.v1.json`;

    await putR2Object(
      providerResultKey,
      Buffer.from(JSON.stringify(result)),
      "application/json"
    );

    // Update audio chunk row
    await db
      .update(subtitleAudioChunks)
      .set({
        providerResultKey,
        providerResultChecksum: resultChecksum,
        detectedLanguage: result.language,
        languageEvidence: { detected: result.language, duration: result.durationSeconds },
        asrCompletedAt: new Date(),
        updatedAt: now,
      })
      .where(eq(subtitleAudioChunks.id, chunk.id));

    checkpoints.push({
      ordinal: chunk.ordinal,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      providerResultKey,
      providerResultChecksum: resultChecksum,
      language: result.language,
      durationSeconds: result.durationSeconds,
      cues: result.cues,
    });

    // Normalize whatever the provider detected; "und" only when it detected nothing.
    const runLanguage = checkpoints[0]?.language
      ? normalizeLanguageTag(checkpoints[0].language) ?? "und"
      : "und";

    // Write this chunk's source cues at absolute timeline offsets: the chunk was
    // transcribed from zero, so shift by the chunk's start on the media timeline.
    const sourceCues = checkpoints.flatMap((cp) =>
      cp.cues.map((cue) => ({
        idx: cue.idx,
        startMs: Number(chunk.startMs) + cue.startMs,
        endMs: Number(chunk.startMs) + cue.endMs,
        text: cue.text,
      }))
    );
    // Deterministic key: a retry overwrites the same object instead of leaking a second one.
    const partitionKey = `subtitles/v2/${run.fileId}/v${run.sourceVersion}/${run.id}/source/${chunk.ordinal}/v1.json`;
    const partitionData = JSON.stringify({ cues: sourceCues });
    const partitionChecksum = createHash("sha256").update(partitionData).digest("hex");

    await putR2Object(partitionKey, Buffer.from(partitionData), "application/json");

    // Replace this ordinal's source partition row (delete-then-insert keeps retries idempotent)
    await db
      .delete(subtitleCuePartitions)
      .where(and(
        eq(subtitleCuePartitions.runId, run.id),
        eq(subtitleCuePartitions.kind, "source"),
        eq(subtitleCuePartitions.ordinal, chunk.ordinal)
      ));
    await db.insert(subtitleCuePartitions).values({
      runId: run.id,
      targetId: null,
      kind: "source",
      ordinal: chunk.ordinal,
      startMs: Number(chunk.startMs),
      endMs: Number(chunk.endMs),
      firstCueSequence: 0,
      lastCueSequence: Math.max(0, sourceCues.length - 1),
      cueCount: sourceCues.length,
      inputHash: partitionChecksum,
      objectKey: partitionKey,
      checksumSha256: partitionChecksum,
      schemaVersion: 1,
      materializationState: "pending",
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });

    // Create source materialize work item (idempotent — all ASR items race to create the same key)
    const materializeSeeds: WorkSeed[] = [{
      runId: run.id,
      targetId: null,
      userId: run.userId,
      kind: "materialize",
      idempotencyKey: workKey(run, "materialize", undefined, "source"),
      ordinal: null,
      cursorStartMs: null,
      cursorEndMs: null,
    }];
    await store.createWork(materializeSeeds, now);

    const checkpoint = { language: runLanguage, chunks: checkpoints };
    await store.complete(lease, { outcome: "transcribed", checkpoint }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ASR failed";
    await store.retry(lease, { code: "ASR_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 60_000) }, now);
    throw error;
  }
}
