import { NextRequest } from "next/server";
import { desc, eq, and, ilike, gte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { activityLogs, users, activityActionEnum } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { validateCsrf } from "@/shared/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";

const logsSchema = z.object({
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  search: z.string().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function POST(request: NextRequest) {
  try {
    // POST-as-query: no state changes, but it reads the whole audit trail, so it
    // gets the same gate as every other privileged POST in the app.
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "monitoring");
    const params = logsSchema.parse(await request.json());

    const conditions = [];
    if (params.userId) conditions.push(eq(activityLogs.userId, params.userId));
    if (params.action)
      conditions.push(
        eq(activityLogs.action, params.action as (typeof activityActionEnum.enumValues)[number])
      );
    if (params.since) conditions.push(gte(activityLogs.createdAt, new Date(params.since)));

    // Search belongs in SQL, before LIMIT/OFFSET. The old in-memory pass searched
    // only the newest page, which silently hid valid older matches.
    const search = params.search?.trim();
    if (search) {
      const pattern = `%${search}%`;
      const searchCondition = or(
        ilike(users.username, pattern),
        ilike(users.email, pattern),
        ilike(activityLogs.ip, pattern),
        sql`${activityLogs.action}::text ilike ${pattern}`,
        sql`coalesce(${activityLogs.metadata}::text, '') ilike ${pattern}`
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    const logs = await db
      .select({
        id: activityLogs.id,
        userId: activityLogs.userId,
        action: activityLogs.action,
        resourceType: activityLogs.resourceType,
        resourceId: activityLogs.resourceId,
        metadata: activityLogs.metadata,
        ip: activityLogs.ip,
        createdAt: activityLogs.createdAt,
        username: users.username,
        email: users.email,
        userRole: users.role,
      })
      .from(activityLogs)
      .innerJoin(users, eq(activityLogs.userId, users.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(activityLogs.createdAt))
      .limit(params.limit)
      .offset(params.offset);

    return apiSuccess({ logs, serverTime: Date.now() });
  } catch (error) {
    return handleApiError(error);
  }
}
