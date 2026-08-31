import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memories, memoryDerivedLinks, memoryLinks, memoryVersions } from "@/shared/infrastructure/db/schema";

/** Derived edges reported per memory. Bounded: brain_explain is a report, not a dump. */
const DERIVED_EXPLAIN_MAX = 40;

/**
 * Provenance service: explain where a memory came from and how it evolved.
 *
 * Tracks creation source (user/agent/conversation/import), authorship, confirmation
 * history, supersession chains, and the lineage of updates. Every memory carries a
 * full audit trail — this service surfaces it in one explainable package.
 */

export type MemoryProvenance = {
  memoryId: string;
  memoryTitle: string;
  memoryType: string;

  // Creation
  sourceType: string;
  sourceId: string | null;
  createdAt: Date;
  createdBy: "user" | "agent";
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;

  // Quality signals
  confidence: number;
  importance: number;
  confirmationCount: number;
  lastConfirmedAt: Date | null;
  validityState: "active" | "superseded" | "stale" | "retracted";

  // Evolution
  versionCount: number;
  lastUpdated: Date;
  lastUpdatedBy: "user" | "agent" | null;
  lastChangeReason: string | null;

  // Relationships
  supersededById: string | null;
  supersededBy: { id: string; title: string } | null;
  supersedes: Array<{ id: string; title: string }>;

  // Lineage (source memories this was derived from)
  sourceMemories: Array<{ id: string; title: string; linkType: string }>;

  /**
   * PHASE 2: relationships no human ever asserted — the scorer's own conclusions.
   *
   * Kept in a separate field from `sourceMemories` and `supersedes` on purpose. Those
   * are lineage the user or an agent stated; these are inferences, and a provenance
   * report that blurred the two would be exactly the wrong answer to "where did this
   * come from?". Each entry carries the reason, the evidence and the scorer version,
   * so a reader can audit the inference instead of taking it on faith.
   */
  derivedRelationships: Array<{
    id: string;
    title: string;
    /** `derived` (one signal family) or `inferred` (several agreed). */
    origin: "derived" | "inferred";
    /** `applied` (visible to readers) or `suggested` (below the apply threshold). */
    status: "applied" | "suggested";
    /** Dominant signal: semantic | tag | entity | project. */
    relation: string;
    weight: number;
    confidence: number;
    reason: string;
    evidence: Record<string, unknown> | null;
    /** Scorer version, e.g. "relate-v1". */
    computedBy: string;
    computedAt: Date;
  }>;
};

/**
 * Build a full provenance report for one memory.
 *
 * @param db - Database connection
 * @param brainId - Brain (tenant isolation)
 * @param memoryId - Target memory
 */
export async function explainMemoryProvenance(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryId: string
): Promise<MemoryProvenance | null> {
  // Load the memory.
  const [memory] = await db
    .select({
      id: memories.id,
      title: memories.title,
      type: memories.type,
      sourceType: memories.sourceType,
      sourceId: memories.sourceId,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      createdBy: memories.createdBy,
      createdByAgent: memories.createdByAgent,
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
        eq(memories.id, memoryId),
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt)
      )
    )
    .limit(1);

  if (!memory) return null;

  // Load agent name if created by agent.
  let createdByAgentName: string | null = null;
  if (memory.createdByAgent) {
    const [agent] = await db
      .select({ name: schema.brainAgents.name })
      .from(schema.brainAgents)
      .where(eq(schema.brainAgents.id, memory.createdByAgent))
      .limit(1);
    if (agent) createdByAgentName = agent.name;
  }

  // Load version history.
  const versions = await db
    .select({
      versionNumber: memoryVersions.versionNumber,
      createdAt: memoryVersions.createdAt,
      changedBy: memoryVersions.changedBy,
      changedByAgent: memoryVersions.changedByAgent,
      changeReason: memoryVersions.changeReason,
    })
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .orderBy(desc(memoryVersions.versionNumber))
    .limit(1);

  const lastVersion = versions[0];
  const lastUpdatedBy: "user" | "agent" | null = lastVersion
    ? lastVersion.changedBy
      ? "user"
      : lastVersion.changedByAgent
        ? "agent"
        : null
    : null;

  const versionCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryId, memoryId))
    .then((rows) => rows[0]?.count ?? 0);

  // Load supersededBy memory if present.
  let supersededBy: { id: string; title: string } | null = null;
  if (memory.supersededById) {
    const [replacement] = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(and(eq(memories.id, memory.supersededById), eq(memories.brainId, brainId)))
      .limit(1);
    if (replacement) supersededBy = replacement;
  }

  // Load memories this one supersedes (backlinks).
  const supersedes = await db
    .select({ id: memories.id, title: memories.title })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        eq(memories.supersededById, memoryId),
        isNull(memories.deletedAt)
      )
    )
    .orderBy(asc(memories.createdAt));

  // Load source memories (memories this was derived from via links with specific types).
  const sourceLinks = await db
    .select({
      targetMemoryId: memoryLinks.targetMemoryId,
      linkType: memoryLinks.linkType,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.sourceMemoryId, memoryId),
        eq(memoryLinks.targetType, "memory"),
        inArray(memoryLinks.linkType, ["derived_from", "consolidated_from", "extracted_from"])
      )
    )
    .orderBy(asc(memoryLinks.createdAt));

  const sourceMemoryIds = sourceLinks
    .map((link) => link.targetMemoryId)
    .filter((id): id is string => id !== null);

  const sourceMemories: Array<{ id: string; title: string; linkType: string }> = [];
  if (sourceMemoryIds.length > 0) {
    const sourceRows = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(and(eq(memories.brainId, brainId), inArray(memories.id, sourceMemoryIds)));

    const sourceMap = new Map(sourceRows.map((row) => [row.id, row]));
    for (const link of sourceLinks) {
      if (link.targetMemoryId) {
        const source = sourceMap.get(link.targetMemoryId);
        if (source) {
          sourceMemories.push({
            id: source.id,
            title: source.title,
            linkType: link.linkType,
          });
        }
      }
    }
  }

  // PHASE 2: algorithmic inferences about this memory. Both statuses are reported —
  // brain_explain is an audit surface, and "the scorer suspected this but did not
  // apply it" is information a reader auditing the graph wants.
  const derivedRows = await db
    .select()
    .from(memoryDerivedLinks)
    .where(
      and(
        eq(memoryDerivedLinks.brainId, brainId),
        or(
          eq(memoryDerivedLinks.sourceMemoryId, memoryId),
          eq(memoryDerivedLinks.targetMemoryId, memoryId)
        )
      )
    )
    .orderBy(desc(memoryDerivedLinks.weight), asc(memoryDerivedLinks.id))
    .limit(DERIVED_EXPLAIN_MAX);

  const derivedRelationships: MemoryProvenance["derivedRelationships"] = [];
  if (derivedRows.length > 0) {
    const otherIds = derivedRows.map((row) =>
      row.sourceMemoryId === memoryId ? row.targetMemoryId : row.sourceMemoryId
    );
    const otherRows = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          inArray(memories.id, otherIds),
          isNull(memories.deletedAt)
        )
      );
    const otherMap = new Map(otherRows.map((row) => [row.id, row.title]));

    for (const row of derivedRows) {
      const otherId = row.sourceMemoryId === memoryId ? row.targetMemoryId : row.sourceMemoryId;
      const title = otherMap.get(otherId);
      // A missing title means the other endpoint was deleted or belongs to another
      // brain: report nothing rather than a dangling id.
      if (title === undefined) continue;

      derivedRelationships.push({
        id: otherId,
        title,
        origin: row.origin,
        status: row.status,
        relation: row.relation,
        weight: row.weight,
        confidence: row.confidence,
        reason: row.reason,
        evidence: (row.evidence as Record<string, unknown> | null) ?? null,
        computedBy: row.computedBy,
        computedAt: row.updatedAt,
      });
    }
  }

  return {
    memoryId: memory.id,
    memoryTitle: memory.title,
    memoryType: memory.type,
    sourceType: memory.sourceType,
    sourceId: memory.sourceId,
    createdAt: memory.createdAt,
    createdBy: memory.createdBy ? "user" : memory.createdByAgent ? "agent" : "user",
    createdByUserId: memory.createdBy,
    createdByAgentId: memory.createdByAgent,
    createdByAgentName,
    confidence: memory.confidence,
    importance: memory.importance,
    confirmationCount: memory.confirmationCount,
    lastConfirmedAt: memory.lastConfirmedAt,
    validityState: memory.validityState,
    versionCount,
    lastUpdated: memory.updatedAt,
    lastUpdatedBy,
    lastChangeReason: lastVersion?.changeReason ?? null,
    supersededById: memory.supersededById,
    supersededBy,
    supersedes,
    sourceMemories,
    derivedRelationships,
  };
}

/**
 * Service wrapper using the application database connection.
 */
export function getMemoryProvenance(brainId: string, memoryId: string): Promise<MemoryProvenance | null> {
  return explainMemoryProvenance(applicationDb, brainId, memoryId);
}
