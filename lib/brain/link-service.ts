import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brainEntities,
  memories,
  memoryLinks,
  type MemoryLink,
} from "@/lib/db/schema";
import { clampLimit } from "./pagination";
import {
  BrainEntityNotFoundError,
  BrainValidationError,
  MemoryNotFoundError,
} from "./errors";

/**
 * Memory-anchored links, which is what backlinks are built from (§41).
 *
 * Every function here takes brainId and folds it into the WHERE clause, and every
 * endpoint of a link is re-checked against that same brainId before the row is
 * written. That is the point: a caller who owns brain A but passes a memory id
 * from brain B gets 404, never a cross-brain edge (§88, §103.7).
 */

export type LinkTarget =
  | { targetType: "memory"; targetMemoryId: string }
  | { targetType: "entity"; targetEntityId: string };

/** One resolved link, with the far end's display fields for the UI. */
export type ResolvedLink = {
  id: string;
  linkType: string;
  direction: "outgoing" | "incoming";
  targetType: "memory" | "entity";
  /** Memory or entity id at the far end of the link. */
  nodeId: string;
  label: string;
  /** memory.type for memory targets, entity.type for entity targets. */
  nodeType: string | null;
  createdAt: Date;
};

/** Cheap sanity bound — a memory with hundreds of edges is a modelling problem. */
export const MEMORY_LINK_MAX = 100;

const LINK_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Link verbs go into responses and MCP output, so they are constrained rather than
 * free text: lowercase snake/kebab, no spaces. `relates_to`, `supersedes`, `mentions`.
 */
export function normalizeLinkType(raw: string | undefined): string {
  const value = (raw ?? "relates_to").trim().toLowerCase().replace(/\s+/g, "_");
  if (!LINK_TYPE_RE.test(value)) {
    throw new BrainValidationError(
      "linkType must be 1-64 chars of lowercase letters, digits, _ or -"
    );
  }
  return value;
}

/** Live (not soft-deleted) memory belonging to this brain, or null. */
async function findLiveMemory(brainId: string, memoryId: string) {
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(eq(memories.id, memoryId), eq(memories.brainId, brainId), isNull(memories.deletedAt))
    )
    .limit(1);
  return row ?? null;
}

async function requireLiveMemory(brainId: string, memoryId: string): Promise<string> {
  const row = await findLiveMemory(brainId, memoryId);
  if (!row) throw new MemoryNotFoundError();
  return row.id;
}

async function requireEntityInBrain(brainId: string, entityId: string): Promise<string> {
  const [row] = await db
    .select({ id: brainEntities.id })
    .from(brainEntities)
    .where(and(eq(brainEntities.id, entityId), eq(brainEntities.brainId, brainId)))
    .limit(1);
  if (!row) throw new BrainEntityNotFoundError();
  return row.id;
}

/**
 * Create (or refresh) one link. Re-linking the same pair with the same verb updates
 * metadata instead of inserting a duplicate — the partial unique indexes make that
 * atomic rather than a read-then-write race.
 */
export async function linkMemory(params: {
  brainId: string;
  sourceMemoryId: string;
  target: LinkTarget;
  linkType?: string;
  metadata?: Record<string, unknown> | null;
  principal: { userId: string; agentId: string | null };
}): Promise<MemoryLink> {
  const { brainId, target, principal } = params;
  const linkType = normalizeLinkType(params.linkType);

  const sourceMemoryId = await requireLiveMemory(brainId, params.sourceMemoryId);

  let targetMemoryId: string | null = null;
  let targetEntityId: string | null = null;

  if (target.targetType === "memory") {
    if (target.targetMemoryId === sourceMemoryId) {
      throw new BrainValidationError("A memory cannot be linked to itself");
    }
    targetMemoryId = await requireLiveMemory(brainId, target.targetMemoryId);
  } else {
    targetEntityId = await requireEntityInBrain(brainId, target.targetEntityId);
  }

  const conflictTarget =
    target.targetType === "memory"
      ? [memoryLinks.sourceMemoryId, memoryLinks.targetMemoryId, memoryLinks.linkType]
      : [memoryLinks.sourceMemoryId, memoryLinks.targetEntityId, memoryLinks.linkType];

  const [row] = await db
    .insert(memoryLinks)
    .values({
      brainId,
      sourceMemoryId,
      targetType: target.targetType,
      targetMemoryId,
      targetEntityId,
      linkType,
      metadata: params.metadata ?? null,
      createdBy: principal.userId,
      createdByAgent: principal.agentId,
    })
    .onConflictDoUpdate({
      target: conflictTarget,
      set: { metadata: params.metadata ?? null },
    })
    .returning();

  return row;
}

/** Removes one link by id, scoped to the brain so a foreign link id 404s. */
export async function unlinkMemory(params: {
  brainId: string;
  linkId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(memoryLinks)
    .where(and(eq(memoryLinks.id, params.linkId), eq(memoryLinks.brainId, params.brainId)))
    .returning({ id: memoryLinks.id });
  return deleted.length > 0;
}

/**
 * Links that start at this memory — rendered as "Related to".
 *
 * Soft-deleted memories at the far end are dropped rather than shown as dead ends;
 * the row survives so restoring the memory restores the link.
 */
export async function listOutgoingLinks(params: {
  brainId: string;
  memoryId: string;
  limit?: number;
}): Promise<ResolvedLink[]> {
  const limit = clampLimit(params.limit, MEMORY_LINK_MAX, MEMORY_LINK_MAX);

  const rows = await db
    .select({
      id: memoryLinks.id,
      linkType: memoryLinks.linkType,
      targetType: memoryLinks.targetType,
      createdAt: memoryLinks.createdAt,
      memoryId: memories.id,
      memoryTitle: memories.title,
      memoryType: memories.type,
      memoryDeletedAt: memories.deletedAt,
      entityId: brainEntities.id,
      entityName: brainEntities.name,
      entityType: brainEntities.type,
    })
    .from(memoryLinks)
    .leftJoin(memories, eq(memories.id, memoryLinks.targetMemoryId))
    .leftJoin(brainEntities, eq(brainEntities.id, memoryLinks.targetEntityId))
    .where(
      and(
        eq(memoryLinks.brainId, params.brainId),
        eq(memoryLinks.sourceMemoryId, params.memoryId)
      )
    )
    .orderBy(desc(memoryLinks.createdAt))
    .limit(limit);

  return rows.flatMap((row): ResolvedLink[] => {
    if (row.targetType === "memory") {
      if (!row.memoryId || row.memoryDeletedAt) return [];
      return [
        {
          id: row.id,
          linkType: row.linkType,
          direction: "outgoing",
          targetType: "memory",
          nodeId: row.memoryId,
          label: row.memoryTitle ?? "Untitled",
          nodeType: row.memoryType,
          createdAt: row.createdAt,
        },
      ];
    }
    if (!row.entityId) return [];
    return [
      {
        id: row.id,
        linkType: row.linkType,
        direction: "outgoing",
        targetType: "entity",
        nodeId: row.entityId,
        label: row.entityName ?? "Unnamed",
        nodeType: row.entityType,
        createdAt: row.createdAt,
      },
    ];
  });
}

/**
 * Links that point AT this memory — rendered as "Referenced by". This is the half
 * that has to come from the database: the referencing memory has no idea it is
 * being asked about, so there is nothing to parse client-side (§41).
 */
export async function listBacklinks(params: {
  brainId: string;
  memoryId: string;
  limit?: number;
}): Promise<ResolvedLink[]> {
  const limit = clampLimit(params.limit, MEMORY_LINK_MAX, MEMORY_LINK_MAX);

  const rows = await db
    .select({
      id: memoryLinks.id,
      linkType: memoryLinks.linkType,
      createdAt: memoryLinks.createdAt,
      memoryId: memories.id,
      memoryTitle: memories.title,
      memoryType: memories.type,
    })
    .from(memoryLinks)
    .innerJoin(memories, eq(memories.id, memoryLinks.sourceMemoryId))
    .where(
      and(
        eq(memoryLinks.brainId, params.brainId),
        eq(memoryLinks.targetMemoryId, params.memoryId),
        isNull(memories.deletedAt)
      )
    )
    .orderBy(desc(memoryLinks.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    linkType: row.linkType,
    direction: "incoming" as const,
    targetType: "memory" as const,
    nodeId: row.memoryId,
    label: row.memoryTitle,
    nodeType: row.memoryType,
    createdAt: row.createdAt,
  }));
}

/** Both directions in one round trip — what the memory detail page needs. */
export async function getMemoryLinks(params: {
  brainId: string;
  memoryId: string;
  limit?: number;
}): Promise<{ relatedTo: ResolvedLink[]; referencedBy: ResolvedLink[] }> {
  const [relatedTo, referencedBy] = await Promise.all([
    listOutgoingLinks(params),
    listBacklinks(params),
  ]);
  return { relatedTo, referencedBy };
}

/**
 * Entities linked from a memory, resolved to names. Used by brain_recall so an
 * agent gets "this memory is about R2 and BullMQ" without a second round trip.
 */
export async function listLinkedEntityNames(params: {
  brainId: string;
  memoryIds: string[];
  limit?: number;
}): Promise<string[]> {
  if (params.memoryIds.length === 0) return [];
  const limit = clampLimit(params.limit, 25, 25);

  const rows = await db
    .selectDistinct({ name: brainEntities.name })
    .from(memoryLinks)
    .innerJoin(brainEntities, eq(brainEntities.id, memoryLinks.targetEntityId))
    .where(
      and(
        eq(memoryLinks.brainId, params.brainId),
        inArray(memoryLinks.sourceMemoryId, params.memoryIds)
      )
    )
    .limit(limit);

  return rows.map((row) => row.name);
}

/** Whole-brain link dump for the .afrbrain export (§36). */
export async function exportMemoryLinks(brainId: string): Promise<MemoryLink[]> {
  return db
    .select()
    .from(memoryLinks)
    .where(eq(memoryLinks.brainId, brainId))
    .orderBy(memoryLinks.createdAt);
}

/** Count for the brain dashboard / export manifest. */
export async function countMemoryLinks(brainId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(memoryLinks)
    .where(eq(memoryLinks.brainId, brainId));
  return row?.total ?? 0;
}
