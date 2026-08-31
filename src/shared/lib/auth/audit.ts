import { db } from "@/shared/infrastructure/db";
import { activityLogs, type User } from "@/shared/infrastructure/db/schema";
import { getOrCreateActivityScope } from "@/shared/lib/activity/activity-scope-server";
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
}
