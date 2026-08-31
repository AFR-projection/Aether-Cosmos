import { db } from "@/shared/infrastructure/db";
import { activityLogs, activityActionEnum } from "@/shared/infrastructure/db/schema";
import { getOrCreateActivityScope } from "@/shared/lib/activity/activity-scope-server";
import { desc, eq, and, gte, count } from "drizzle-orm";

export interface SuspiciousActivityResult {
  suspicious: boolean;
  reason?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}

const FAILED_LOGIN_THRESHOLD = 10;
const RAPID_UPLOAD_THRESHOLD = 50;
const UNUSUAL_HOUR_START = 2;
const UNUSUAL_HOUR_END = 5;

export async function checkSuspiciousActivity(
  userId: string,
  action: string,
  ip: string
): Promise<SuspiciousActivityResult> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Check rapid failed login attempts (for login action)
    if (action === "login") {
      const [recentFailed] = await db
        .select({ count: count() })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.userId, userId),
            eq(activityLogs.action, "login"),
            gte(activityLogs.createdAt, oneHourAgo)
          )
        );

      if (recentFailed.count >= FAILED_LOGIN_THRESHOLD) {
        return {
          suspicious: true,
          reason: `Excessive login attempts: ${recentFailed.count} in the last hour`,
          riskLevel: "high",
        };
      }
    }

    // Check rapid uploads (potential abuse)
    if (action === "upload") {
      const [recentUploads] = await db
        .select({ count: count() })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.userId, userId),
            eq(activityLogs.action, "upload"),
            gte(activityLogs.createdAt, oneHourAgo)
          )
        );

      if (recentUploads.count >= RAPID_UPLOAD_THRESHOLD) {
        return {
          suspicious: true,
          reason: `Rapid upload activity: ${recentUploads.count} uploads in the last hour`,
          riskLevel: "medium",
        };
      }
    }

    // Check unusual hours (2 AM - 5 AM)
    const currentHour = new Date().getHours();
    if (currentHour >= UNUSUAL_HOUR_START && currentHour <= UNUSUAL_HOUR_END) {
      const [recentActivity] = await db
        .select({ count: count() })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.userId, userId),
            gte(activityLogs.createdAt, oneDayAgo)
          )
        );

      if (recentActivity.count <= 2) {
        return {
          suspicious: true,
          reason: "Activity during unusual hours with low recent activity",
          riskLevel: "low",
        };
      }
    }

    // Check IP change (simplified - just flag if IP changed recently)
    const [lastActivity] = await db
      .select({ ip: activityLogs.ip })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.userId, userId),
          gte(activityLogs.createdAt, oneDayAgo)
        )
      )
      .orderBy(desc(activityLogs.createdAt))
      .limit(1);

    if (lastActivity?.ip && lastActivity.ip !== ip && lastActivity.ip !== "unknown") {
      return {
        suspicious: true,
        reason: "IP address changed from recent activity",
        riskLevel: "low",
      };
    }

    return { suspicious: false, riskLevel: "low" };
  } catch {
    // Don't block operations if detection fails
    return { suspicious: false, riskLevel: "low" };
  }
}

export async function logSuspiciousActivity(
  userId: string,
  action: string,
  reason: string,
  ip: string
): Promise<void> {
  try {
    const scope = await getOrCreateActivityScope(userId);
    await db.insert(activityLogs).values({
      userId,
      activityScopeId: scope.id,
      action: action as (typeof activityActionEnum.enumValues)[number],
      resourceType: "security",
      metadata: {
        suspicious: true,
        reason,
        detectedAt: new Date().toISOString(),
      },
      ip,
    });
  } catch {
    // Silent fail for security logging
  }
}
