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
