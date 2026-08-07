import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as schema from "../lib/db/schema";
import { activityLogs, files, folders } from "../lib/db/schema";
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

export async function runScheduledCleanups(
  db: Db,
  source: CleanupSource = "worker"
): Promise<CleanupResult | null> {
  // Both the BullMQ worker and the web app schedule this. Only the one that
  // wins the claim actually sweeps; the other returns null immediately.
  if (!(await claimCleanupRun(db, source))) return null;

  try {
    const settings = await loadSettings(db);
    const trash = await cleanupTrash(db, settings.autoDeleteTrashDays);
    const lifetime = await cleanupFileLifetime(db, settings.maxFileLifetimeDays);
    const logs = await cleanupLogs(db, settings.logRetentionDays);

    const result: CleanupResult = {
      trashFiles: trash.files,
      trashFolders: trash.folders,
      lifetimeSoftDeleted: lifetime.softDeleted,
      logsDeleted: logs.deleted,
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
