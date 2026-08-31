import { NextRequest } from "next/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { sessions } from "@/shared/infrastructure/db/schema";
import {
  requireAuth,
  destroySession,
  getClientIp,
  deviceLabelFromUa,
  deviceKindFromUa,
} from "@/shared/lib/auth/session";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { publishToUser, publishToAdmins } from "@/shared/infrastructure/realtime/events";

function truncateId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function mapSessionRow(
  s: typeof sessions.$inferSelect,
  currentSessionId: string
) {
  return {
    id: s.id,
    idShort: truncateId(s.id),
    ip: s.ip,
    userAgent: s.userAgent,
    deviceLabel: s.deviceLabel || deviceLabelFromUa(s.userAgent),
    deviceKind: deviceKindFromUa(s.userAgent),
    locationLabel: s.locationLabel,
    locationCity: s.locationCity,
    locationCountry: s.locationCountry,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    expiresAt: s.expiresAt,
    isCurrent: s.id === currentSessionId,
  };
}

export async function GET() {
  try {
    const user = await requireAuth();
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastActiveAt));

    return apiSuccess({
      currentSessionId: user.sessionId,
      sessions: rows.map((s) => mapSessionRow(s, user.sessionId)),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** DELETE without id: revoke other sessions. ?all=1 revokes all including current. */
export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();
    const all = request.nextUrl.searchParams.get("all") === "1";
    const ip = getClientIp(request);

    if (all) {
      await db.delete(sessions).where(eq(sessions.userId, user.id));
      await destroySession();
      await logActivity(user, "session_revoked", {
        ip,
        metadata: { reason: "revoke_all" },
      });
      publishToUser(user.id, {
        type: "session_revoked",
        reason: "revoke_all",
        wasCurrent: true,
      }).catch(() => {});
      void publishToAdmins({ type: "user_updated", userId: user.id, at: Date.now() });
      return apiSuccess({ revoked: "all" });
    }

    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), ne(sessions.id, user.sessionId)));

    await logActivity(user, "session_revoked", {
      ip,
      metadata: { reason: "revoke_others" },
    });
    publishToUser(user.id, {
      type: "session_revoked",
      reason: "revoke_others",
      wasCurrent: false,
    }).catch(() => {});
    void publishToAdmins({ type: "user_updated", userId: user.id, at: Date.now() });

    return apiSuccess({ revoked: "others" });
  } catch (error) {
    return handleApiError(error);
  }
}
