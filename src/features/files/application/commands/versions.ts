import { and, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { files, fileVersions, changeHistory, type File } from "@/shared/infrastructure/db/schema";
import { copyR2Object, objectExists } from "@files/infrastructure/storage/r2";

function versionObjectKey(file: File, version: number): string {
  return `${file.userId}/${file.id}/versions/${version}/${file.name}`;
}

/** True when the file already has real storage content (not a fresh pending upload). */
export function hasPersistedObject(file: File): boolean {
  return (
    file.sizeBytes > 0 &&
    !!file.r2Key &&
    file.r2Key !== "pending" &&
    !file.r2Key.startsWith("notes/")
  );
}

/**
 * Snapshot the current object into `file_versions`, bump `files.version`.
 * Call before replacing the R2 object (image edit / replace upload).
 */
export async function snapshotFileVersion(
  file: File,
  createdBy: string
): Promise<{ previousVersion: number; newVersion: number } | null> {
  if (!hasPersistedObject(file)) return null;

  const exists = await objectExists(file.r2Key);
  if (!exists) return null;

  const previousVersion = file.version;
  const versionKey = versionObjectKey(file, previousVersion);

  await copyR2Object(file.r2Key, versionKey);

  await db.insert(fileVersions).values({
    fileId: file.id,
    version: previousVersion,
    r2Key: versionKey,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    createdBy,
  });

  const newVersion = previousVersion + 1;
  await db
    .update(files)
    .set({ version: newVersion, updatedAt: new Date() })
    .where(eq(files.id, file.id));

  await db.insert(changeHistory).values({
    fileId: file.id,
    userId: createdBy,
    changeType: "version_snapshot",
    snapshot: { version: previousVersion, r2Key: versionKey },
  });

  return { previousVersion, newVersion };
}

/**
 * Restore a historical version: snapshot current first, then copy version object onto live key.
 */
export async function restoreFileVersion(
  file: File,
  targetVersion: number,
  restoredBy: string
): Promise<File> {
  const [target] = await db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.version, targetVersion)))
    .limit(1);

  if (!target) {
    throw new Error("Version not found");
  }

  // Snapshot current before restore
  await snapshotFileVersion(file, restoredBy);

  // Re-fetch after snapshot bumped version
  const [fresh] = await db.select().from(files).where(eq(files.id, file.id)).limit(1);
  if (!fresh) throw new Error("File not found");

  await copyR2Object(target.r2Key, fresh.r2Key);

  const [updated] = await db
    .update(files)
    .set({
      sizeBytes: target.sizeBytes,
      checksumSha256: target.checksumSha256,
      updatedAt: new Date(),
    })
    .where(eq(files.id, file.id))
    .returning();

  await db.insert(changeHistory).values({
    fileId: file.id,
    userId: restoredBy,
    changeType: "version_restore",
    snapshot: { restoredVersion: targetVersion },
  });

  return updated;
}

export async function listFileVersions(fileId: string) {
  return db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.fileId, fileId));
}
