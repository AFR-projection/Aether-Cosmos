import { NextRequest } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { sessions, users } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { getClientIp, deviceLabelFromUa, deviceKindFromUa } from "@/shared/lib/auth/session";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { publishToUser, publishToAdmins } from "@/shared/infrastructure/realtime/events";

/**
 * Admin: revoke one session for a user, or all sessions with ?all=1.
 * Body optional: { sessionId?: string } — prefer query id via path.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const master = await requireMasterOrApiKey(request, "users");
    const { id: userId } = await params;
    const ip = getClientIp(request);
    const all = request.nextUrl.searchParams.get("all") === "1";
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) return apiError("User not found", 404);

    if (all) {
      const active = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));

      await db.delete(sessions).where(eq(sessions.userId, userId));

      await logActivity(master, "session_revoked", {
        ip,
        resourceType: "user",
        resourceId: userId,
        metadata: {
          reason: "admin_revoke_all",
          targetUsername: target.username,
          count: active.length,
        },
      });

      publishToUser(userId, {
        type: "session_revoked",
        reason: "admin_revoke_all",
        wasCurrent: true,
      }).catch(() => {});

      void publishToAdmins({ type: "user_updated", userId, at: Date.now() });

      return apiSuccess({ revoked: "all", count: active.length });
    }

    if (!sessionId) {
      return apiError("sessionId query param required (or use ?all=1)", 400);
    }

    const [row] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .limit(1);

    if (!row) return apiError("Session not found", 404);

    await db.delete(sessions).where(eq(sessions.id, sessionId));

    await logActivity(master, "session_revoked", {
      ip,
      resourceType: "user",
      resourceId: userId,
      metadata: {
        reason: "admin_revoke_one",
        targetUsername: target.username,
        sessionId,
        deviceLabel: row.deviceLabel || deviceLabelFromUa(row.userAgent),
        deviceKind: deviceKindFromUa(row.userAgent),
      },
    });

    publishToUser(userId, {
      type: "session_revoked",
      sessionId,
      reason: "admin_revoke_one",
      wasCurrent: false,
    }).catch(() => {});

    void publishToAdmins({ type: "user_updated", userId, at: Date.now() });

    return apiSuccess({ revoked: sessionId });
  } catch (error) {
    return handleApiError(error);
  }
}
