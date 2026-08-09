import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as schema from "../lib/db/schema";
import { activityLogs, archiveJobs, fileVersions, files, folders, uploadSessions, users } from "../lib/db/schema";
import { headObject, listMultipartUploads, listR2Objects, abortMultipartUpload } from "../lib/storage/r2";
import { assertFileUploadTransition, assertUploadSessionTransition } from "../lib/storage/upload-state";
import {
  claimCleanupRun,
  recordCleanupResult,
  type CleanupResult,
  type CleanupSource,
} from "../lib/system/cleanup-state";

type Db = PostgresJsDatabase<typeof schema>;

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

async function deleteR2(key: string) {
  if (!key || key === "pending" || key.startsWith("notes/")) return;
  try {
    const client = getR2Client();
    await client.send(
      new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: key })
    );
  } catch {
    // continue
  }
}

type SettingsShape = {
  autoDeleteTrashDays: number;
  maxFileLifetimeDays: number;
  logRetentionDays: number;
};

async function loadSettings(db: Db): Promise<SettingsShape> {
  const [row] = await db
    .select()
    .from(schema.systemSettings)
    .where(eq(schema.systemSettings.id, "default"))
    .limit(1);

  const data = (row?.data ?? {}) as Partial<SettingsShape>;
  return {
    autoDeleteTrashDays: Number(data.autoDeleteTrashDays ?? 30),
    maxFileLifetimeDays: Number(data.maxFileLifetimeDays ?? 0),
    logRetentionDays: Number(data.logRetentionDays ?? 90),
  };
}

/** Permanent-delete soft-deleted files/folders older than N days. */
async function cleanupTrash(db: Db, days: number) {
  if (!days || days <= 0) return { files: 0, folders: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const trashFiles = await db
    .select()
    .from(files)
    .where(and(isNotNull(files.deletedAt), lt(files.deletedAt, cutoff)))
    .limit(500);

  for (const f of trashFiles) {
    await deleteR2(f.r2Key);
    if (f.thumbnailKey) await deleteR2(f.thumbnailKey);
    await db.delete(files).where(eq(files.id, f.id));
  }

  const trashFolders = await db
    .select()
    .from(folders)
    .where(and(isNotNull(folders.deletedAt), lt(folders.deletedAt, cutoff)))
    .limit(500);

  for (const folder of trashFolders) {
    await db.delete(folders).where(eq(folders.id, folder.id));
  }

  return { files: trashFiles.length, folders: trashFolders.length };
}

/** Soft-delete active files older than N days (lifetime policy). */
async function cleanupFileLifetime(db: Db, days: number) {
  if (!days || days <= 0) return { softDeleted: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const oldFiles = await db
    .select({ id: files.id })
    .from(files)
    .where(and(isNull(files.deletedAt), lt(files.createdAt, cutoff)))
    .limit(500);

  const now = new Date();
  for (const f of oldFiles) {
    await db.update(files).set({ deletedAt: now, updatedAt: now }).where(eq(files.id, f.id));
  }

  return { softDeleted: oldFiles.length };
}

async function cleanupLogs(db: Db, days: number) {
  if (!days || days < 7) return { deleted: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db.delete(activityLogs).where(lt(activityLogs.createdAt, cutoff));
  return { deleted: (result as { rowCount?: number }).rowCount ?? 0 };
}

async function cleanupArchives(db: Db) {
  const now = new Date();
  const expired = await db
    .select({ id: archiveJobs.id, objectKey: archiveJobs.objectKey })
    .from(archiveJobs)
    .where(and(
      lt(archiveJobs.expiresAt, now),
      inArray(archiveJobs.status, ["created", "processing", "ready", "failed"])
    ))
    .limit(100);

  for (const job of expired) {
    await deleteR2(job.objectKey);
    await db.update(archiveJobs).set({
      status: "expired",
      errorCode: "EXPIRED",
      errorMessage: "Archive download expired",
      updatedAt: now,
    }).where(and(eq(archiveJobs.id, job.id), inArray(archiveJobs.status, ["created", "processing", "ready", "failed"])));
  }
  return { expired: expired.length };
}

const RECONCILIATION_GRACE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_OBJECT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reconcile Neon state with R2. This is deliberately conservative: an object
 * is only considered orphaned after a grace period, and missing READY objects
 * are made unavailable instead of being silently ignored.
 */
async function reconcileUploads(db: Db) {
  const now = new Date();
  const expiredCutoff = new Date(now.getTime() - RECONCILIATION_GRACE_MS);
  let expiredUploads = 0;
  let verifiedLegacyFiles = 0;
  let inconsistentReadyFiles = 0;
  let abortedMultipartUploads = 0;
  let orphanObjectsReported = 0;

  const expired = await db
    .select({ session: uploadSessions, file: files })
    .from(uploadSessions)
    .innerJoin(files, eq(files.id, uploadSessions.fileId))
    .where(
      and(
        inArray(uploadSessions.status, ["created", "uploading", "verifying", "failed"]),
        lt(uploadSessions.expiresAt, expiredCutoff)
      )
    )
    .limit(500);

  for (const { session, file } of expired) {
    if (session.r2UploadId) await abortMultipartUpload(file.r2Key, session.r2UploadId);
    await db.transaction(async (tx) => {
      const [lockedSession] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, session.id)).limit(1).for("update");
      const [lockedFile] = await tx.select().from(files).where(eq(files.id, file.id)).limit(1).for("update");
      if (!lockedSession || !lockedFile || lockedFile.status === "ready") return;

      const sessionNext = lockedSession.status === "verifying" ? "failed" : "expired";
      if (lockedSession.status !== sessionNext) assertUploadSessionTransition(lockedSession.status, sessionNext);
      const fileNext = lockedFile.status === "verifying" ? "failed" : "failed";
      if (lockedFile.status !== fileNext) assertFileUploadTransition(lockedFile.status, fileNext);
      await tx.update(uploadSessions).set({ status: sessionNext, failureCode: "EXPIRED", failureMessage: "Upload session expired during reconciliation", reservationReleased: true, updatedAt: now }).where(eq(uploadSessions.id, lockedSession.id));
      await tx.update(files).set({ status: fileNext, failureCode: "EXPIRED", failureMessage: "Upload session expired during reconciliation", updatedAt: now }).where(eq(files.id, lockedFile.id));
      if (!lockedSession.reservationReleased) await tx.update(users).set({ reservedBytes: sql`GREATEST(0, ${users.reservedBytes} - ${lockedSession.totalSizeBytes})` }).where(eq(users.id, lockedSession.userId));
      expiredUploads++;
    });
  }

  const legacy = await db.select().from(files).where(and(eq(files.status, "legacy_unverified"), eq(files.isNote, false))).limit(500);
  for (const file of legacy) {
    let verified = false;
    try {
      const object = await headObject(file.r2Key);
      verified = object.contentLength === file.sizeBytes;
    } catch {
      verified = false;
    }
    if (!verified) {
      await db.update(files).set({ status: "failed", failureCode: "LEGACY_OBJECT_MISSING_OR_INVALID", failureMessage: "Legacy object could not be verified", updatedAt: now }).where(and(eq(files.id, file.id), eq(files.status, "legacy_unverified")));
      continue;
    }
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(files).where(eq(files.id, file.id)).limit(1).for("update");
      if (!locked || locked.status !== "legacy_unverified") return;
      assertFileUploadTransition("legacy_unverified", "verifying");
      assertFileUploadTransition("verifying", "ready");
      const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.fileId, file.id)).limit(1);
      const completedAt = locked.completedAt ?? now;
      if (!session) {
        await tx.insert(uploadSessions).values({ fileId: locked.id, userId: locked.userId, idempotencyKey: `legacy-verification:${locked.id}`, uploadType: "single", objectKey: locked.r2Key, totalSizeBytes: locked.sizeBytes, status: "completed", reservationReleased: true, expiresAt: completedAt, completedAt, updatedAt: now });
      }
      await tx.update(files).set({ status: "ready", completedAt, verifiedAt: now, failureCode: null, failureMessage: null, updatedAt: now }).where(eq(files.id, locked.id));
      verifiedLegacyFiles++;
    });
  }

  const ready = await db.select().from(files).where(and(eq(files.status, "ready"), eq(files.isNote, false), isNull(files.deletedAt))).limit(500);
  for (const file of ready) {
    try {
      const object = await headObject(file.r2Key);
      if (object.contentLength === file.sizeBytes) continue;
      await db.update(files).set({ status: "inconsistent", failureCode: "READY_OBJECT_SIZE_MISMATCH", failureMessage: `R2 size ${object.contentLength} != metadata size ${file.sizeBytes}`, updatedAt: now }).where(and(eq(files.id, file.id), eq(files.status, "ready")));
      inconsistentReadyFiles++;
    } catch {
      await db.update(files).set({ status: "inconsistent", failureCode: "READY_OBJECT_MISSING", failureMessage: "R2 object is missing for READY metadata", updatedAt: now }).where(and(eq(files.id, file.id), eq(files.status, "ready")));
      inconsistentReadyFiles++;
    }
  }

  const activeMultipartIds = new Set(
    (await db.select({ uploadId: uploadSessions.r2UploadId }).from(uploadSessions).where(and(isNotNull(uploadSessions.r2UploadId), inArray(uploadSessions.status, ["created", "uploading", "verifying"])))).map((row) => row.uploadId).filter((id): id is string => !!id)
  );
  for (const multipart of await listMultipartUploads("users/")) {
    if (activeMultipartIds.has(multipart.uploadId)) continue;
    if (!multipart.initiatedAt || multipart.initiatedAt > expiredCutoff) continue;
    await abortMultipartUpload(multipart.key, multipart.uploadId);
    abortedMultipartUploads++;
  }

  const candidates = await listR2Objects("users/", 1000);
  for (let offset = 0; offset < candidates.length; offset += 250) {
    const chunk = candidates.slice(offset, offset + 250);
    const keys = chunk.map((object) => object.key);
    const trackedKeys = new Set([
      ...(await db.select({ key: files.r2Key }).from(files).where(inArray(files.r2Key, keys))).map((row) => row.key),
      ...(await db.select({ key: fileVersions.r2Key }).from(fileVersions).where(inArray(fileVersions.r2Key, keys))).map((row) => row.key),
      ...(await db.select({ key: uploadSessions.objectKey }).from(uploadSessions).where(inArray(uploadSessions.objectKey, keys))).map((row) => row.key),
    ]);
    for (const object of chunk) {
      if (trackedKeys.has(object.key)) continue;
      if (!object.lastModified || object.lastModified > new Date(now.getTime() - ORPHAN_OBJECT_GRACE_MS)) continue;
      orphanObjectsReported++;
      console.warn(`[reconcile] orphan R2 object candidate (not deleted): ${object.key}`);
    }
  }

  return { expiredUploads, verifiedLegacyFiles, inconsistentReadyFiles, abortedMultipartUploads, orphanObjectsReported };
}

export async function runScheduledCleanups(
  db: Db,
  source: CleanupSource = "worker"
): Promise<CleanupResult | null> {
  // Both the BullMQ worker and the web app schedule this. Only the one that
  // wins the claim actually sweeps; the other returns null immediately.
  if (!(await claimCleanupRun(db, source))) return null;

  try {
    const settings = await loadSettings(db);
    const reconciliation = await reconcileUploads(db);
    const trash = await cleanupTrash(db, settings.autoDeleteTrashDays);
    const lifetime = await cleanupFileLifetime(db, settings.maxFileLifetimeDays);
    const logs = await cleanupLogs(db, settings.logRetentionDays);
    const archives = await cleanupArchives(db);

    const result: CleanupResult = {
      trashFiles: trash.files,
      trashFolders: trash.folders,
      lifetimeSoftDeleted: lifetime.softDeleted,
      logsDeleted: logs.deleted,
      expiredArchives: archives.expired,
      ...reconciliation,
    };

    await recordCleanupResult(db, { result });
    console.log(
      `[cleanup:${source}] trash files=${result.trashFiles} folders=${result.trashFolders} lifetime=${result.lifetimeSoftDeleted} logs=${result.logsDeleted}`
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordCleanupResult(db, { error: message }).catch(() => {});
    throw error;
  }
}
