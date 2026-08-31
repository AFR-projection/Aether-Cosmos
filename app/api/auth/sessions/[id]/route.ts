import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { sessions } from "@/shared/infrastructure/db/schema";
import { requireAuth, destroySession, getClientIp } from "@/shared/lib/auth/session";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { publishToUser } from "@/shared/infrastructure/realtime/events";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();
    const { id } = await params;
    const ip = getClientIp(request);

    const [row] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
      .limit(1);

    if (!row) return apiError("Session not found", 404);

    const wasCurrent = row.id === user.sessionId;
    await db.delete(sessions).where(eq(sessions.id, id));

    if (wasCurrent) {
      await destroySession();
    }

    await logActivity(user, "session_revoked", {
      ip,
      metadata: { sessionId: id, wasCurrent },
    });
    publishToUser(user.id, {
      type: "session_revoked",
      sessionId: id,
      wasCurrent,
      reason: wasCurrent ? "revoke_current" : "revoke_one",
    }).catch(() => {});

    return apiSuccess({ wasCurrent });
  } catch (error) {
    return handleApiError(error);
  }
}
