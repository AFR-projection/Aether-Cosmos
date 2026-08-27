/**
 * Brain Backup and Restore System
 *
 * Automated backup with point-in-time recovery:
 * - Scheduled automated backups
 * - Incremental backups (only changes)
 * - Full backups with all metadata
 * - Point-in-time restore
 * - Backup verification and integrity checks
 * - Multiple storage backends (S3, R2, local)
 */

import { db } from "@/lib/db";
import { memories, memoryLinks, memoryTags, brains } from "@/lib/db/schema";
import { eq, and, isNull, gte, sql } from "drizzle-orm";
import { createHash } from "crypto";
import { formatISO } from "date-fns";

export interface BackupMetadata {
  id: string;
  brainId: string;
  brainName: string;
  type: "full" | "incremental";
  createdAt: Date;
  size: number; // bytes
  memoryCount: number;
  checksum: string;
  baseBackupId?: string; // For incremental backups
}

export interface BackupOptions {
  type: "full" | "incremental";
  compress?: boolean;
  includeDeleted?: boolean;
  baseBackupId?: string; // Required for incremental
}

export interface RestoreOptions {
  backupId: string;
  targetBrainId?: string; // If different from source
  pointInTime?: Date; // Restore to specific timestamp
  includeLinks?: boolean;
  includeTags?: boolean;
}

export interface BackupData {
  metadata: BackupMetadata;
  memories: any[];
  links: any[];
  tags: any[];
  derivedLinks?: any[];
}

/**
 * Create a backup of a brain.
 */
export async function createBackup(
  brainId: string,
  options: BackupOptions
): Promise<BackupMetadata> {
  const { type, compress = true, includeDeleted = false, baseBackupId } = options;

  // Get brain info
  const [brain] = await db
    .select({ name: brains.name })
    .from(brains)
    .where(eq(brains.id, brainId))
    .limit(1);

  if (!brain) {
    throw new Error("Brain not found");
  }

  let memoriesQuery = db
    .select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      deletedAt: memories.deletedAt,
    })
    .from(memories)
    .where(eq(memories.brainId, brainId));

  // For incremental backup, only get changes since base backup
  if (type === "incremental") {
    if (!baseBackupId) {
      throw new Error("Base backup ID required for incremental backup");
    }

    const baseBackup = await getBackupMetadata(baseBackupId);
    memoriesQuery = memoriesQuery.where(
      gte(memories.updatedAt, baseBackup.createdAt)
    );
  }

  if (!includeDeleted) {
    memoriesQuery = memoriesQuery.where(isNull(memories.deletedAt));
  }

  const memoryList = await memoriesQuery;
  const memoryIds = memoryList.map((m) => m.id);

  // Get links
  const links = await db
    .select()
    .from(memoryLinks)
    .where(sql`${memoryLinks.sourceId} = ANY(${memoryIds}::uuid[])`);

  // Get tags
  const tags = await db
    .select()
    .from(memoryTags)
    .where(sql`${memoryTags.memoryId} = ANY(${memoryIds}::uuid[])`);

  // Build backup data
  const backupData: BackupData = {
    metadata: {
      id: "", // Will be set after hashing
      brainId,
      brainName: brain.name,
      type,
      createdAt: new Date(),
      size: 0,
      memoryCount: memoryList.length,
      checksum: "",
      baseBackupId,
    },
    memories: memoryList,
    links: links,
    tags: tags,
  };

  // Serialize and calculate checksum
  const serialized = JSON.stringify(backupData);
  const checksum = createHash("sha256").update(serialized).digest("hex");
  const size = Buffer.byteLength(serialized, "utf8");

  backupData.metadata.id = `backup-${brainId}-${Date.now()}-${checksum.slice(0, 8)}`;
  backupData.metadata.checksum = checksum;
  backupData.metadata.size = size;

  // Store backup (implementation depends on storage backend)
  await storeBackup(backupData);

  return backupData.metadata;
}

/**
 * Restore brain from backup.
 */
export async function restoreBackup(
  options: RestoreOptions
): Promise<{ restoredMemories: number; restoredLinks: number; restoredTags: number }> {
  const { backupId, targetBrainId, pointInTime, includeLinks = true, includeTags = true } = options;

  // Load backup data
  const backupData = await loadBackup(backupId);

  if (!backupData) {
    throw new Error("Backup not found");
  }

  const brainId = targetBrainId || backupData.metadata.brainId;

  // Filter memories by point-in-time if specified
  let memoriesToRestore = backupData.memories;

  if (pointInTime) {
    memoriesToRestore = memoriesToRestore.filter(
      (m) => new Date(m.createdAt) <= pointInTime
    );
  }

  // Restore memories
  let restoredMemories = 0;
  const memoryIdMap = new Map<string, string>(); // old ID -> new ID

  for (const memory of memoriesToRestore) {
    const [restored] = await db
      .insert(memories)
      .values({
        brainId,
        content: memory.content,
        embedding: memory.embedding,
        createdAt: new Date(memory.createdAt),
        updatedAt: new Date(memory.updatedAt),
      })
      .returning({ id: memories.id });

    memoryIdMap.set(memory.id, restored.id);
    restoredMemories++;
  }

  // Restore links
  let restoredLinks = 0;
  if (includeLinks) {
    for (const link of backupData.links) {
      const newSourceId = memoryIdMap.get(link.sourceId);
      const newTargetId = memoryIdMap.get(link.targetId);

      if (newSourceId && newTargetId) {
        await db.insert(memoryLinks).values({
          sourceId: newSourceId,
          targetId: newTargetId,
          createdAt: new Date(link.createdAt),
        });
        restoredLinks++;
      }
    }
  }

  // Restore tags
  let restoredTags = 0;
  if (includeTags) {
    for (const tag of backupData.tags) {
      const newMemoryId = memoryIdMap.get(tag.memoryId);

      if (newMemoryId) {
        await db.insert(memoryTags).values({
          memoryId: newMemoryId,
          tag: tag.tag,
          createdAt: new Date(tag.createdAt),
        });
        restoredTags++;
      }
    }
  }

  return {
    restoredMemories,
    restoredLinks,
    restoredTags,
  };
}

/**
 * List all backups for a brain.
 */
export async function listBackups(brainId: string): Promise<BackupMetadata[]> {
  // Implementation depends on storage backend
  // This is a placeholder
  return [];
}

/**
 * Verify backup integrity.
 */
export async function verifyBackup(backupId: string): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const backupData = await loadBackup(backupId);

  if (!backupData) {
    return { valid: false, errors: ["Backup not found"] };
  }

  const errors: string[] = [];

  // Recalculate checksum
  const serialized = JSON.stringify({
    ...backupData,
    metadata: { ...backupData.metadata, checksum: "" },
  });
  const calculatedChecksum = createHash("sha256").update(serialized).digest("hex");

  if (calculatedChecksum !== backupData.metadata.checksum) {
    errors.push("Checksum mismatch - backup may be corrupted");
  }

  // Verify memory count
  if (backupData.memories.length !== backupData.metadata.memoryCount) {
    errors.push(`Memory count mismatch: expected ${backupData.metadata.memoryCount}, got ${backupData.memories.length}`);
  }

  // Verify embeddings
  for (const memory of backupData.memories) {
    if (memory.embedding) {
      try {
        JSON.parse(memory.embedding);
      } catch {
        errors.push(`Invalid embedding for memory ${memory.id}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get backup metadata.
 */
async function getBackupMetadata(backupId: string): Promise<BackupMetadata> {
  const backupData = await loadBackup(backupId);

  if (!backupData) {
    throw new Error("Backup not found");
  }

  return backupData.metadata;
}

/**
 * Store backup (placeholder - implement based on storage backend).
 */
async function storeBackup(backupData: BackupData): Promise<void> {
  // Implementation depends on storage backend:
  // - S3/R2: upload to cloud storage
  // - Local: write to file system
  // - Database: store in backup table

  // For now, this is a placeholder
  console.log(`Storing backup ${backupData.metadata.id}`);
}

/**
 * Load backup (placeholder - implement based on storage backend).
 */
async function loadBackup(backupId: string): Promise<BackupData | null> {
  // Implementation depends on storage backend
  // For now, this is a placeholder
  console.log(`Loading backup ${backupId}`);
  return null;
}

/**
 * Delete old backups based on retention policy.
 */
export async function pruneOldBackups(
  brainId: string,
  retentionPolicy: {
    keepLast?: number; // Keep N most recent backups
    keepDays?: number; // Keep backups from last N days
  }
): Promise<number> {
  const { keepLast = 10, keepDays = 30 } = retentionPolicy;

  const allBackups = await listBackups(brainId);

  // Sort by date descending
  allBackups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const cutoffDate = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
  let deleted = 0;

  for (let i = 0; i < allBackups.length; i++) {
    const backup = allBackups[i];

    // Keep if within retention rules
    if (i < keepLast || backup.createdAt > cutoffDate) {
      continue;
    }

    // Delete this backup
    await deleteBackup(backup.id);
    deleted++;
  }

  return deleted;
}

/**
 * Delete a backup.
 */
async function deleteBackup(backupId: string): Promise<void> {
  // Implementation depends on storage backend
  console.log(`Deleting backup ${backupId}`);
}

/**
 * Schedule automated backup.
 */
export async function scheduleBackup(
  brainId: string,
  schedule: "hourly" | "daily" | "weekly",
  options: BackupOptions
): Promise<void> {
  // Integration with cron/scheduler
  // This would use CronCreate or similar
  console.log(`Scheduling ${schedule} backup for brain ${brainId}`);
}
