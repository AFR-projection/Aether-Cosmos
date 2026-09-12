import { db } from "@/shared/infrastructure/db";
import { files, subtitleAudioChunks } from "@/shared/infrastructure/db/schema";
import { eq } from "drizzle-orm";
import { buildSubtitleAudioArgs, chunkName, parseSegmentList, AUDIO_CHUNK_ORDINAL_SCALE, type AsrAudioTarget, type AudioSegment } from "@files/domain/services/subtitles/audio-extract";
import { containerExtensionFor, isMissingAudioStreamError } from "@files/domain/services/media-edit";
import { putR2Object } from "@/shared/infrastructure/storage/r2-objects";
import { createHash } from "node:crypto";
import { workKey } from "@files/application/subtitles/pipeline/ledger";
import type { PipelineDependencies } from "./compose";
import type { ClaimedWork, PipelineRun, SubtitlePipelineStore, WorkSeed } from "@files/application/subtitles/pipeline/contracts";

async function fs() {
  return import("fs/promises");
}

interface PrepareCheckpoint {
  readonly ordinal: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly objectKey: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly format: string;
  readonly mimeType: string;
}

export async function handlePrepareStage(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string,
  deps: PipelineDependencies
): Promise<void> {
  if (claimed.cursorStartMs === null || claimed.cursorEndMs === null) {
    throw new Error("Prepare work item missing cursor range");
  }
  if (claimed.ordinal === null) {
    throw new Error("Prepare work item missing ordinal");
  }

  const lease = { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken };

  // Load source file info
  const [file] = await db
    .select({
      id: files.id,
      userId: files.userId,
      r2Key: files.r2Key,
      mimeType: files.mimeType,
      encrypted: files.encrypted,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(eq(files.id, run.fileId))
    .limit(1);

  if (!file || file.deletedAt) {
    await store.complete(lease, { outcome: "file-gone" }, now);
    return;
  }
  if (file.encrypted) {
    await store.complete(lease, { outcome: "encrypted" }, now);
    return;
  }

  // Download source to temp
  const inputExtension = containerExtensionFor(file.mimeType) ?? "bin";
  const tmpIn = deps.tmpPath(`${run.id}-src.${inputExtension}`);
  const nodeFs = await fs();
  const cleanup: string[] = [tmpIn];

  try {
    await deps.downloadToFile(file.r2Key, tmpIn);

    // Try each audio target until one succeeds
    let chosenTarget: AsrAudioTarget | null = null;
    let segments: AudioSegment[] = [];
    let paths: string[] = [];

    for (const target of [
      { encoder: "libopus", encoderArgs: ["-b:a", "24k", "-application", "voip"], extension: ".ogg", mimeType: "audio/ogg" },
      { encoder: "libmp3lame", encoderArgs: ["-q:a", "7"], extension: ".mp3", mimeType: "audio/mpeg" },
      { encoder: "aac", encoderArgs: ["-b:a", "48k"], extension: ".m4a", mimeType: "audio/mp4" },
    ] as AsrAudioTarget[]) {
      const prefix = deps.tmpPath(`${run.id}-chunk-${claimed.ordinal}`);
      const listPath = deps.tmpPath(`${run.id}-chunk-${claimed.ordinal}-segments.csv`);
      cleanup.push(listPath);

      try {
        await deps.runFfmpeg(
          buildSubtitleAudioArgs({
            inputPath: tmpIn,
            outputPattern: `${prefix}-%04d${target.extension}`,
            listPath,
            target,
            chunkSeconds: Math.ceil((claimed.cursorEndMs! - claimed.cursorStartMs!) / 1000),
          })
        );
        const parsed = parseSegmentList(await nodeFs.readFile(listPath, "utf8"));
        if (parsed.length === 0) throw new Error("ffmpeg wrote no segments");

        // Filter to only segments within our cursor range
        const inRange = parsed.filter((seg) =>
          seg.endSeconds * 1000 > claimed.cursorStartMs! &&
          seg.startSeconds * 1000 < claimed.cursorEndMs!
        );

        segments = inRange;
        paths = segments.map((_, index) => chunkName(prefix, index, target.extension));
        cleanup.push(...paths);
        chosenTarget = target;
        break;
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        if (isMissingAudioStreamError(stderr)) {
          await store.complete(lease, { outcome: "no-audio" }, now);
          return;
        }
        deps.log(`prepare ordinal ${claimed.ordinal} target ${target.encoder} failed: ${stderr.slice(0, 200) || (error as Error).message}`);
      }
    }

    if (!chosenTarget || segments.length === 0) {
      await store.complete(lease, { outcome: "no-segments" }, now);
      return;
    }

    // Upload chunks to R2, insert subtitleAudioChunks rows, collect checkpoints.
    // ffmpeg runs over the whole file, so segment times are already absolute on the media
    // timeline — never add the cursor offset again.
    const checkpoints: PrepareCheckpoint[] = [];

    for (let i = 0; i < segments.length; i++) {
      const path = paths[i];
      const segment = segments[i];
      const chunkStartMs = Math.round(segment.startSeconds * 1000);
      const chunkEndMs = Math.min(claimed.cursorEndMs!, Math.round(segment.endSeconds * 1000));
      // Scale per-range so (run, ordinal) stays unique: work ordinal in the high digits,
      // segment index within the range in the low ones.
      const chunkOrdinal = claimed.ordinal! * AUDIO_CHUNK_ORDINAL_SCALE + i;

      const fileBuffer = await nodeFs.readFile(path);
      const checksum = createHash("sha256").update(fileBuffer).digest("hex");
      const objectKey = `subtitles/v2/${run.fileId}/v${run.sourceVersion}/${run.id}/prepare/${claimed.ordinal}/${i}/${checksum}.v1.${chosenTarget.extension.slice(1)}`;

      await putR2Object(objectKey, fileBuffer, chosenTarget.mimeType);

      // Insert audio chunk row for ASR stage to pick up. A retry re-derives the same
      // (ordinal, objectKey) so the conflict path is a no-op, not a duplicate.
      await db.insert(subtitleAudioChunks).values({
        runId: run.id,
        workItemId: claimed.id,
        ordinal: chunkOrdinal,
        startMs: chunkStartMs,
        endMs: chunkEndMs,
        overlapBeforeMs: 0,
        overlapAfterMs: 0,
        objectKey,
        checksumSha256: checksum,
        sizeBytes: fileBuffer.length,
        format: chosenTarget.extension.slice(1),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      }).onConflictDoNothing({ target: subtitleAudioChunks.objectKey });

      checkpoints.push({
        ordinal: chunkOrdinal,
        startMs: chunkStartMs,
        endMs: chunkEndMs,
        objectKey,
        checksumSha256: checksum,
        sizeBytes: fileBuffer.length,
        format: chosenTarget.extension.slice(1),
        mimeType: chosenTarget.mimeType,
      });
    }

    // One ASR item per audio chunk: each chunk is bounded, retries alone, and bills once.
    const asrSeeds: WorkSeed[] = checkpoints.map((checkpoint) => ({
      runId: run.id,
      targetId: null,
      userId: run.userId,
      kind: "asr" as const,
      idempotencyKey: workKey(run, "asr", checkpoint.ordinal),
      ordinal: checkpoint.ordinal,
      cursorStartMs: checkpoint.startMs,
      cursorEndMs: checkpoint.endMs,
    }));
    await store.createWork(asrSeeds, now);

    const checkpoint = { chunks: checkpoints };
    await store.complete(lease, { outcome: "prepared", checkpoint }, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prepare failed";
    await store.retry(lease, { code: "PREPARE_FAILED", message: message.slice(0, 500), availableAt: new Date(now.getTime() + 60_000) }, now);
    throw error;
  } finally {
    for (const path of cleanup) {
      await nodeFs.unlink(path).catch(() => {});
    }
  }
}
