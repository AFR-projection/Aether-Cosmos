import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/shared/infrastructure/db";
import {
  brainEntities,
  brainRelationships,
  type BrainEntity,
  type BrainRelationship,
} from "@/shared/infrastructure/db/schema";
import { MEMORY_PAGE_MAX, type BrainEntityType } from "@brain/domain/constants";
import { BrainEntityNotFoundError, BrainValidationError } from "@brain/domain/errors";
import { escapeLike } from "@/shared/lib/utils";
import { clampLimit } from "@brain/domain/pagination";

/**
 * Knowledge graph over a brain: entities (nodes) and typed relationships (edges).
 *
 * Both tables carry brain_id and every query filters on it, so a caller can only
 * ever touch the graph of a brain they own (the route resolves that first).
 */

export async function listEntities(params: {
  brainId: string;
  type?: BrainEntityType;
  search?: string;
  limit?: number;
}): Promise<BrainEntity[]> {
  const conditions = [eq(brainEntities.brainId, params.brainId)];
  if (params.type) conditions.push(eq(brainEntities.type, params.type));

  const search = params.search?.trim();
  if (search) {
    // Bound as a parameter, with % and _ escaped so a wildcard typed by the user
    // is matched literally instead of turning the filter into "match everything".
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(sql`${brainEntities.name} ILIKE ${pattern} ESCAPE '\\'`);
  }

  return db
    .select()
    .from(brainEntities)
    .where(and(...conditions))
    .orderBy(asc(brainEntities.name))
    .limit(clampLimit(params.limit, 50, MEMORY_PAGE_MAX));
}

export async function requireEntity(brainId: string, entityId: string): Promise<BrainEntity> {
  const [entity] = await db
    .select()
    .from(brainEntities)
    .where(and(eq(brainEntities.id, entityId), eq(brainEntities.brainId, brainId)))
    .limit(1);
  if (!entity) throw new BrainEntityNotFoundError();
  return entity;
}

/**
 * Create or update the node for (name, type) in this brain. Extraction pipelines
 * re-see the same names constantly; upserting keeps one node per concept instead
 * of a pile of duplicates.
 */
export async function upsertEntity(params: {
  brainId: string;
  name: string;
  type?: BrainEntityType;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<BrainEntity> {
  const name = params.name.trim();
  if (!name) throw new BrainValidationError("Entity name is required");

  const [entity] = await db
    .insert(brainEntities)
    .values({
      brainId: params.brainId,
      name,
      type: params.type ?? "other",
      description: params.description?.trim() || null,
      metadata: params.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: [brainEntities.brainId, brainEntities.name, brainEntities.type],
      set: {
        description: params.description?.trim() || null,
        metadata: params.metadata ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return entity;
}

export async function updateEntity(params: {
  brainId: string;
  entityId: string;
  data: { name?: string; type?: BrainEntityType; description?: string | null; metadata?: Record<string, unknown> | null };
}): Promise<BrainEntity> {
  await requireEntity(params.brainId, params.entityId);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (params.data.name !== undefined) {
    const name = params.data.name.trim();
    if (!name) throw new BrainValidationError("Entity name cannot be empty");
    patch.name = name;
  }
  if (params.data.type !== undefined) patch.type = params.data.type;
  if (params.data.description !== undefined) {
    patch.description = params.data.description?.trim() || null;
  }
  if (params.data.metadata !== undefined) patch.metadata = params.data.metadata;

  if (Object.keys(patch).length === 1) {
    throw new BrainValidationError("No fields to update");
  }

  const [updated] = await db
    .update(brainEntities)
    .set(patch)
    .where(and(eq(brainEntities.id, params.entityId), eq(brainEntities.brainId, params.brainId)))
    .returning();

  if (!updated) throw new BrainEntityNotFoundError();
  return updated;
}

/** Deletes the node and, by cascade, every edge touching it. */
export async function deleteEntity(brainId: string, entityId: string): Promise<boolean> {
  const removed = await db
    .delete(brainEntities)
    .where(and(eq(brainEntities.id, entityId), eq(brainEntities.brainId, brainId)))
    .returning({ id: brainEntities.id });
  return removed.length > 0;
}

// ── relationships ───────────────────────────────────────────────────────────

export type RelationshipWithEntities = BrainRelationship & {
  sourceName: string;
  targetName: string;
};

export async function listRelationships(params: {
  brainId: string;
  entityId?: string;
  limit?: number;
}): Promise<RelationshipWithEntities[]> {
  const sourceEntity = alias(brainEntities, "source_entity");
  const targetEntity = alias(brainEntities, "target_entity");

  const conditions = [eq(brainRelationships.brainId, params.brainId)];
  if (params.entityId) {
    conditions.push(
      or(
        eq(brainRelationships.sourceEntityId, params.entityId),
        eq(brainRelationships.targetEntityId, params.entityId)
      )!
    );
  }

  const rows = await db
    .select({
      relationship: brainRelationships,
      sourceName: sourceEntity.name,
      targetName: targetEntity.name,
    })
    .from(brainRelationships)
    .innerJoin(sourceEntity, eq(sourceEntity.id, brainRelationships.sourceEntityId))
    .innerJoin(targetEntity, eq(targetEntity.id, brainRelationships.targetEntityId))
    .where(and(...conditions))
    .orderBy(desc(brainRelationships.confidence), asc(brainRelationships.createdAt))
    .limit(clampLimit(params.limit, 100, MEMORY_PAGE_MAX));

  return rows.map((row) => ({
    ...row.relationship,
    sourceName: row.sourceName,
    targetName: row.targetName,
  }));
}

/**
 * Link two entities. Both endpoints are re-read with the brain id attached, so a
 * relationship can never be forged between a brain the caller owns and an entity
 * belonging to somebody else's brain.
 */
export async function upsertRelationship(params: {
  brainId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  confidence?: number;
  metadata?: Record<string, unknown> | null;
}): Promise<BrainRelationship> {
  const relationshipType = params.relationshipType.trim();
  if (!relationshipType) throw new BrainValidationError("relationshipType is required");
  if (params.sourceEntityId === params.targetEntityId) {
    throw new BrainValidationError("An entity cannot be related to itself");
  }

  await Promise.all([
    requireEntity(params.brainId, params.sourceEntityId),
    requireEntity(params.brainId, params.targetEntityId),
  ]);

  const [relationship] = await db
    .insert(brainRelationships)
    .values({
      brainId: params.brainId,
      sourceEntityId: params.sourceEntityId,
      targetEntityId: params.targetEntityId,
      relationshipType,
      confidence: params.confidence ?? 0.9,
      metadata: params.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: [
        brainRelationships.sourceEntityId,
        brainRelationships.targetEntityId,
        brainRelationships.relationshipType,
      ],
      set: {
        confidence: params.confidence ?? 0.9,
        metadata: params.metadata ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return relationship;
}

export async function deleteRelationship(
  brainId: string,
  relationshipId: string
): Promise<boolean> {
  const removed = await db
    .delete(brainRelationships)
    .where(
      and(
        eq(brainRelationships.id, relationshipId),
        eq(brainRelationships.brainId, brainId)
      )
    )
    .returning({ id: brainRelationships.id });
  return removed.length > 0;
}

/** Entities + edges for the export route. */
export async function exportGraph(brainId: string): Promise<{
  entities: BrainEntity[];
  relationships: BrainRelationship[];
}> {
  const [entities, relationships] = await Promise.all([
    db
      .select()
      .from(brainEntities)
      .where(eq(brainEntities.brainId, brainId))
      .orderBy(asc(brainEntities.name)),
    db
      .select()
      .from(brainRelationships)
      .where(eq(brainRelationships.brainId, brainId))
      .orderBy(asc(brainRelationships.createdAt)),
  ]);
  return { entities, relationships };
}
