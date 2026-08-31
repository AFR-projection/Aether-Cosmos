import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memories, memoryVersions } from "@/shared/infrastructure/db/schema";

/**
 * Temporal memory: time-based intelligence over memories.
 *
 * Tracks creation, updates, access patterns, confirmation history, and validity
 * transitions. Computes decay/reinforcement signals, surfaces superseded chains,
 * and builds timelines showing how knowledge evolved.
 *
 * No memory is ever deleted due to decay — decay affects ranking and review
 * priority, never existence. The database remains the canonical record.
 */

export type TemporalMemory = {
  id: string;
  title: string;
  type: string;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
  confidence: number;
  importance: number;
  confirmationCount: number;
  lastConfirmedAt: Date | null;
  validityState: "active" | "superseded" | "stale" | "retracted";
  supersededById: string | null;
};

export type TimelineEvent = {
  timestamp: Date;
  eventType: "created" | "updated" | "accessed" | "confirmed" | "superseded" | "retracted";
  memoryId: string;
  memoryTitle: string;
  /** For 'updated' events: which version number this was. */
  version?: number;
  /** For 'superseded' events: what replaced it. */
  supersededBy?: { id: string; title: string };
  /** For 'updated' events: why the change was made. */
  changeReason?: string | null;
};

export type MemoryTimeline = {
  memoryId: string;
  memoryTitle: string;
  events: TimelineEvent[];
};

/**
 * Fetch the timeline for one memory: all creation, update, access, confirmation,
 * and validity transitions, in chronological order.
 *
 * @param db - Database connection
 * @param brainId - Brain (tenant isolation)
 * @param memoryId - Target memory
 */
export async function buildMemoryTimeline(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string
): Promise<MemoryTimeline | null> {
  // Load the memory itself.
  const [memory] = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      lastAccessedAt: memories.lastAccessedAt,
      lastConfirmedAt: memories.lastConfirmedAt,
      validityState: memories.validityState,
      supersededById: memories.supersededById,
    })
    .from(memories)
    .where(
      and(
        eq(memories.id, memoryId),
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt)
      )
    )
    .limit(1);

  if (!memory) return null;

  // Load all versions (edits).
  const versions = await db
    .select({
      versionNumber: memoryVersions.versionNumber,
      createdAt: memoryVersions.createdAt,
      changeReason: memoryVersions.changeReason,
    })
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(asc(memoryVersions.versionNumber));

  // If superseded, load the replacement memory's title.
  let supersededBy: { id: string; title: string } | undefined;
  if (memory.supersededById) {
    const [replacement] = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(and(eq(memories.id, memory.supersededById), eq(memories.brainId, brainId)))
      .limit(1);
    if (replacement) {
      supersededBy = replacement;
    }
  }

  const events: TimelineEvent[] = [];

  // Event 1: creation.
  events.push({
    timestamp: memory.createdAt,
    eventType: "created",
    memoryId: memory.id,
    memoryTitle: memory.title,
  });

  // Event 2+: updates (versions).
  for (const v of versions) {
    events.push({
      timestamp: v.createdAt,
      eventType: "updated",
      memoryId: memory.id,
      memoryTitle: memory.title,
      version: v.versionNumber,
      changeReason: v.changeReason,
    });
  }

  // Event N: last accessed (if different from updatedAt).
  if (memory.lastAccessedAt && memory.lastAccessedAt > memory.updatedAt) {
    events.push({
      timestamp: memory.lastAccessedAt,
      eventType: "accessed",
      memoryId: memory.id,
      memoryTitle: memory.title,
    });
  }

  // Event N+1: last confirmed (if present).
  if (memory.lastConfirmedAt) {
    events.push({
      timestamp: memory.lastConfirmedAt,
      eventType: "confirmed",
      memoryId: memory.id,
      memoryTitle: memory.title,
    });
  }

  // Event N+2: superseded (if present).
  if (memory.validityState === "superseded" && supersededBy) {
    // Use updatedAt as the supersession timestamp (when validityState changed).
    events.push({
      timestamp: memory.updatedAt,
      eventType: "superseded",
      memoryId: memory.id,
      memoryTitle: memory.title,
      supersededBy,
    });
  }

  // Event N+3: retracted (if present).
  if (memory.validityState === "retracted") {
    events.push({
      timestamp: memory.updatedAt,
      eventType: "retracted",
      memoryId: memory.id,
      memoryTitle: memory.title,
    });
  }

  // Sort by timestamp (chronological).
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    memoryId: memory.id,
    memoryTitle: memory.title,
    events,
  };
}

/**
 * Service wrapper using the application database connection.
 */
export function getMemoryTimeline(brainId: string, memoryId: string): Promise<MemoryTimeline | null> {
  return buildMemoryTimeline(applicationDb, brainId, memoryId);
}

/**
 * Fetch memories ordered by recency: most recently created, updated, or accessed first.
 * Use for "what's been active lately" queries.
 */
export async function getRecentMemories(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  limit = 20
): Promise<TemporalMemory[]> {
  const rows = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      lastAccessedAt: memories.lastAccessedAt,
      confidence: memories.confidence,
      importance: memories.importance,
      confirmationCount: memories.confirmationCount,
      lastConfirmedAt: memories.lastConfirmedAt,
      validityState: memories.validityState,
      supersededById: memories.supersededById,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt)
      )
    )
    .orderBy(
      desc(sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastAccessedAt}, ${memories.updatedAt}))`),
      desc(memories.createdAt)
    )
    .limit(limit);

  return rows;
}

/**
 * Fetch stale memories: active memories that haven't been updated or accessed in a long time.
 * These are candidates for review or archival.
 */
export async function getStaleMemories(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  staleDays = 180,
  limit = 50
): Promise<TemporalMemory[]> {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - staleDays);

  const rows = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      lastAccessedAt: memories.lastAccessedAt,
      confidence: memories.confidence,
      importance: memories.importance,
      confirmationCount: memories.confirmationCount,
      lastConfirmedAt: memories.lastConfirmedAt,
      validityState: memories.validityState,
      supersededById: memories.supersededById,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active"),
        lte(
          sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastAccessedAt}, ${memories.updatedAt}))`,
          threshold
        )
      )
    )
    .orderBy(
      asc(sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastAccessedAt}, ${memories.updatedAt}))`),
      desc(memories.importance)
    )
    .limit(limit);

  return rows;
}

/**
 * Fetch superseded chains: memories that were superseded, and what replaced them.
 * Returns pairs: [superseded memory, replacement memory].
 */
export async function getSupersededChains(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  limit = 30
): Promise<Array<{ superseded: TemporalMemory; replacement: TemporalMemory }>> {
  const supersededRows = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      lastAccessedAt: memories.lastAccessedAt,
      confidence: memories.confidence,
      importance: memories.importance,
      confirmationCount: memories.confirmationCount,
      lastConfirmedAt: memories.lastConfirmedAt,
      validityState: memories.validityState,
      supersededById: memories.supersededById,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        eq(memories.validityState, "superseded"),
        sql`${memories.supersededById} IS NOT NULL`
      )
    )
    .orderBy(desc(memories.updatedAt))
    .limit(limit);

  if (supersededRows.length === 0) return [];

  const replacementIds = supersededRows
    .map((row) => row.supersededById)
    .filter((id): id is string => id !== null);

  const replacementRows = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      lastAccessedAt: memories.lastAccessedAt,
      confidence: memories.confidence,
      importance: memories.importance,
      confirmationCount: memories.confirmationCount,
      lastConfirmedAt: memories.lastConfirmedAt,
      validityState: memories.validityState,
      supersededById: memories.supersededById,
    })
    .from(memories)
    .where(and(eq(memories.brainId, brainId), inArray(memories.id, replacementIds)));

  const replacementMap = new Map<string, TemporalMemory>();
  for (const row of replacementRows) {
    replacementMap.set(row.id, row);
  }

  const chains: Array<{ superseded: TemporalMemory; replacement: TemporalMemory }> = [];
  for (const superseded of supersededRows) {
    if (superseded.supersededById) {
      const replacement = replacementMap.get(superseded.supersededById);
      if (replacement) {
        chains.push({ superseded, replacement });
      }
    }
  }

  return chains;
}
