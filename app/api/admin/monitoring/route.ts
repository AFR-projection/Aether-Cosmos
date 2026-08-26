import { NextRequest } from "next/server";
import { desc, eq, and, isNull, ilike } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { activityLogs, users, activityActionEnum } from "@/lib/db/schema";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { validateCsrf } from "@/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/lib/api/response";

const logsSchema = z.object({
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  search: z.string().optional(),
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

    // If search is provided, filter by username or metadata on the client side is not possible
    // so we do a simple contains check on the username
    let filteredLogs = logs;
    if (params.search) {
      const searchLower = params.search.toLowerCase();
      filteredLogs = logs.filter(
        (log) =>
          log.username?.toLowerCase().includes(searchLower) ||
          log.email?.toLowerCase().includes(searchLower) ||
          log.action.toLowerCase().includes(searchLower) ||
          log.ip?.toLowerCase().includes(searchLower) ||
          JSON.stringify(log.metadata).toLowerCase().includes(searchLower)
      );
    }

    return apiSuccess({ logs: filteredLogs });
  } catch (error) {
    return handleApiError(error);
  }
}