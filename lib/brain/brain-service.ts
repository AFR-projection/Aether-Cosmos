import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { brainAccess, brains, memories, type Brain } from "@/lib/db/schema";
import { BrainConflictError, BrainNotFoundError } from "./errors";

export { BrainNotFoundError };

/** Cap so a single account cannot spray brains (each one cascades a lot of rows). */
export const MAX_BRAINS_PER_USER = 25;

/**
 * The user's default brain, created on first use.
 *
 * Race-safe: `brains_owner_default_unique` is a partial unique index on
 * (owner_user_id) WHERE is_default, so two concurrent first-time requests cannot
 * both insert — the loser's ON CONFLICT DO NOTHING returns no row and it re-reads
 * the winner's brain.
 */
export async function getOrCreateDefaultBrain(userId: string): Promise<Brain> {
  const existing = await findDefaultBrain(userId);
  if (existing) return existing;

  const [created] = await db
    .insert(brains)
    .values({ ownerUserId: userId, name: "Personal Brain", isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const raced = await findDefaultBrain(userId);
  if (!raced) throw new BrainNotFoundError();
  return raced;
}

async function findDefaultBrain(userId: string): Promise<Brain | null> {
  const [row] = await db
    .select()
    .from(brains)
    .where(and(eq(brains.ownerUserId, userId), eq(brains.isDefault, true)))
    .limit(1);
  return row ?? null;
}

export async function getBrainForUser(brainId: string, userId: string): Promise<Brain | null> {
  const [brain] = await db
    .select()
    .from(brains)
    .where(and(eq(brains.id, brainId), eq(brains.ownerUserId, userId)))
    .limit(1);
  return brain ?? null;
}

export async function requireBrainForUser(brainId: string, userId: string): Promise<Brain> {
  const brain = await getBrainForUser(brainId, userId);
  if (!brain) throw new BrainNotFoundError();
  return brain;
}

/** Default brain first, then oldest → newest, so the list order is stable. */
export async function listBrains(userId: string): Promise<Brain[]> {
  return db
    .select()
    .from(brains)
    .where(eq(brains.ownerUserId, userId))
    .orderBy(desc(brains.isDefault), asc(brains.createdAt));
}

export async function createBrain(
  userId: string,
  data: { name: string; description?: string }
): Promise<Brain> {
  const [existing] = await db
    .select({ total: count() })
    .from(brains)
    .where(eq(brains.ownerUserId, userId));

  if ((existing?.total ?? 0) >= MAX_BRAINS_PER_USER) {
    throw new BrainConflictError(`Maximum ${MAX_BRAINS_PER_USER} brains allowed`);
  }

  const [brain] = await db
    .insert(brains)
    .values({
      ownerUserId: userId,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      isDefault: false,
    })
    .returning();
  return brain;
}

export async function updateBrain(
  brainId: string,
  userId: string,
  data: { name?: string; description?: string | null; status?: Brain["status"] }
): Promise<Brain> {
  await requireBrainForUser(brainId, userId);

  const patch: Partial<Brain> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name.trim();
  if (data.description !== undefined) {
    patch.description = data.description === null ? null : data.description.trim() || null;
  }
  if (data.status !== undefined) patch.status = data.status;

  const [updated] = await db
    .update(brains)
    .set(patch)
    .where(and(eq(brains.id, brainId), eq(brains.ownerUserId, userId)))
    .returning();

  if (!updated) throw new BrainNotFoundError();
  return updated;
}

/**
 * Hard-delete a brain and everything under it (memories, versions, tags, graph,
 * audit trail) via ON DELETE CASCADE. The default brain is protected — there has
 * to be somewhere for new memories to land.
 */
export async function deleteBrain(brainId: string, userId: string): Promise<void> {
  const brain = await requireBrainForUser(brainId, userId);
  if (brain.isDefault) {
    throw new BrainConflictError("The default brain cannot be deleted");
  }
  await db.delete(brains).where(and(eq(brains.id, brainId), eq(brains.ownerUserId, userId)));
}

export async function getBrainStats(brainId: string): Promise<{
  memoryCount: number;
  archivedCount: number;
  agentCount: number;
}> {
  const [[live], [archived], [agents]] = await Promise.all([
    db
      .select({ total: count() })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          isNull(memories.deletedAt),
          isNull(memories.archivedAt)
        )
      ),
    db
      .select({ total: count() })
      .from(memories)
      .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt))),
    db
      .select({ total: count() })
      .from(brainAccess)
      .where(and(eq(brainAccess.brainId, brainId), eq(brainAccess.principalType, "agent"))),
  ]);

  const total = archived?.total ?? 0;
  const liveCount = live?.total ?? 0;
  return {
    memoryCount: liveCount,
    archivedCount: Math.max(0, total - liveCount),
    agentCount: agents?.total ?? 0,
  };
}
