/**
 * Brain Collaboration System
 *
 * Real-time collaboration features:
 * - Track who's editing what memory
 * - Conflict detection and resolution
 * - Activity feed for brain changes
 * - Collaborative tagging and linking
 * - Presence indicators
 */

import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { eq, and, isNull, sql, gte } from "drizzle-orm";
import { redis } from "@/lib/redis";

export interface PresenceInfo {
  userId: string;
  userName: string;
  memoryId: string;
  action: "viewing" | "editing";
  timestamp: Date;
}

export interface EditLock {
  memoryId: string;
  userId: string;
  userName: string;
  lockedAt: Date;
  expiresAt: Date;
}

export interface ConflictInfo {
  memoryId: string;
  localVersion: string;
  remoteVersion: string;
  localUpdatedAt: Date;
  remoteUpdatedAt: Date;
  hasConflict: boolean;
}

const PRESENCE_TTL = 30; // seconds
const LOCK_TTL = 120; // seconds
const ACTIVITY_RETENTION = 30 * 24 * 60 * 60; // 30 days

/**
 * Set user presence on a memory.
 */
export async function setPresence(
  brainId: string,
  memoryId: string,
  userId: string,
  userName: string,
  action: "viewing" | "editing"
): Promise<void> {
  const key = `brain:${brainId}:presence:${memoryId}:${userId}`;

  await redis.setex(
    key,
    PRESENCE_TTL,
    JSON.stringify({
      userId,
      userName,
      memoryId,
      action,
      timestamp: new Date().toISOString(),
    })
  );
}

/**
 * Get all active users on a memory.
 */
export async function getMemoryPresence(
  brainId: string,
  memoryId: string
): Promise<PresenceInfo[]> {
  const pattern = `brain:${brainId}:presence:${memoryId}:*`;
  let cursor = "0";
  const presences: PresenceInfo[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;

    if (keys.length > 0) {
      const values = await redis.mget(...keys);

      for (const value of values) {
        if (value) {
          const data = JSON.parse(value);
          presences.push({
            ...data,
            timestamp: new Date(data.timestamp),
          });
        }
      }
    }
  } while (cursor !== "0");

  return presences;
}

/**
 * Acquire edit lock for a memory.
 */
export async function acquireEditLock(
  memoryId: string,
  userId: string,
  userName: string
): Promise<{ success: boolean; currentLock?: EditLock }> {
  const key = `memory:lock:${memoryId}`;

  // Check existing lock
  const existingLock = await redis.get(key);

  if (existingLock) {
    const lock: EditLock = JSON.parse(existingLock);

    // Allow same user to re-acquire
    if (lock.userId === userId) {
      await redis.setex(key, LOCK_TTL, JSON.stringify({
        ...lock,
        expiresAt: new Date(Date.now() + LOCK_TTL * 1000).toISOString(),
      }));

      return { success: true };
    }

    return {
      success: false,
      currentLock: {
        ...lock,
        lockedAt: new Date(lock.lockedAt),
        expiresAt: new Date(lock.expiresAt),
      },
    };
  }

  // Acquire lock
  const lock: EditLock = {
    memoryId,
    userId,
    userName,
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + LOCK_TTL * 1000),
  };

  await redis.setex(key, LOCK_TTL, JSON.stringify(lock));

  return { success: true };
}

/**
 * Release edit lock.
 */
export async function releaseEditLock(
  memoryId: string,
  userId: string
): Promise<void> {
  const key = `memory:lock:${memoryId}`;

  const existingLock = await redis.get(key);
  if (existingLock) {
    const lock: EditLock = JSON.parse(existingLock);

    // Only owner can release
    if (lock.userId === userId) {
      await redis.del(key);
    }
  }
}

/**
 * Check for edit conflicts.
 */
export async function checkConflict(
  memoryId: string,
  localContent: string,
  lastKnownUpdatedAt: Date
): Promise<ConflictInfo> {
  // Get current memory state
  const [memory] = await db
    .select({
      content: memories.content,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (!memory) {
    throw new Error("Memory not found");
  }

  const hasConflict =
    memory.updatedAt.getTime() > lastKnownUpdatedAt.getTime() &&
    memory.content !== localContent;

  return {
    memoryId,
    localVersion: localContent,
    remoteVersion: memory.content,
    localUpdatedAt: lastKnownUpdatedAt,
    remoteUpdatedAt: memory.updatedAt,
    hasConflict,
  };
}

/**
 * Resolve conflict with merge strategy.
 */
export async function resolveConflict(
  memoryId: string,
  resolution: "keep-local" | "keep-remote" | "merge",
  userId: string,
  mergedContent?: string
): Promise<string> {
  const [memory] = await db
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (!memory) {
    throw new Error("Memory not found");
  }

  let finalContent: string;

  switch (resolution) {
    case "keep-remote":
      finalContent = memory.content;
      break;
    case "merge":
      if (!mergedContent) {
        throw new Error("Merged content required for merge resolution");
      }
      finalContent = mergedContent;

      // Update memory with merged content
      await db
        .update(memories)
        .set({
          content: mergedContent,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, memoryId));
      break;
    case "keep-local":
    default:
      // Caller will update with local content
      finalContent = memory.content;
      break;
  }

  // Log resolution
  await logActivity(
    memoryId,
    userId,
    "conflict_resolved",
    { resolution }
  );

  return finalContent;
}

/**
 * Log collaboration activity.
 */
export async function logActivity(
  memoryId: string,
  userId: string,
  action: string,
  metadata?: Record<string, any>
): Promise<void> {
  const key = `memory:activity:${memoryId}`;

  const activity = {
    userId,
    action,
    timestamp: new Date().toISOString(),
    metadata,
  };

  // Use Redis list to store activity log
  await redis.lpush(key, JSON.stringify(activity));
  await redis.expire(key, ACTIVITY_RETENTION);
  await redis.ltrim(key, 0, 99); // Keep last 100 activities
}

/**
 * Get activity log for a memory.
 */
export async function getActivityLog(
  memoryId: string,
  limit: number = 50
): Promise<Array<{
  userId: string;
  action: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}>> {
  const key = `memory:activity:${memoryId}`;

  const activities = await redis.lrange(key, 0, limit - 1);

  return activities.map((activity) => {
    const parsed = JSON.parse(activity);
    return {
      ...parsed,
      timestamp: new Date(parsed.timestamp),
    };
  });
}

/**
 * Get recent activity across entire brain.
 */
export async function getBrainActivity(
  brainId: string,
  limit: number = 50
): Promise<Array<{
  memoryId: string;
  userId: string;
  action: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}>> {
  // Query recent memory updates from database
  const recentUpdates = await db.execute(
    sql`SELECT id, updated_at
        FROM memories
        WHERE brain_id = ${brainId}
          AND deleted_at IS NULL
          AND updated_at >= NOW() - INTERVAL '7 days'
        ORDER BY updated_at DESC
        LIMIT ${limit}`
  );

  const activities: any[] = [];

  for (const row of recentUpdates.rows as any[]) {
    const memoryActivities = await getActivityLog(row.id, 5);

    for (const activity of memoryActivities) {
      activities.push({
        memoryId: row.id,
        ...activity,
      });
    }
  }

  // Sort by timestamp and limit
  return activities
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}

/**
 * Notify collaborators of a change.
 */
export async function notifyCollaborators(
  brainId: string,
  memoryId: string,
  userId: string,
  action: string,
  message: string
): Promise<void> {
  const channel = `brain:${brainId}:notifications`;

  const notification = {
    memoryId,
    userId,
    action,
    message,
    timestamp: new Date().toISOString(),
  };

  await redis.publish(channel, JSON.stringify(notification));
}

/**
 * Subscribe to brain notifications.
 */
export async function subscribeToBrain(
  brainId: string,
  callback: (notification: any) => void
): Promise<void> {
  const channel = `brain:${brainId}:notifications`;

  // Note: This requires a separate Redis connection for pub/sub
  // Implementation depends on your Redis client setup
  // This is a simplified interface
}
