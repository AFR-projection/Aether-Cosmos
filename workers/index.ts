import "dotenv/config";
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
import * as schema from "../lib/db/schema";
import {
  archiveJobItems,
  archiveJobs,
  deletionJobItems,
  deletionJobs,
  files,
  folders,
  users,
  webhooks,
} from "../lib/db/schema";
import { QUEUE_NAME } from "../lib/queue";
import { runScheduledCleanups } from "./cleanup";
import { enrichBrain, enrichMemory, ENRICH_SWEEP_LIMIT } from "../lib/brain/enrich/enrich-service";
import { relateJobId, runRelateBrainJob, runRelateMemoryJob } from "../lib/brain/graph/relate-jobs";
import { runEmbedBrainJob, runEmbedMemoryJob } from "../lib/brain/embedding/embed-jobs";
import { getEmbeddingProvider } from "../lib/brain/embedding/resolve";
import { Queue } from "bullmq";
import { PassThrough, Readable } from "stream";
import { ZipArchive } from "archiver";
import {
  deleteR2Object,
  deleteR2Objects,
  downloadFromR2Stream,
  headObject,
  uploadR2Stream,
} from "../lib/storage/r2";

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
  const buffer = await downloadFromR2(r2Key);
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${fileId}-input`);
  await fs.writeFile(tmpIn, buffer);

  let generated300 = false;
  try {
    // Generate multiple sizes from video frame
    for (const size of THUMB_SIZES) {
      const tmpOut = tmpPath(`${fileId}-thumb-${size}.webp`);
      try {
        await execFileAsync("ffmpeg", [
          "-i", tmpIn,
          "-ss", "00:00:01",
          "-vframes", "1",
          "-vf", `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
          "-y", tmpOut,
        ]);
        const thumbBuffer = await fs.readFile(tmpOut);
        // Convert to webp via sharp
        const webpBuffer = await sharp(thumbBuffer).webp({ quality: 80 }).toBuffer();
        await uploadToR2(`thumbnails/${fileId}_${size}.webp`, webpBuffer, "image/webp");
        if (size === 300) generated300 = true;
      } catch {
        // If size fails, skip it
      } finally {
        await fs.unlink(tmpOut).catch(() => {});
      }
    }
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
  }
  return generated300;
}

async function generatePdfThumbnail(fileId: string, r2Key: string): Promise<boolean> {
  // ffmpeg cannot decode PDFs — real renderer lands with pdfjs (Phase 1).
  // Return false so thumbnailKey is never set to a nonexistent object.
  void fileId;
  void r2Key;
  return false;
}

async function generateAudioThumbnail(fileId: string, r2Key: string): Promise<boolean> {
  const buffer = await downloadFromR2(r2Key);
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${fileId}-input`);
  const tmpOut = tmpPath(`${fileId}-cover.jpg`);
  await fs.writeFile(tmpIn, buffer);

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

async function generateThumbnail(fileId: string, r2Key: string, mimeType: string) {
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

async function compressImage(fileId: string, r2Key: string, mimeType: string) {
  const buffer = await downloadFromR2(r2Key);
  const output = await sharp(buffer).jpeg({ quality: 80 }).toBuffer();
  await uploadToR2(r2Key, output, mimeType);
  await db.update(files).set({ sizeBytes: output.length }).where(eq(files.id, fileId));
}

async function trimMedia(
  fileId: string,
  r2Key: string,
  mimeType: string,
  startSeconds: number,
  endSeconds: number
) {
  const buffer = await downloadFromR2(r2Key);
  const fs = await import("fs/promises");
  const tmpIn = tmpPath(`${fileId}-trim-in`);
  const ext = mimeType.includes("video") ? "mp4" : "mp3";
  const tmpOut = tmpPath(`${fileId}-trim-out.${ext}`);
  await fs.writeFile(tmpIn, buffer);

  try {
    await execFileAsync("ffmpeg", [
      "-i", tmpIn,
      "-ss", String(startSeconds),
      "-to", String(endSeconds),
      "-c", "copy",
      "-y", tmpOut,
    ]);
    const output = await fs.readFile(tmpOut);
    await uploadToR2(r2Key, output, mimeType);
    await db.update(files).set({ sizeBytes: output.length }).where(eq(files.id, fileId));
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}

async function deliverWebhook(data: {
  webhookId: string;
  url: string;
  secret: string;
  body: string;
}) {
  const signature = createHmac("sha256", data.secret).update(data.body).digest("hex");
  const res = await fetch(data.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": `sha256=${signature}`,
      "User-Agent": "StrogeByAFR-Webhook/1.0",
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

    const [usage] = await db.select({ total: drizzleSql<number>`COALESCE(SUM(${files.sizeBytes}), 0)` })
      .from(files).where(and(
        eq(files.userId, claimed.userId),
        drizzleSql`deleted_at IS NULL`,
        inArray(files.status, ["ready", "legacy_unverified"])
      ));
    await db.update(users).set({ usedBytes: Number(usage?.total ?? 0), updatedAt: new Date() })
      .where(eq(users.id, claimed.userId));

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
 * The work itself lives in `lib/brain/graph/relate-jobs`, which is reachable from a
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
 * Embed one memory. The work lives in `lib/brain/embedding/embed-jobs`; this wrapper is
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

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const data = job.data as {
      type: string;
      fileId?: string;
      r2Key?: string;
      mimeType?: string;
      startSeconds?: number;
      endSeconds?: number;
      webhookId?: string;
      url?: string;
      secret?: string;
      body?: string;
      archiveJobId?: string;
      deletionJobId?: string;
      brainId?: string;
      memoryId?: string;
      limit?: number;
    };

    switch (data.type) {
      case "generate_thumbnail":
        await generateThumbnail(data.fileId!, data.r2Key!, data.mimeType!);
        break;
      case "compress_image":
        await compressImage(data.fileId!, data.r2Key!, data.mimeType!);
        break;
      case "trim_media":
        if (data.startSeconds !== undefined && data.endSeconds !== undefined) {
          await trimMedia(data.fileId!, data.r2Key!, data.mimeType!, data.startSeconds, data.endSeconds);
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
