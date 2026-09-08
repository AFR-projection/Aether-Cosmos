// Not "dotenv/config": dotenv is a devDependency and the worker image installs with
// `npm ci --omit=dev`, so that import crashed the container before its first line and
// restart-looped it through an entire deploy. The loader uses dotenv when it is there
// and reads .env itself when it is not — see @/shared/lib/env/load-env.ts.
import "@/shared/lib/env/load-env";
import { Worker } from "bullmq";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHmac } from "crypto";
import os from "os";
import path from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/shared/infrastructure/db/schema";
import {
  archiveJobItems,
  archiveJobs,
  deletionJobItems,
  deletionJobs,
  files,
  folders,
  mediaOperations,
  users,
  webhooks,
} from "@/shared/infrastructure/db/schema";
import { QUEUE_NAME, enqueueJob } from "@/shared/infrastructure/queue";
import {
  createMediaWorkerCore,
  type ExactMediaState,
  type ExtractedAudioInput,
  type InspectionValues,
  type MediaFileState,
  type MediaOperation,
  type MediaWorkerCoreDependencies,
  type TrimMediaInput,
} from "@files/application/jobs/media-worker-core";
import {
  createMediaPublicationCoordinator,
  type MediaPublicationTransaction,
} from "@files/application/jobs/media-publication";
import {
  renderThumbnailSet,
  type ThumbnailRenderDependencies,
} from "@files/application/jobs/thumbnail-renderer";
import { mediaMetadataReset } from "@files/application/jobs/media-inspection";
import {
  AUDIO_EXTRACT_TARGETS,
  buildExtractAudioArgs,
  buildVideoThumbnailArgs,
  buildVideoTrimArgs,
  chooseImageEncoder,
  containerExtensionFor,
  DEFAULT_EDIT_QUALITY,
  extractedAudioName,
  isMissingAudioStreamError,
  type AudioExtractTarget,
} from "@files/domain/services/media-edit";
import { EDIT_INPUT_MAX_PIXELS } from "@files/domain/services/edit-limits";
import { WEBHOOK_USER_AGENT } from "@/shared/infrastructure/webhooks/constants";
import { fetchWebhook } from "@/shared/infrastructure/webhooks/ssrf";
import { runScheduledCleanups } from "./cleanup";
import { enrichBrain, enrichMemory, ENRICH_SWEEP_LIMIT } from "@brain/application/jobs/enrich-service";
import { relateJobId, runRelateBrainJob, runRelateMemoryJob } from "@brain/application/commands/relate-jobs";
import { runEmbedBrainJob, runEmbedMemoryJob } from "@brain/infrastructure/providers/embed-jobs";
import { getEmbeddingProvider } from "@brain/infrastructure/providers/resolve";
import {
  runTranscribeMedia,
  runTranslateSubtitles,
} from "@files/application/subtitles/subtitle-jobs";
import { Queue } from "bullmq";
import { PassThrough, Readable } from "stream";
import { ZipArchive } from "archiver";
import {
  buildR2Key,
  copyR2Object,
  deleteR2Object,
  deleteR2Objects,
  downloadFromR2Stream,
  headObject,
  putR2Object,
  uploadR2Stream,
} from "@files/infrastructure/storage/r2";
import { renderPdfFirstPage } from "@files/infrastructure/storage/pdf-thumbnail";
import {
  buildFfprobeArgs,
  classifyVideoCompatibility,
  detectMp4FaststartFromAtoms,
  parseMediaProbe,
} from "@files/domain/services/media-metadata";

const execFileAsync = promisify(execFile);

const THUMB_SIZES = [150, 300, 600, 1200];

const tmpPath = (name: string) => path.join(os.tmpdir(), name);

function getRedisConnection() {
  if (process.env.REDIS_DISABLED === "true") {
    return null;
  }

  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parseInt(parsed.port || "6379", 10),
    };
  } catch {
    return { host: "localhost", port: 6379 };
  }
}

const redisConnection = getRedisConnection();
if (!redisConnection) {
  console.log("Worker skipped: REDIS_DISABLED=true");
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const postgresClient = postgres(connectionString, { max: 5 });
const db = drizzle(postgresClient, { schema });

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function downloadFromR2(key: string): Promise<Buffer> {
  const client = getR2Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key })
  );
  return Buffer.from(await response.Body!.transformToByteArray());
}

/**
 * Copy an R2 object onto local disk without buffering it in the process.
 *
 * `downloadFromR2` reads the whole object into memory, which is fine for an image and not
 * fine for a video — a job that streams to a temporary file costs disk instead of heap,
 * and ffmpeg wants a seekable file anyway.
 */
async function downloadR2ToFile(key: string, destination: string): Promise<void> {
  const object = await downloadFromR2Stream(key);
  if (!object.body) throw new Error(`Source object is empty: ${key}`);
  const body = object.body as unknown;
  const source =
    typeof (body as { pipe?: unknown }).pipe === "function"
      ? (body as Readable)
      : Readable.fromWeb(body as import("stream/web").ReadableStream);
  const { createWriteStream } = await import("fs");
  const { pipeline } = await import("stream/promises");
  await pipeline(source, createWriteStream(destination));
}

async function uploadToR2(key: string, body: Buffer, contentType: string) {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

async function generateImageThumbnails(fileId: string, buffer: Buffer): Promise<boolean> {
  const sizes = [150, 300, 600, 1200];
  const uploads: Promise<void>[] = [];

  for (const size of sizes) {
    const key = `thumbnails/${fileId}_${size}.webp`;
    const pipeline = sharp(buffer)
      .resize(size, size, {
        fit: "cover",
        position: "centre",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 });

    const thumbBuffer = await pipeline.toBuffer();
    uploads.push(uploadToR2(key, thumbBuffer, "image/webp"));
  }

  await Promise.all(uploads);
  return true;
}

async function generateVideoThumbnail(fileId: string, r2Key: string): Promise<boolean> {
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${fileId}-input`);
  const tmpFrame = tmpPath(`${fileId}-thumb-frame.png`);
  await downloadR2ToFile(r2Key, tmpIn);

  try {
    // Decode one frame once. Sharp performs the four cheap image resizes; starting ffmpeg four
    // times made every thumbnail job seek and decode the same video four times.
    await execFileAsync("ffmpeg", buildVideoThumbnailArgs(tmpIn, tmpFrame));
    const frame = await fs.readFile(tmpFrame);
    await Promise.all(
      THUMB_SIZES.map(async (size) => {
        const webp = await sharp(frame)
          .resize(size, size, {
            fit: "contain",
            background: { r: 15, g: 23, b: 42, alpha: 1 },
            withoutEnlargement: true,
          })
          .webp({ quality: 80, effort: 4 })
          .toBuffer();
        await uploadToR2(`thumbnails/${fileId}_${size}.webp`, webp, "image/webp");
      })
    );
    return true;
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpFrame).catch(() => {});
  }
}

async function generatePdfThumbnail(fileId: string, r2Key: string): Promise<boolean> {
  const buffer = await downloadFromR2(r2Key);
  const firstPage = await renderPdfFirstPage(buffer);

  for (const size of THUMB_SIZES) {
    const thumbnail = await sharp(firstPage)
      .resize(size, size, {
        fit: "inside",
        withoutEnlargement: true,
        background: "#ffffff",
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    await uploadToR2(`thumbnails/${fileId}_${size}.webp`, thumbnail, "image/webp");
  }

  return true;
}

async function generateAudioThumbnail(fileId: string, r2Key: string): Promise<boolean> {
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${fileId}-input`);
  const tmpOut = tmpPath(`${fileId}-cover.jpg`);
  await downloadR2ToFile(r2Key, tmpIn);

  try {
    // Try to extract embedded album art
    await execFileAsync("ffmpeg", [
      "-i", tmpIn,
      "-vframes", "1",
      "-an",
      "-y", tmpOut,
    ]);
    const coverBuffer = await fs.readFile(tmpOut);

    for (const size of THUMB_SIZES) {
      const webpBuffer = await sharp(coverBuffer)
        .resize(size, size, { fit: "cover", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      await uploadToR2(`thumbnails/${fileId}_${size}.webp`, webpBuffer, "image/webp");
    }
  } catch {
    // No embedded cover art, generate waveform-style placeholder
    const placeholderSize = 600;
    const svg = `<svg width="${placeholderSize}" height="${placeholderSize}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#10b981"/>
          <stop offset="100%" stop-color="#06b6d4"/>
        </linearGradient>
      </defs>
      <rect width="${placeholderSize}" height="${placeholderSize}" fill="#0f172a"/>
      <rect x="0" y="${placeholderSize - 80}" width="${placeholderSize}" height="80" fill="url(#g)" opacity="0.15"/>
      <g transform="translate(${placeholderSize / 2 - 60}, ${placeholderSize / 2 - 40})">
        <path d="M30 20v40M42 12v56M54 28v24M66 8v64M78 20v40M90 16v48M102 24v32M114 12v56" stroke="url(#g)" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
      </g>
      <circle cx="${placeholderSize / 2}" cy="${placeholderSize / 2 + 60}" r="20" fill="url(#g)" opacity="0.6"/>
      <polygon points="${placeholderSize / 2 - 6},${placeholderSize / 2 + 52} ${placeholderSize / 2 - 6},${placeholderSize / 2 + 68} ${placeholderSize / 2 + 10},${placeholderSize / 2 + 60}" fill="white" opacity="0.9"/>
    </svg>`;

    for (const size of THUMB_SIZES) {
      const webpBuffer = await sharp(Buffer.from(svg))
        .resize(size, size)
        .webp({ quality: 80 })
        .toBuffer();
      await uploadToR2(`thumbnails/${fileId}_${size}.webp`, webpBuffer, "image/webp");
    }
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
  return true;
}

async function inspectMediaLegacy(
  fileId: string,
  r2Key: string,
  mimeType: string,
  expectedVersion: number
): Promise<void> {
  const [file] = await db
    .select({
      id: files.id,
      r2Key: files.r2Key,
      mimeType: files.mimeType,
      encrypted: files.encrypted,
      isNote: files.isNote,
      status: files.status,
      version: files.version,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);

  // A delayed job must never probe bytes from a replaced version or persist stale metadata.
  if (
    !file ||
    file.r2Key !== r2Key ||
    file.mimeType !== mimeType ||
    file.version !== expectedVersion ||
    file.encrypted ||
    file.isNote ||
    file.status !== "ready" ||
    (!mimeType.startsWith("video/") && !mimeType.startsWith("audio/"))
  ) return;

  const fs = await import("fs/promises");
  const extension = containerExtensionFor(mimeType) ?? "bin";
  const tmpIn = tmpPath(`${fileId}-probe-v${expectedVersion}.${extension}`);
  try {
    await downloadR2ToFile(r2Key, tmpIn);
    const { stdout } = await execFileAsync("ffprobe", buildFfprobeArgs(tmpIn), {
      maxBuffer: 4 * 1024 * 1024,
    });
    const metadata = parseMediaProbe(JSON.parse(stdout));
    if (metadata.container === "mp4") {
      // Atom headers are tiny. Reading a bounded prefix detects normal faststart files while
      // returning null for a moov atom outside the window instead of guessing.
      const handle = await fs.open(tmpIn, "r");
      try {
        const prefix = Buffer.alloc(8 * 1024 * 1024);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        metadata.faststart = detectMp4FaststartFromAtoms(prefix.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    }
    const compatibility = metadata.videoCodec
      ? classifyVideoCompatibility(metadata)
      : { compatible: true, reason: null };

    await db
      .update(files)
      .set({
        mediaDurationMs: metadata.durationMs,
        mediaWidth: metadata.width,
        mediaHeight: metadata.height,
        mediaFps: metadata.fps,
        mediaVideoCodec: metadata.videoCodec,
        mediaAudioCodec: metadata.audioCodec,
        mediaBitrateBps: metadata.bitrateBps,
        mediaContainer: metadata.container,
        mediaFaststart: metadata.faststart,
        mediaCompatible: compatibility.compatible,
        mediaCompatibilityReason: compatibility.reason,
        mediaInspectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(files.id, fileId),
          eq(files.r2Key, r2Key),
          eq(files.version, expectedVersion)
        )
      );
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
  }
}

async function generateThumbnailLegacy(fileId: string, r2Key: string, mimeType: string) {
  if (r2Key.startsWith("notes/")) return;

  const thumbKey = `thumbnails/${fileId}_300.webp`;
  let generated = false;

  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
    const buffer = await downloadFromR2(r2Key);
    generated = await generateImageThumbnails(fileId, buffer);
  } else if (mimeType.startsWith("video/")) {
    generated = await generateVideoThumbnail(fileId, r2Key);
  } else if (mimeType === "application/pdf") {
    generated = await generatePdfThumbnail(fileId, r2Key);
  } else if (mimeType.startsWith("audio/")) {
    generated = await generateAudioThumbnail(fileId, r2Key);
  } else {
    return;
  }

  // Only persist thumbnailKey when the 300px thumbnail actually exists,
  // otherwise the UI would render a broken image for a dangling key.
  if (generated) {
    await db.update(files).set({ thumbnailKey: thumbKey }).where(eq(files.id, fileId));
  }
}

/**
 * Re-compress an image in place, keeping its own format.
 *
 * Nothing enqueues this today — the edit route compresses inline so it can report the
 * result — but it stays honest about format: writing JPEG bytes under a `.png` name
 * breaks every later read of the file.
 */
async function compressImage(fileId: string, r2Key: string, mimeType: string) {
  const buffer = await downloadFromR2(r2Key);
  const encoder = chooseImageEncoder(mimeType);
  const pipeline = sharp(buffer, { limitInputPixels: EDIT_INPUT_MAX_PIXELS });
  const output = await (encoder.format === "png"
    ? pipeline.png({ compressionLevel: 9, palette: true, quality: DEFAULT_EDIT_QUALITY })
    : encoder.format === "webp"
      ? pipeline.webp({ quality: DEFAULT_EDIT_QUALITY })
      : encoder.format === "avif"
        ? pipeline.avif({ quality: DEFAULT_EDIT_QUALITY })
        : pipeline.jpeg({ quality: DEFAULT_EDIT_QUALITY, mozjpeg: true })
  ).toBuffer();

  await uploadToR2(r2Key, output, encoder.mimeType);
  const [row] = await db
    .update(files)
    .set({ sizeBytes: output.length, updatedAt: new Date() })
    .where(eq(files.id, fileId))
    .returning({ userId: files.userId });
  if (row) await recomputeUsedBytes(row.userId);
}

/**
 * Recompute an account's stored bytes from the rows that actually count.
 *
 * Anything that rewrites an object in place changes the number the quota is read from,
 * and a `sizeBytes` update on its own leaves `users.usedBytes` drifting.
 */
async function recomputeUsedBytes(userId: string) {
  const [usage] = await db
    .select({ total: drizzleSql<number>`COALESCE(SUM(${files.sizeBytes}), 0)` })
    .from(files)
    .where(
      and(
        eq(files.userId, userId),
        drizzleSql`deleted_at IS NULL`,
        inArray(files.status, ["ready", "legacy_unverified"])
      )
    );
  await db
    .update(users)
    .set({ usedBytes: Number(usage?.total ?? 0), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Cut a clip down to a single window, in place.
 *
 * `PUT /api/files/edit` has already checked the window and taken a version snapshot,
 * which is the only way back from here. The container is preserved because the streams
 * are copied rather than re-encoded — see `buildTrimArgs` for why that is worth the
 * keyframe granularity, and `containerExtensionFor` for why the extension matters:
 * the output extension is what picks the muxer, and Matroska packets do not go into
 * an `.mp4`.
 */
async function trimMediaLegacy(
  fileId: string,
  r2Key: string,
  mimeType: string,
  expectedVersion: number,
  startSeconds: number,
  endSeconds: number
) {
  const extension = containerExtensionFor(mimeType);
  // The route refuses these, so a job carrying one is stale. Doing nothing is better
  // than remuxing into a container that cannot hold the streams.
  if (!extension) return;

  const buffer = await downloadFromR2(r2Key);
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${fileId}-trim-in.${extension}`);
  const tmpOut = tmpPath(`${fileId}-trim-out.${extension}`);
  await fs.writeFile(tmpIn, buffer);

  try {
    await execFileAsync(
      "ffmpeg",
      buildVideoTrimArgs({
        inputPath: tmpIn,
        outputPath: tmpOut,
        startSeconds,
        endSeconds,
        mimeType,
      })
    );
    const output = await fs.readFile(tmpOut);
    // A seek past the last keyframe can produce a valid, empty container. Writing that
    // back would replace the caller's clip with nothing.
    if (output.length === 0) throw new Error("ffmpeg produced an empty file");

    await uploadToR2(r2Key, output, mimeType);
    const [row] = await db
      .update(files)
      .set({ sizeBytes: output.length, updatedAt: new Date() })
      .where(
        and(
          eq(files.id, fileId),
          eq(files.r2Key, r2Key),
          eq(files.version, expectedVersion)
        )
      )
      .returning({ userId: files.userId });
    if (!row) return;
    await recomputeUsedBytes(row.userId);

    // The poster frame was taken from a part of the clip that may no longer exist.
    await generateThumbnailLegacy(fileId, r2Key, mimeType);
    await inspectMediaLegacy(fileId, r2Key, mimeType, expectedVersion);
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

/**
 * Pull the audio track out of a video into a NEW file next to it.
 *
 * The row is inserted only once ffmpeg has produced bytes, so a failed extraction leaves
 * nothing behind to explain — unlike a trim, which edits a file that already exists, this
 * job's whole output is the file, and a half-created one would show up in the folder as a
 * broken entry the user cannot do anything with.
 *
 * The audio is re-encoded rather than copied out of the container (see
 * `AUDIO_EXTRACT_TARGETS`), so the result plays in the browser whatever the video held.
 */
async function extractAudioLegacy(data: {
  fileId: string;
  r2Key: string;
  mimeType: string;
  userId: string;
  folderId: string | null;
  name: string;
}): Promise<void> {
  // The route refuses everything else, so a job carrying another type is stale.
  if (!data.mimeType.startsWith("video/")) return;

  const fs = await import("fs/promises");
  // The extension only helps ffmpeg's probe; it demuxes by content, so an unmapped
  // container is still readable.
  const tmpIn = tmpPath(`${data.fileId}-audio-in.${containerExtensionFor(data.mimeType) ?? "bin"}`);
  const candidates = AUDIO_EXTRACT_TARGETS.map((target) => ({
    target,
    path: tmpPath(`${data.fileId}-audio-out${target.extension}`),
  }));

  try {
    await downloadR2ToFile(data.r2Key, tmpIn);

    let produced: { target: AudioExtractTarget; body: Buffer } | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        await execFileAsync(
          "ffmpeg",
          buildExtractAudioArgs({
            inputPath: tmpIn,
            outputPath: candidate.path,
            target: candidate.target,
          })
        );
        const body = await fs.readFile(candidate.path);
        // An encoder that writes a header and nothing else would otherwise become a
        // zero-length file in the user's folder.
        if (body.length === 0) throw new Error("ffmpeg produced an empty file");
        produced = { target: candidate.target, body };
        break;
      } catch (error) {
        lastError = error;
        // "This video has no audio" is a fact about the file: the next encoder fails the
        // same way and so would a retry, so stop without leaving a failed job behind.
        if (isMissingAudioStreamError(String((error as { stderr?: unknown }).stderr ?? ""))) {
          console.log(`extract_audio ${data.fileId}: no audio track, nothing to extract`);
          return;
        }
      }
    }
    if (!produced) {
      throw lastError instanceof Error ? lastError : new Error("Audio extraction failed");
    }

    // The route checked there was headroom before queueing; this is the check against the
    // size that actually came out. Skipped rather than thrown: a retry cannot make the
    // account bigger.
    const [owner] = await db
      .select({
        quotaBytes: users.quotaBytes,
        usedBytes: users.usedBytes,
        reservedBytes: users.reservedBytes,
      })
      .from(users)
      .where(eq(users.id, data.userId))
      .limit(1);
    if (!owner) return;
    if (owner.usedBytes + owner.reservedBytes + produced.body.length > owner.quotaBytes) {
      console.log(`extract_audio ${data.fileId}: skipped, the extracted audio is over quota`);
      return;
    }

    const name = extractedAudioName(data.name, produced.target.extension);
    const now = new Date();
    const [created] = await db
      .insert(files)
      .values({
        // Filed under the video's OWNER rather than whoever pressed the button: a shared
        // video's audio belongs in the same account as the video, or it would count
        // against the wrong quota and disappear from the folder it was made in.
        userId: data.userId,
        folderId: data.folderId,
        name,
        mimeType: produced.target.mimeType,
        sizeBytes: produced.body.length,
        r2Key: "pending",
        isNote: false,
      })
      .returning();

    const key = buildR2Key(data.userId, created.id, name);
    await uploadToR2(key, produced.body, produced.target.mimeType);
    await db
      .update(files)
      .set({ r2Key: key, status: "ready", completedAt: now, verifiedAt: now, updatedAt: now })
      .where(eq(files.id, created.id));
    await recomputeUsedBytes(data.userId);
    // Album art if the video carried any, a waveform placeholder otherwise.
    await generateThumbnailLegacy(created.id, key, produced.target.mimeType);
    await inspectMediaLegacy(created.id, key, produced.target.mimeType, created.version);
    console.log(`extract_audio ${data.fileId}: wrote ${name} (${produced.body.length} bytes)`);
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    for (const candidate of candidates) {
      await fs.unlink(candidate.path).catch(() => {});
    }
  }
}

async function transformTrim(input: TrimMediaInput) {
  const extension = containerExtensionFor(input.mimeType);
  if (!extension) throw new Error("Unsupported trim container");
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${input.operationId}-trim-in.${extension}`);
  const tmpOut = tmpPath(`${input.operationId}-trim-out.${extension}`);
  try {
    await downloadR2ToFile(input.r2Key, tmpIn);
    await execFileAsync(
      "ffmpeg",
      buildVideoTrimArgs({
        inputPath: tmpIn,
        outputPath: tmpOut,
        startSeconds: input.startSeconds,
        endSeconds: input.endSeconds,
        mimeType: input.mimeType,
      }),
    );
    const body = await fs.readFile(tmpOut);
    return { body, sizeBytes: body.length };
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

async function transformAudio(input: ExtractedAudioInput) {
  const fs = await import("fs/promises");
  const extension = containerExtensionFor(input.mimeType) ?? "bin";
  const tmpIn = tmpPath(`${input.operationId}-audio-in.${extension}`);
  const candidates = AUDIO_EXTRACT_TARGETS.map((target) => ({
    target,
    path: tmpPath(`${input.operationId}-audio-out${target.extension}`),
  }));
  try {
    await downloadR2ToFile(input.r2Key, tmpIn);
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        await execFileAsync(
          "ffmpeg",
          buildExtractAudioArgs({
            inputPath: tmpIn,
            outputPath: candidate.path,
            target: candidate.target,
          }),
        );
        const body = await fs.readFile(candidate.path);
        return {
          body,
          sizeBytes: body.length,
          mimeType: candidate.target.mimeType,
          extension: candidate.target.extension,
        };
      } catch (error) {
        lastError = error;
        if (isMissingAudioStreamError(String((error as { stderr?: unknown }).stderr ?? ""))) {
          throw new Error("Video has no audio track");
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Audio extraction failed");
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await Promise.all(candidates.map((candidate) => fs.unlink(candidate.path).catch(() => {})));
  }
}

async function inspectExactMedia(input: ExactMediaState): Promise<InspectionValues> {
  const fs = await import("fs/promises");
  const extension = containerExtensionFor(input.mimeType) ?? "bin";
  const tmpIn = tmpPath(`${input.fileId}-probe-v${input.version}.${extension}`);
  try {
    await downloadR2ToFile(input.r2Key, tmpIn);
    const { stdout } = await execFileAsync("ffprobe", buildFfprobeArgs(tmpIn), {
      maxBuffer: 4 * 1024 * 1024,
    });
    const metadata = parseMediaProbe(JSON.parse(stdout));
    if (metadata.container === "mp4") {
      const handle = await fs.open(tmpIn, "r");
      try {
        const prefix = Buffer.alloc(8 * 1024 * 1024);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        metadata.faststart = detectMp4FaststartFromAtoms(prefix.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    }
    const compatibility = metadata.videoCodec
      ? classifyVideoCompatibility(metadata)
      : { compatible: true, reason: null };
    return {
      mediaDurationMs: metadata.durationMs,
      mediaWidth: metadata.width,
      mediaHeight: metadata.height,
      mediaFps: metadata.fps,
      mediaVideoCodec: metadata.videoCodec,
      mediaAudioCodec: metadata.audioCodec,
      mediaBitrateBps: metadata.bitrateBps,
      mediaContainer: metadata.container,
      mediaFaststart: metadata.faststart,
      mediaCompatible: compatibility.compatible,
      mediaCompatibilityReason: compatibility.reason,
    };
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
  }
}

const thumbnailRenderDependencies: ThumbnailRenderDependencies = {
  loadBytes: (input) => downloadFromR2(input.r2Key),
  async extractVideoFrame(input) {
    const fs = await import("fs/promises");
    const tmpIn = tmpPath(`${input.fileId}-thumb-v${input.version}-input`);
    const tmpFrame = tmpPath(`${input.fileId}-thumb-v${input.version}-frame.png`);
    try {
      await downloadR2ToFile(input.r2Key, tmpIn);
      await execFileAsync("ffmpeg", buildVideoThumbnailArgs(tmpIn, tmpFrame));
      return await fs.readFile(tmpFrame);
    } finally {
      await fs.unlink(tmpIn).catch(() => {});
      await fs.unlink(tmpFrame).catch(() => {});
    }
  },
  async extractAudioCover(input) {
    const fs = await import("fs/promises");
    const tmpIn = tmpPath(`${input.fileId}-audio-thumb-v${input.version}-input`);
    const tmpCover = tmpPath(`${input.fileId}-audio-thumb-v${input.version}-cover.jpg`);
    try {
      await downloadR2ToFile(input.r2Key, tmpIn);
      try {
        await execFileAsync("ffmpeg", [
          "-i", tmpIn,
          "-vframes", "1",
          "-an",
          "-y", tmpCover,
        ]);
        return await fs.readFile(tmpCover);
      } catch {
        return null;
      }
    } finally {
      await fs.unlink(tmpIn).catch(() => {});
      await fs.unlink(tmpCover).catch(() => {});
    }
  },
  async renderPdf(input) {
    return renderPdfFirstPage(await downloadFromR2(input.r2Key));
  },
  async resizeWebp(source, size, fit) {
    return sharp(source)
      .resize(size, size, {
        fit,
        background: { r: 15, g: 23, b: 42, alpha: 1 },
        withoutEnlargement: true,
      })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
  },
};

async function renderExactThumbnails(input: ExactMediaState) {
  return renderThumbnailSet(input, thumbnailRenderDependencies);
}

function toMediaFileState(row: typeof files.$inferSelect): MediaFileState {
  return {
    id: row.id,
    userId: row.userId,
    folderId: row.folderId,
    name: row.name,
    r2Key: row.r2Key,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    version: row.version,
    encrypted: row.encrypted,
    isNote: row.isNote,
    status: row.status,
    deletedAt: row.deletedAt,
    restoreBatchId: row.restoreBatchId,
  };
}

function toMediaOperation(row: typeof mediaOperations.$inferSelect): MediaOperation {
  return {
    id: row.id,
    kind: row.kind,
    sourceFileId: row.sourceFileId,
    sourceR2Key: row.sourceR2Key,
    sourceMimeType: row.sourceMimeType,
    sourceVersion: row.sourceVersion,
    outputFileId: row.outputFileId,
    stagingKey: row.stagingKey,
    status: row.status,
    outputSizeBytes: row.outputSizeBytes === null ? null : Number(row.outputSizeBytes),
    outputMimeType: row.outputMimeType,
    outputName: row.outputName,
  };
}

const exactFilePredicate = (input: ExactMediaState) => and(
  eq(files.id, input.fileId),
  eq(files.r2Key, input.r2Key),
  eq(files.mimeType, input.mimeType),
  eq(files.version, input.version),
  eq(files.encrypted, false),
  eq(files.isNote, false),
  eq(files.status, "ready"),
  drizzleSql`${files.deletedAt} IS NULL`,
  drizzleSql`${files.restoreBatchId} IS NULL`,
);

function createPublicationTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): MediaPublicationTransaction {
  return {
    async lockOperation(operationId) {
      const [row] = await tx
        .select()
        .from(mediaOperations)
        .where(eq(mediaOperations.id, operationId))
        .limit(1)
        .for("update");
      return row ? toMediaOperation(row) : null;
    },
    async lockExactFile(expected) {
      const [row] = await tx
        .select()
        .from(files)
        .where(exactFilePredicate(expected))
        .limit(1)
        .for("update");
      return row ? toMediaFileState(row) : null;
    },
    async loadFile(fileId) {
      const [row] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1);
      return row ? toMediaFileState(row) : null;
    },
    async lockOwner(userId) {
      const [row] = await tx
        .select({
          quotaBytes: users.quotaBytes,
          usedBytes: users.usedBytes,
          reservedBytes: users.reservedBytes,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async setOperationStatus(operationId, status) {
      await tx
        .update(mediaOperations)
        .set({ status, updatedAt: new Date() })
        .where(eq(mediaOperations.id, operationId));
    },
    async updateTrimFile(input) {
      const rows = await tx
        .update(files)
        .set({ sizeBytes: input.sizeBytes, ...mediaMetadataReset(), updatedAt: new Date() })
        .where(exactFilePredicate(input))
        .returning({ id: files.id });
      return rows.length === 1;
    },
    async insertExtractedOutput(input) {
      const [row] = await tx
        .insert(files)
        .values({
          id: input.outputFileId,
          userId: input.userId,
          folderId: input.folderId,
          name: input.outputName,
          mimeType: input.outputMimeType,
          sizeBytes: input.sizeBytes,
          r2Key: input.outputKey,
          status: "created",
          isNote: false,
        })
        .onConflictDoNothing({ target: files.id })
        .returning();
      return row ? toMediaFileState(row) : null;
    },
    async finalizeExtractedOutput(input) {
      const now = new Date();
      const [row] = await tx
        .update(files)
        .set({
          name: input.outputName,
          mimeType: input.outputMimeType,
          sizeBytes: input.sizeBytes,
          r2Key: input.outputKey,
          status: "ready",
          completedAt: now,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(files.id, input.outputFileId),
            eq(files.userId, input.userId),
            eq(files.r2Key, input.outputKey),
            eq(files.status, "created"),
          ),
        )
        .returning();
      return row ? toMediaFileState(row) : null;
    },
  };
}

const mediaPublicationCoordinator = createMediaPublicationCoordinator({
  transaction: (work) => db.transaction((tx) => work(createPublicationTransaction(tx))),
});

const mediaWorkerDependencies: MediaWorkerCoreDependencies = {
  async loadFile(fileId) {
    const [row] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return row ? toMediaFileState(row) : null;
  },
  async ensureOperation(seed) {
    await db.insert(mediaOperations).values(seed).onConflictDoNothing({ target: mediaOperations.id });
    const [row] = await db.select().from(mediaOperations).where(eq(mediaOperations.id, seed.id)).limit(1);
    if (!row) throw new Error("Media operation could not be loaded");
    return toMediaOperation(row);
  },
  async markOperationStaged(operationId, output) {
    const [row] = await db
      .update(mediaOperations)
      .set({
        stagingKey: output.stagingKey,
        outputSizeBytes: output.sizeBytes,
        outputMimeType: output.mimeType,
        outputName: output.name ?? null,
        status: "staged",
        updatedAt: new Date(),
      })
      .where(and(eq(mediaOperations.id, operationId), eq(mediaOperations.status, "queued")))
      .returning();
    if (row) return toMediaOperation(row);
    const [existing] = await db.select().from(mediaOperations).where(eq(mediaOperations.id, operationId)).limit(1);
    if (!existing) throw new Error("Media operation disappeared while staging");
    return toMediaOperation(existing);
  },
  async markOperationTerminal(operationId, status) {
    await db.update(mediaOperations).set({ status, updatedAt: new Date() }).where(eq(mediaOperations.id, operationId));
  },
  transformTrim,
  transformAudio,
  inspect: inspectExactMedia,
  renderThumbnails: renderExactThumbnails,
  putObject: putR2Object,
  copyObject: copyR2Object,
  deleteObjects: deleteR2Objects,
  async persistInspection(expected, values) {
    const rows = await db
      .update(files)
      .set({ ...values, mediaInspectedAt: new Date(), updatedAt: new Date() })
      .where(exactFilePredicate(expected))
      .returning({ id: files.id });
    return rows.length === 1;
  },
  repairStorageAccounting: recomputeUsedBytes,
  async publishThumbnails(expected, thumbnailKey, publish) {
    const [claimed] = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: files.id })
        .from(files)
        .where(exactFilePredicate(expected))
        .limit(1)
        .for("update");
      if (!rows[0]) return [];
      await publish();
      return tx
        .update(files)
        .set({ thumbnailKey, updatedAt: new Date() })
        .where(exactFilePredicate(expected))
        .returning({ id: files.id });
    });
    return !!claimed;
  },
  async publishTrim(input, publish) {
    const outcome = await mediaPublicationCoordinator.publishTrim(input, publish);
    if (outcome === "completed") {
      const [source] = await db
        .select({ userId: files.userId })
        .from(files)
        .where(eq(files.id, input.fileId))
        .limit(1);
      if (source) await recomputeUsedBytes(source.userId);
    }
    return outcome;
  },
  async publishExtractedAudio(input, publish) {
    const publication = await mediaPublicationCoordinator.publishExtractedAudio(input, publish);
    if (publication.outcome === "completed") await recomputeUsedBytes(input.userId);
    return publication;
  },
  enqueue: (type, data, jobId) => enqueueJob(type, data, { jobId }),
  buildOutputKey: buildR2Key,
};

const mediaWorker = createMediaWorkerCore(mediaWorkerDependencies);

async function deliverWebhook(data: {
  webhookId: string;
  url: string;
  secret: string;
  body: string;
}) {
  const signature = createHmac("sha256", data.secret).update(data.body).digest("hex");
  // Re-validated at send time (and on every redirect hop): the row may predate
  // the current SSRF policy, and DNS can move under a URL after creation.
  const res = await fetchWebhook(data.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": `sha256=${signature}`,
      "User-Agent": WEBHOOK_USER_AGENT,
    },
    body: data.body,
    signal: AbortSignal.timeout(15_000),
  });

  await db
    .update(webhooks)
    .set({
      lastDeliveryAt: new Date(),
      lastStatus: res.status,
    })
    .where(eq(webhooks.id, data.webhookId));

  if (!res.ok) {
    throw new Error(`Webhook delivery failed: HTTP ${res.status}`);
  }
}

function waitForReadableEnd(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

/** Build a folder archive as a streaming R2 object. No complete archive or
 * source file is buffered in the worker process. */
async function buildArchive(archiveJobId: string): Promise<void> {
  const [claimed] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(archiveJobs)
      .set({
        status: "processing",
        startedAt: new Date(),
        processedFiles: 0,
        processedBytes: 0,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(archiveJobs.id, archiveJobId),
        inArray(archiveJobs.status, ["created", "failed"])
      ))
      .returning();

    if (rows.length === 0) return [];
    await tx
      .update(archiveJobItems)
      .set({ status: "pending", lastError: null, updatedAt: new Date() })
      .where(eq(archiveJobItems.archiveJobId, archiveJobId));
    return rows;
  });

  if (!claimed) return;

  try {
    await deleteR2Object(claimed.objectKey);
    const items = await db
      .select()
      .from(archiveJobItems)
      .where(eq(archiveJobItems.archiveJobId, archiveJobId));
    if (items.length === 0) throw new Error("Archive contains no files");

    const output = new PassThrough();
    const archive = new ZipArchive({ zlib: { level: 1 } });
    let archiveError: Error | null = null;
    archive.on("error", (error: Error) => {
      archiveError = error;
      output.destroy(error);
    });
    archive.pipe(output);

    const uploadPromise = uploadR2Stream(claimed.objectKey, output, "application/zip");

    for (const item of items) {
      await db.update(archiveJobItems).set({ status: "processing", updatedAt: new Date() })
        .where(eq(archiveJobItems.id, item.id));

      const object = await downloadFromR2Stream(item.objectKey);
      if (!object.body) throw new Error(`Source object is empty: ${item.objectKey}`);
      if (object.contentLength !== undefined && object.contentLength !== item.sizeBytes) {
        throw new Error(`Source object size mismatch: ${item.objectKey}`);
      }

      const body = object.body as unknown;
      const source = typeof (body as { pipe?: unknown }).pipe === "function"
        ? body as Readable
        : Readable.fromWeb(body as import("stream/web").ReadableStream);
      const sourceEnd = waitForReadableEnd(source);
      archive.append(source, { name: item.archivePath });
      await sourceEnd;
      if (archiveError) throw archiveError;

      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(archiveJobItems).set({ status: "completed", updatedAt: now })
          .where(eq(archiveJobItems.id, item.id));
        await tx.update(archiveJobs).set({
          processedFiles: drizzleSql`processed_files + 1`,
          processedBytes: drizzleSql`processed_bytes + ${item.sizeBytes}`,
          updatedAt: now,
        }).where(and(eq(archiveJobs.id, archiveJobId), eq(archiveJobs.status, "processing")));
      });
    }

    await archive.finalize();
    await uploadPromise;
    const archivedObject = await headObject(claimed.objectKey);
    if (archivedObject.contentLength <= 0) throw new Error("Generated archive is empty");

    const completedAt = new Date();
    await db.update(archiveJobs).set({
      status: "ready",
      processedFiles: claimed.totalFiles,
      processedBytes: claimed.totalBytes,
      completedAt,
      errorCode: null,
      errorMessage: null,
      updatedAt: completedAt,
    }).where(and(eq(archiveJobs.id, archiveJobId), eq(archiveJobs.status, "processing")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Archive build failed";
    await db.update(archiveJobs).set({
      status: "failed",
      errorCode: "ARCHIVE_BUILD_FAILED",
      errorMessage: message.slice(0, 1000),
      updatedAt: new Date(),
    }).where(and(eq(archiveJobs.id, archiveJobId), eq(archiveJobs.status, "processing")));
    await db.update(archiveJobItems).set({ status: "failed", lastError: message.slice(0, 1000), updatedAt: new Date() })
      .where(and(eq(archiveJobItems.archiveJobId, archiveJobId), eq(archiveJobItems.status, "processing")));
    throw error;
  }
}

/** Delete a large folder in bounded R2 batches, then remove its metadata. */
async function processDeletion(deletionJobId: string): Promise<void> {
  const [claimed] = await db.transaction(async (tx) => {
    const rows = await tx.update(deletionJobs).set({
      status: "processing",
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    }).where(and(
      eq(deletionJobs.id, deletionJobId),
      inArray(deletionJobs.status, ["created", "failed"])
    )).returning();
    if (rows.length === 0) return [];
    await tx.update(deletionJobItems).set({ status: "pending", lastError: null, updatedAt: new Date() })
      .where(eq(deletionJobItems.deletionJobId, deletionJobId));
    return rows;
  });
  if (!claimed) return;

  try {
    const items = await db.select().from(deletionJobItems)
      .where(eq(deletionJobItems.deletionJobId, deletionJobId));

    for (let offset = 0; offset < items.length; offset += 100) {
      const batch = items.slice(offset, offset + 100);
      await db.update(deletionJobItems).set({ status: "processing", updatedAt: new Date() })
        .where(inArray(deletionJobItems.id, batch.map((item) => item.id)));

      const keys = batch.flatMap((item) => [item.objectKey, item.thumbnailKey ?? ""]);
      await deleteR2Objects(keys);

      const fileIds = batch.map((item) => item.fileId).filter((id): id is string => !!id);
      await db.transaction(async (tx) => {
        if (fileIds.length > 0) await tx.delete(files).where(inArray(files.id, fileIds));
        await tx.update(deletionJobItems).set({ status: "completed", updatedAt: new Date() })
          .where(inArray(deletionJobItems.id, batch.map((item) => item.id)));
        await tx.update(deletionJobs).set({
          processedItems: drizzleSql`processed_items + ${batch.length}`,
          updatedAt: new Date(),
        }).where(and(eq(deletionJobs.id, deletionJobId), eq(deletionJobs.status, "processing")));
      });
    }

    const folder = claimed.folderId
      ? (await db.select().from(folders).where(eq(folders.id, claimed.folderId)).limit(1))[0]
      : null;
    if (folder) {
      const prefix = `${folder.materializedPath.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      await db.execute(drizzleSql`
        DELETE FROM ${folders}
        WHERE user_id = ${claimed.userId}
          AND materialized_path LIKE ${prefix} ESCAPE '\\'
      `);
    }

    await recomputeUsedBytes(claimed.userId);

    await db.update(deletionJobs).set({
      status: "completed",
      processedItems: claimed.totalItems,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(deletionJobs.id, deletionJobId), eq(deletionJobs.status, "processing")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deletion failed";
    await db.update(deletionJobs).set({
      status: "failed",
      errorCode: "DELETE_BATCH_FAILED",
      errorMessage: message.slice(0, 1000),
      updatedAt: new Date(),
    }).where(and(eq(deletionJobs.id, deletionJobId), eq(deletionJobs.status, "processing")));
    await db.update(deletionJobItems).set({ status: "failed", lastError: message.slice(0, 1000), updatedAt: new Date() })
      .where(and(eq(deletionJobItems.deletionJobId, deletionJobId), eq(deletionJobItems.status, "processing")));
    throw error;
  }
}

// ── Second Brain enrichment (P1) ─────────────────────────────────────────────

/**
 * Enrich one memory.
 *
 * A `failed` outcome is rethrown so BullMQ retries it with the queue's backoff;
 * `skipped` and `missing` are normal completions — a memory deleted or already
 * current between enqueue and pickup is not an error. Logs carry counts and status
 * only: memory text never reaches the worker's stdout.
 */
async function runEnrichMemory(brainId: string, memoryId: string): Promise<void> {
  const report = await enrichMemory(db, { brainId, memoryId });
  console.log(
    `enrich_memory ${memoryId}: ${report.outcome} entities=${report.entities} mentions=${report.mentions} links=+${report.linksAdded}/-${report.linksRemoved}`
  );
  if (report.outcome === "failed") {
    throw new Error(`Enrichment failed for memory ${memoryId}: ${report.error ?? "unknown"}`);
  }

  // PHASE 2, PRINSIP 9: CREATE → enrichment → relate. Chained here rather than fired
  // from the write path so the entity mentions the scorer's strongest signal depends
  // on already exist. `skipped` still chains: the memory is current but its
  // *neighbours* may have moved since the last scoring pass.
  if (report.outcome !== "missing") {
    await enqueueRelate(brainId, memoryId);
  }
}

/**
 * Queue a derived-relationship pass. Fire-and-forget by design: relate is an
 * optimisation over already-committed data, so Redis being down must not fail the
 * enrichment that just succeeded. `jobId` collapses bursts.
 */
async function enqueueRelate(brainId: string, memoryId: string): Promise<void> {
  if (!redisConnection) return;
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  try {
    await queue.add(
      "relate_memory",
      { type: "relate_memory", brainId, memoryId },
      { jobId: relateJobId(memoryId), removeOnComplete: 100, removeOnFail: 50 }
    );
  } catch (error) {
    console.error(
      `relate enqueue ${memoryId}: ${error instanceof Error ? error.message : "unknown"}`
    );
  } finally {
    await queue.close();
  }
}

/**
 * Bounded backfill sweep. Re-queues itself only while it is still making progress,
 * so a memory that fails every attempt cannot turn the sweep into an infinite loop.
 */
async function runEnrichBrain(brainId: string, limit?: number): Promise<void> {
  const batchLimit = limit ?? ENRICH_SWEEP_LIMIT;
  const report = await enrichBrain(db, { brainId, limit: batchLimit });
  console.log(
    `enrich_brain ${brainId}: processed=${report.processed} ready=${report.ready} skipped=${report.skipped} failed=${report.failed} remaining=${report.remaining}`
  );

  if (report.remaining > 0 && report.ready + report.skipped > 0 && redisConnection) {
    const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
    try {
      await queue.add(
        "enrich_brain",
        { type: "enrich_brain", brainId, limit: batchLimit },
        { delay: 2000, removeOnComplete: 20, removeOnFail: 20 }
      );
    } finally {
      await queue.close();
    }
  }
}

// ── PHASE 2: Derived relationship computation ────────────────────────────────

/**
 * Compute derived relationships for one memory.
 *
 * The work itself lives in `@brain/application/commands/relate-jobs`, which is reachable from a
 * test; this wrapper is the operational shell around it — one log line of counts
 * (never memory text) and a rethrow so BullMQ retries.
 */
async function runRelateMemory(brainId: string, memoryId: string): Promise<void> {
  try {
    const report = await runRelateMemoryJob(db, brainId, memoryId);

    if (report.candidates === 0) {
      console.log(`relate_memory ${memoryId}: no candidates, -${report.deleted}`);
      return;
    }

    const { droppedTopK, droppedDegree, droppedGlobalCap } = report.pruned;
    console.log(
      `relate_memory ${memoryId}: candidates=${report.candidates} scored=${report.scored} ` +
        `survived=${report.survived} +${report.inserted}~${report.updated}-${report.deleted} ` +
        `pruned=topk:${droppedTopK}/degree:${droppedDegree}/cap:${droppedGlobalCap}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`relate_memory ${memoryId}: failed - ${message}`);
    throw error; // BullMQ will retry
  }
}

/**
 * Bounded backfill sweep: enqueue one relate_memory job per memory in the brain.
 *
 * Selection, the batch cap and the dedupe key live in `relate-jobs`; this wrapper owns
 * the queue: it opens one `Queue`, hands the sweep an enqueue callback, and closes it
 * whatever happens. With no Redis configured the sweep still runs and reports what it
 * found, which keeps a queue-less deployment from turning a sweep into an error.
 */
async function runRelateBrain(brainId: string, limit?: number): Promise<void> {
  if (!redisConnection) {
    const report = await runRelateBrainJob(db, brainId, limit, null);
    console.log(`relate_brain ${brainId}: ${report.found} memories, queue unavailable`);
    return;
  }

  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  try {
    const report = await runRelateBrainJob(db, brainId, limit, async (memoryId, jobId) => {
      await queue.add(
        "relate_memory",
        { type: "relate_memory", brainId, memoryId },
        { jobId, removeOnComplete: 100, removeOnFail: 50 }
      );
    });

    if (report.found === 0) {
      console.log(`relate_brain ${brainId}: 0 memories, queue ready`);
      return;
    }
    console.log(`relate_brain ${brainId}: enqueued=${report.enqueued}/${report.found}`);
  } finally {
    await queue.close();
  }
}

// ── P9: Semantic embedding ───────────────────────────────────────────────────

/**
 * Embed one memory. The work lives in `@brain/infrastructure/providers/embed-jobs`; this wrapper is
 * the operational shell — one log line of status only (never memory text) and a rethrow
 * so BullMQ retries a genuine failure. A no-op outcome (no provider, fresh, empty) is a
 * normal completion, not an error.
 */
async function runEmbedMemory(brainId: string, memoryId: string): Promise<void> {
  try {
    const report = await runEmbedMemoryJob(db, brainId, memoryId);
    console.log(
      `embed_memory ${memoryId}: embedded=${report.embedded} skipped=${report.skipped}` +
        (report.reason ? ` reason=${report.reason}` : "")
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`embed_memory ${memoryId}: failed - ${message}`);
    throw error; // BullMQ will retry
  }
}

/**
 * Bounded backfill sweep: enqueue one embed_memory job per memory in the brain.
 *
 * Selection, the batch cap and the dedupe key live in `embed-jobs`; this wrapper owns
 * the queue exactly like `runRelateBrain`. With no provider configured the sweep is
 * pointless, so it short-circuits before touching the queue — a deployment with
 * embeddings off never enqueues embed work.
 */
async function runEmbedBrain(brainId: string, limit?: number): Promise<void> {
  const provider = await getEmbeddingProvider(db);
  if (!(await provider.available())) {
    console.log(`embed_brain ${brainId}: no embedding provider configured, nothing to do`);
    return;
  }

  if (!redisConnection) {
    const report = await runEmbedBrainJob(db, brainId, limit, null);
    console.log(`embed_brain ${brainId}: ${report.found} memories, queue unavailable`);
    return;
  }

  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  try {
    const report = await runEmbedBrainJob(db, brainId, limit, async (memoryId, jobId) => {
      await queue.add(
        "embed_memory",
        { type: "embed_memory", brainId, memoryId },
        { jobId, removeOnComplete: 100, removeOnFail: 50 }
      );
    });

    if (report.found === 0) {
      console.log(`embed_brain ${brainId}: 0 memories, queue ready`);
      return;
    }
    console.log(`embed_brain ${brainId}: enqueued=${report.enqueued}/${report.found}`);
  } finally {
    await queue.close();
  }
}

/**
 * What the subtitle jobs need from this process.
 *
 * Passed in rather than imported by `subtitle-jobs.ts` so that module stays free of
 * `child_process` and of this file's R2 client — it is also reachable from the Next.js module
 * graph through the routes, and a stray `execFile` import there is the kind of thing that only
 * breaks at build time on the server.
 *
 * `runFfmpeg` must reject with the error `execFile` produces, `stderr` and all: the job reads it
 * to tell "this video has no audio track" (a fact about the file, so stop) from a real failure
 * (worth another encoder, then a retry).
 */
const subtitleDeps = {
  downloadToFile: downloadR2ToFile,
  runFfmpeg: async (args: string[]) => {
    await execFileAsync("ffmpeg", args);
  },
  tmpPath,
  log: (message: string) => console.log(message),
};

const worker = new Worker(
  QUEUE_NAME,  async (job) => {
    const data = job.data as {
      type: string;
      fileId?: string;
      r2Key?: string;
      mimeType?: string;
      version?: number;
      operationId?: string;
      outputFileId?: string;
      startSeconds?: number;
      endSeconds?: number;
      userId?: string;
      folderId?: string | null;
      name?: string;
      webhookId?: string;
      url?: string;
      secret?: string;
      body?: string;
      archiveJobId?: string;
      deletionJobId?: string;
      brainId?: string;
      memoryId?: string;
      limit?: number;
      trackId?: string;
      targets?: string[];
    };

    switch (data.type) {
      case "generate_thumbnail":
        if (data.fileId && data.r2Key && data.mimeType && data.version !== undefined) {
          await mediaWorker.generateThumbnail({
            fileId: data.fileId,
            r2Key: data.r2Key,
            mimeType: data.mimeType,
            version: data.version,
          });
        }
        break;
      case "inspect_media":
        if (data.fileId && data.r2Key && data.mimeType && data.version !== undefined) {
          await mediaWorker.inspectMedia({
            fileId: data.fileId,
            r2Key: data.r2Key,
            mimeType: data.mimeType,
            version: data.version,
          });
        }
        break;
      case "compress_image":
        await compressImage(data.fileId!, data.r2Key!, data.mimeType!);
        break;
      case "trim_media":
        if (
          data.operationId &&
          data.fileId &&
          data.r2Key &&
          data.mimeType &&
          data.version !== undefined &&
          data.startSeconds !== undefined &&
          data.endSeconds !== undefined
        ) {
          await mediaWorker.trimMedia({
            operationId: data.operationId,
            fileId: data.fileId,
            r2Key: data.r2Key,
            mimeType: data.mimeType,
            version: data.version,
            startSeconds: data.startSeconds,
            endSeconds: data.endSeconds,
          });
        }
        break;
      case "extract_audio":
        if (
          data.operationId &&
          data.outputFileId &&
          data.fileId &&
          data.r2Key &&
          data.mimeType &&
          data.version !== undefined &&
          data.userId &&
          data.name
        ) {
          await mediaWorker.extractAudio({
            operationId: data.operationId,
            outputFileId: data.outputFileId,
            fileId: data.fileId,
            r2Key: data.r2Key,
            mimeType: data.mimeType,
            version: data.version,
            userId: data.userId,
            folderId: data.folderId ?? null,
            name: data.name,
          });
        }
        break;
      case "deliver_webhook":
        await deliverWebhook({
          webhookId: data.webhookId!,
          url: data.url!,
          secret: data.secret!,
          body: data.body!,
        });
        break;
      case "cleanup_schedules":
        await runScheduledCleanups(db);
        break;
      case "build_archive":
        await buildArchive(data.archiveJobId!);
        break;
      case "process_deletion":
        await processDeletion(data.deletionJobId!);
        break;
      case "enrich_memory":
        // Both ids are required: enrichment scopes every statement by brain, so a
        // payload without one must not fall through to a brain-wide operation.
        if (data.brainId && data.memoryId) {
          await runEnrichMemory(data.brainId, data.memoryId);
        }
        break;
      case "enrich_brain":
        if (data.brainId) {
          await runEnrichBrain(data.brainId, data.limit);
        }
        break;
      case "relate_memory":
        // Both IDs required, same safety as enrich_memory
        if (data.brainId && data.memoryId) {
          await runRelateMemory(data.brainId, data.memoryId);
        }
        break;
      case "relate_brain":
        if (data.brainId) {
          await runRelateBrain(data.brainId, data.limit);
        }
        break;
      case "embed_memory":
        // Both IDs required, same safety as enrich_memory / relate_memory.
        if (data.brainId && data.memoryId) {
          await runEmbedMemory(data.brainId, data.memoryId);
        }
        break;
      case "embed_brain":
        if (data.brainId) {
          await runEmbedBrain(data.brainId, data.limit);
        }
        break;
      case "transcribe_media":
        // A missing trackId means a stale payload: without it there is no row to claim, and
        // claiming is what stops a duplicate delivery spending money twice.
        if (data.trackId) {
          await runTranscribeMedia(
            {
              trackId: data.trackId,
              targets: Array.isArray(data.targets) ? data.targets : [],
            },
            subtitleDeps
          );
        }
        break;
      case "translate_subtitles":
        if (data.trackId) {
          await runTranslateSubtitles({ trackId: data.trackId }, subtitleDeps);
        }
        break;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

worker.on("completed", (job) => console.log(`Job ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`Job ${job?.id} failed:`, err?.message ?? err));
worker.on("error", (err) => console.error("Worker error:", err.message));

// Register hourly cleanup job
(async () => {
  try {
    const q = new Queue(QUEUE_NAME, { connection: redisConnection });
    await q.add(
      "cleanup_schedules",
      { type: "cleanup_schedules" },
      {
        jobId: "cleanup-schedules-hourly",
        repeat: { every: 60 * 60 * 1000 },
        removeOnComplete: 20,
        removeOnFail: 20,
      }
    );
    await q.close();
    console.log("Cleanup schedule registered (hourly)");
  } catch (err) {
    console.error("Failed to register cleanup schedule", err);
  }
})();

console.log(`Storage worker started (redis://${redisConnection.host}:${redisConnection.port})`);
