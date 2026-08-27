/**
 * Temporal Edge Detection for Brain Graph
 *
 * Automatically detects and creates derived relationships between memories
 * based on temporal proximity (creation/modification sequence).
 *
 * Philosophy:
 * - Memories created/modified within a time window are often contextually related
 * - Temporal edges complement semantic/entity/tag-based relationships
 * - Helps reconstruct "work sessions" or "thought streams"
 *
 * Edge types:
 * - TEMPORAL_SEQUENCE: B created shortly after A (default: 5 minutes)
 * - TEMPORAL_COEDITED: A and B modified in same session (default: 10 minutes)
 * - TEMPORAL_BURST: Multiple memories created in rapid succession (default: 2 minutes)
 */

import { db } from "@/lib/db";
import { memories, memoryDerivedLinks } from "@/lib/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { derivedLinkService } from "./derived-link-service";

export interface TemporalEdgeConfig {
  /** Max time gap (ms) for TEMPORAL_SEQUENCE edges */
  sequenceWindowMs: number;
  /** Max time gap (ms) for TEMPORAL_COEDITED edges */
  coEditWindowMs: number;
  /** Max time gap (ms) for TEMPORAL_BURST edges */
  burstWindowMs: number;
  /** Minimum memories in burst to create edges */
  minBurstSize: number;
}

const DEFAULT_CONFIG: TemporalEdgeConfig = {
  sequenceWindowMs: 5 * 60 * 1000, // 5 minutes
  coEditWindowMs: 10 * 60 * 1000, // 10 minutes
  burstWindowMs: 2 * 60 * 1000, // 2 minutes
  minBurstSize: 3,
};

/**
 * Detect and create temporal sequence edges.
 * Connects memories created within sequenceWindowMs of each other.
 */
export async function detectSequenceEdges(
  brainId: string,
  config: Partial<TemporalEdgeConfig> = {}
): Promise<number> {
  const { sequenceWindowMs } = { ...DEFAULT_CONFIG, ...config };

  // Get all memories ordered by creation time
  const memories = await db.query(
    `SELECT id, created_at
     FROM memories
     WHERE brain_id = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [brainId]
  );

  let edgesCreated = 0;

  for (let i = 0; i < memories.rows.length - 1; i++) {
    const memA = memories.rows[i];
    const memB = memories.rows[i + 1];

    const timeGap =
      new Date(memB.created_at).getTime() -
      new Date(memA.created_at).getTime();

    if (timeGap <= sequenceWindowMs) {
      await derivedLinkService.createDerivedLink(
        memA.id,
        memB.id,
        "TEMPORAL_SEQUENCE",
        {
          timeGapMs: timeGap,
          sequenceIndex: i,
        }
      );
      edgesCreated++;
    }
  }

  return edgesCreated;
}

/**
 * Detect and create co-edited edges.
 * Connects memories modified within coEditWindowMs of each other.
 */
export async function detectCoEditedEdges(
  brainId: string,
  config: Partial<TemporalEdgeConfig> = {}
): Promise<number> {
  const { coEditWindowMs } = { ...DEFAULT_CONFIG, ...config };

  // Get memories with recent modifications
  const memories = await db.query(
    `SELECT id, updated_at
     FROM memories
     WHERE brain_id = $1
       AND deleted_at IS NULL
       AND updated_at > created_at + INTERVAL '1 second'
     ORDER BY updated_at ASC`,
    [brainId]
  );

  let edgesCreated = 0;

  for (let i = 0; i < memories.rows.length; i++) {
    const memA = memories.rows[i];

    // Find all memories modified within window
    for (let j = i + 1; j < memories.rows.length; j++) {
      const memB = memories.rows[j];

      const timeGap =
        new Date(memB.updated_at).getTime() -
        new Date(memA.updated_at).getTime();

      if (timeGap > coEditWindowMs) break; // No more candidates

      await derivedLinkService.createDerivedLink(
        memA.id,
        memB.id,
        "TEMPORAL_COEDITED",
        {
          timeGapMs: timeGap,
          editedAt: memA.updated_at,
        }
      );
      edgesCreated++;
    }
  }

  return edgesCreated;
}

/**
 * Detect and create burst edges.
 * Connects memories created in rapid succession (e.g., brainstorming session).
 */
export async function detectBurstEdges(
  brainId: string,
  config: Partial<TemporalEdgeConfig> = {}
): Promise<number> {
  const { burstWindowMs, minBurstSize } = { ...DEFAULT_CONFIG, ...config };

  const memories = await db.query(
    `SELECT id, created_at
     FROM memories
     WHERE brain_id = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [brainId]
  );

  let edgesCreated = 0;
  let burstStart = 0;

  while (burstStart < memories.rows.length) {
    const burst: typeof memories.rows = [];
    burst.push(memories.rows[burstStart]);

    // Collect all memories in burst window
    for (let i = burstStart + 1; i < memories.rows.length; i++) {
      const timeGap =
        new Date(memories.rows[i].created_at).getTime() -
        new Date(burst[burst.length - 1].created_at).getTime();

      if (timeGap <= burstWindowMs) {
        burst.push(memories.rows[i]);
      } else {
        break;
      }
    }

    // Create edges if burst meets minimum size
    if (burst.length >= minBurstSize) {
      for (let i = 0; i < burst.length - 1; i++) {
        for (let j = i + 1; j < burst.length; j++) {
          await derivedLinkService.createDerivedLink(
            burst[i].id,
            burst[j].id,
            "TEMPORAL_BURST",
            {
              burstSize: burst.length,
              burstStart: burst[0].created_at,
            }
          );
          edgesCreated++;
        }
      }
    }

    burstStart += burst.length || 1;
  }

  return edgesCreated;
}

/**
 * Run all temporal edge detection algorithms.
 */
export async function detectAllTemporalEdges(
  brainId: string,
  config: Partial<TemporalEdgeConfig> = {}
): Promise<{
  sequence: number;
  coEdited: number;
  burst: number;
  total: number;
}> {
  const sequence = await detectSequenceEdges(brainId, config);
  const coEdited = await detectCoEditedEdges(brainId, config);
  const burst = await detectBurstEdges(brainId, config);

  return {
    sequence,
    coEdited,
    burst,
    total: sequence + coEdited + burst,
  };
}

/**
 * Incremental update: detect temporal edges for a single new/updated memory.
 */
export async function updateTemporalEdgesForMemory(
  memoryId: string,
  config: Partial<TemporalEdgeConfig> = {}
): Promise<number> {
  const { sequenceWindowMs, coEditWindowMs } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // Get the target memory
  const result = await db.query(
    `SELECT id, brain_id, created_at, updated_at
     FROM memories
     WHERE id = $1 AND deleted_at IS NULL`,
    [memoryId]
  );

  if (result.rows.length === 0) return 0;

  const memory = result.rows[0];
  const brainId = memory.brain_id;
  let edgesCreated = 0;

  // Check for sequence edges (memories created just before/after)
  const nearbyCreated = await db.query(
    `SELECT id, created_at
     FROM memories
     WHERE brain_id = $1
       AND deleted_at IS NULL
       AND id != $2
       AND ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz))) * 1000 <= $4
     ORDER BY created_at ASC`,
    [brainId, memoryId, memory.created_at, sequenceWindowMs]
  );

  for (const nearby of nearbyCreated.rows) {
    const timeGap = Math.abs(
      new Date(nearby.created_at).getTime() -
        new Date(memory.created_at).getTime()
    );

    await derivedLinkService.createDerivedLink(
      memory.created_at < nearby.created_at ? memoryId : nearby.id,
      memory.created_at < nearby.created_at ? nearby.id : memoryId,
      "TEMPORAL_SEQUENCE",
      { timeGapMs: timeGap }
    );
    edgesCreated++;
  }

  // Check for co-edited edges (memories modified in same session)
  if (memory.updated_at > memory.created_at) {
    const nearbyEdited = await db.query(
      `SELECT id, updated_at
       FROM memories
       WHERE brain_id = $1
         AND deleted_at IS NULL
         AND id != $2
         AND updated_at > created_at
         AND ABS(EXTRACT(EPOCH FROM (updated_at - $3::timestamptz))) * 1000 <= $4
       ORDER BY updated_at ASC`,
      [brainId, memoryId, memory.updated_at, coEditWindowMs]
    );

    for (const nearby of nearbyEdited.rows) {
      const timeGap = Math.abs(
        new Date(nearby.updated_at).getTime() -
          new Date(memory.updated_at).getTime()
      );

      await derivedLinkService.createDerivedLink(
        memoryId,
        nearby.id,
        "TEMPORAL_COEDITED",
        {
          timeGapMs: timeGap,
          editedAt: memory.updated_at,
        }
      );
      edgesCreated++;
    }
  }

  return edgesCreated;
}
