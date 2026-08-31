import { and, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { activityScopes } from "@/shared/infrastructure/db/schema";

export type ActivityScope = typeof activityScopes.$inferSelect;

/** Get or create the one account-owned scope used by the Activity Center. */
export async function getOrCreateActivityScope(ownerUserId: string): Promise<ActivityScope> {
  const existing = await getActivityScopeForUser(ownerUserId);
  if (existing) {
    await db
      .update(activityScopes)
      .set({ lastActiveAt: new Date() })
      .where(eq(activityScopes.id, existing.id));
    return { ...existing, lastActiveAt: new Date() };
  }

  await db
    .insert(activityScopes)
    .values({ ownerUserId })
    .onConflictDoNothing({ target: activityScopes.ownerUserId });

  const created = await getActivityScopeForUser(ownerUserId);
  if (!created) throw new Error("Unable to create activity scope");
  return created;
}

export async function getActivityScopeForUser(ownerUserId: string): Promise<ActivityScope | null> {
  const [scope] = await db
    .select()
    .from(activityScopes)
    .where(and(eq(activityScopes.ownerUserId, ownerUserId), eq(activityScopes.status, "active")))
    .limit(1);
  return scope ?? null;
}

/** Ownership check for opaque IDs supplied by the browser. */
export async function getOwnedActivityScope(scopeId: string, ownerUserId: string): Promise<ActivityScope | null> {
  const [scope] = await db
    .select()
    .from(activityScopes)
    .where(
      and(
        eq(activityScopes.id, scopeId),
        eq(activityScopes.ownerUserId, ownerUserId),
        eq(activityScopes.status, "active")
      )
    )
    .limit(1);
  return scope ?? null;
}
