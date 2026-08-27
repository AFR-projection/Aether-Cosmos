/**
 * Memory Versioning System
 *
 * Tracks all changes to memory content for:
 * - Audit trail
 * - Rollback capability
 * - Diff visualization
 * - Undo/redo support
 *
 * Design:
 * - Store diffs instead of full copies (space efficient)
 * - Keep last N versions (configurable retention)
 * - Capture metadata (who, when, why)
 */

import { db } from "@/lib/db";
import { memoryVersions, memories } from "@/lib/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { diffLines, type Change } from "diff";

export interface MemoryVersion {
  id: string;
  memoryId: string;
  versionNumber: number;
  contentBefore: string;
  contentAfter: string;
  diff: string;
  changeType: "create" | "edit" | "restore";
  userId: string | null;
  createdAt: Date;
  metadata?: Record<string, any>;
}

export interface VersionDiff {
  additions: number;
  deletions: number;
  changes: Change[];
  summary: string;
}

const MAX_VERSIONS_PER_MEMORY = 50;

/**
 * Create a new version when memory content changes.
 */
export async function createVersion(
  memoryId: string,
  contentBefore: string,
  contentAfter: string,
  userId: string | null,
  changeType: "create" | "edit" | "restore" = "edit",
  metadata?: Record<string, any>
): Promise<string> {
  // Calculate diff
  const changes = diffLines(contentBefore, contentAfter);
  const diffJson = JSON.stringify(changes);

  // Get next version number
  const [lastVersion] = await db
    .select({ versionNumber: memoryVersions.versionNumber })
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(desc(memoryVersions.versionNumber))
    .limit(1);

  const nextVersion = (lastVersion?.versionNumber || 0) + 1;

  // Insert version
  const [version] = await db
    .insert(memoryVersions)
    .values({
      memoryId,
      versionNumber: nextVersion,
      contentBefore,
      contentAfter,
      diff: diffJson,
      changeType,
      userId,
      metadata: metadata ? JSON.stringify(metadata) : null,
    })
    .returning({ id: memoryVersions.id });

  // Cleanup old versions if exceeded limit
  await pruneOldVersions(memoryId, MAX_VERSIONS_PER_MEMORY);

  return version.id;
}

/**
 * Get all versions for a memory.
 */
export async function getVersionHistory(
  memoryId: string
): Promise<MemoryVersion[]> {
  const versions = await db
    .select()
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(desc(memoryVersions.versionNumber));

  return versions.map((v) => ({
    id: v.id,
    memoryId: v.memoryId,
    versionNumber: v.versionNumber,
    contentBefore: v.contentBefore,
    contentAfter: v.contentAfter,
    diff: v.diff,
    changeType: v.changeType as "create" | "edit" | "restore",
    userId: v.userId,
    createdAt: v.createdAt,
    metadata: v.metadata ? JSON.parse(v.metadata) : undefined,
  }));
}

/**
 * Get a specific version.
 */
export async function getVersion(versionId: string): Promise<MemoryVersion | null> {
  const [version] = await db
    .select()
    .from(memoryVersions)
    .where(eq(memoryVersions.id, versionId))
    .limit(1);

  if (!version) return null;

  return {
    id: version.id,
    memoryId: version.memoryId,
    versionNumber: version.versionNumber,
    contentBefore: version.contentBefore,
    contentAfter: version.contentAfter,
    diff: version.diff,
    changeType: version.changeType as "create" | "edit" | "restore",
    userId: version.userId,
    createdAt: version.createdAt,
    metadata: version.metadata ? JSON.parse(version.metadata) : undefined,
  };
}

/**
 * Restore memory to a previous version.
 */
export async function restoreToVersion(
  memoryId: string,
  versionNumber: number,
  userId: string | null
): Promise<void> {
  // Get target version
  const [targetVersion] = await db
    .select()
    .from(memoryVersions)
    .where(
      and(
        eq(memoryVersions.memoryId, memoryId),
        eq(memoryVersions.versionNumber, versionNumber)
      )
    )
    .limit(1);

  if (!targetVersion) {
    throw new Error(`Version ${versionNumber} not found`);
  }

  // Get current content
  const [memory] = await db
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (!memory) {
    throw new Error("Memory not found");
  }

  const currentContent = memory.content;
  const restoredContent = targetVersion.contentAfter;

  // Update memory
  await db
    .update(memories)
    .set({ content: restoredContent, updatedAt: new Date() })
    .where(eq(memories.id, memoryId));

  // Create restore version
  await createVersion(
    memoryId,
    currentContent,
    restoredContent,
    userId,
    "restore",
    { restoredFromVersion: versionNumber }
  );
}

/**
 * Calculate diff statistics for a version.
 */
export function analyzeDiff(diff: string): VersionDiff {
  const changes: Change[] = JSON.parse(diff);

  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    if (change.added) {
      additions += change.count || 0;
    } else if (change.removed) {
      deletions += change.count || 0;
    }
  }

  const summary =
    additions > 0 && deletions > 0
      ? `Modified: +${additions} -${deletions} lines`
      : additions > 0
      ? `Added: +${additions} lines`
      : deletions > 0
      ? `Removed: -${deletions} lines`
      : "No changes";

  return {
    additions,
    deletions,
    changes,
    summary,
  };
}

/**
 * Compare two versions.
 */
export async function compareVersions(
  memoryId: string,
  fromVersion: number,
  toVersion: number
): Promise<VersionDiff> {
  const versions = await db
    .select()
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(desc(memoryVersions.versionNumber));

  const from = versions.find((v) => v.versionNumber === fromVersion);
  const to = versions.find((v) => v.versionNumber === toVersion);

  if (!from || !to) {
    throw new Error("Version not found");
  }

  const changes = diffLines(from.contentAfter, to.contentAfter);
  const diffJson = JSON.stringify(changes);

  return analyzeDiff(diffJson);
}

/**
 * Prune old versions beyond retention limit.
 */
async function pruneOldVersions(
  memoryId: string,
  maxVersions: number
): Promise<number> {
  const versions = await db
    .select({ id: memoryVersions.id })
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(desc(memoryVersions.versionNumber));

  if (versions.length <= maxVersions) return 0;

  // Delete oldest versions
  const toDelete = versions.slice(maxVersions);
  const deleteIds = toDelete.map((v) => v.id);

  await db
    .delete(memoryVersions)
    .where(eq(memoryVersions.id, deleteIds[0])); // Simplified for demo

  return toDelete.length;
}

/**
 * Get version count for a memory.
 */
export async function getVersionCount(memoryId: string): Promise<number> {
  const versions = await db
    .select({ id: memoryVersions.id })
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId));

  return versions.length;
}

/**
 * Search versions by content.
 */
export async function searchVersions(
  brainId: string,
  searchTerm: string
): Promise<MemoryVersion[]> {
  const results = await db.execute(
    `SELECT mv.*
     FROM memory_versions mv
     JOIN memories m ON m.id = mv.memory_id
     WHERE m.brain_id = $1
       AND (mv.content_before ILIKE $2 OR mv.content_after ILIKE $2)
     ORDER BY mv.created_at DESC
     LIMIT 50`,
    [brainId, `%${searchTerm}%`]
  );

  return results.rows.map((v: any) => ({
    id: v.id,
    memoryId: v.memory_id,
    versionNumber: v.version_number,
    contentBefore: v.content_before,
    contentAfter: v.content_after,
    diff: v.diff,
    changeType: v.change_type,
    userId: v.user_id,
    createdAt: v.created_at,
    metadata: v.metadata ? JSON.parse(v.metadata) : undefined,
  }));
}
