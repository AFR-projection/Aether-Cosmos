import { db } from "@/shared/infrastructure/db";
import { activityLogs, type User } from "@/shared/infrastructure/db/schema";
import { getOrCreateActivityScope } from "@/shared/lib/activity/activity-scope-server";
import { publishToAdmins } from "@/shared/infrastructure/realtime/events";
import type { SessionUser } from "./session";

type ActivityAction = typeof activityLogs.$inferInsert["action"];

export async function logActivity(
  user: SessionUser | User,
  action: ActivityAction,
  options?: {
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
  }
): Promise<void> {
  const ownerUserId = "effectiveUserId" in user ? user.effectiveUserId : user.id;
  const scope = await getOrCreateActivityScope(ownerUserId);
  await db.insert(activityLogs).values({
    userId: ownerUserId,
    activityScopeId: scope.id,
    action,
    resourceType: options?.resourceType,
    resourceId: options?.resourceId,
    metadata: options?.metadata,
    ip: options?.ip,
  });

  // The row is committed before the signal is sent. Admin clients always refetch
  // from the database, so a dropped/replayed pub-sub message cannot create drift.
  // Publishing is best-effort: audit writes must never fail because Redis/SSE is
  // temporarily unavailable (the logs screen keeps a polling fallback).
  void publishToAdmins({
    type: "activity_log_created",
    userId: ownerUserId,
    action,
    at: Date.now(),
  }).catch(() => {});
}
