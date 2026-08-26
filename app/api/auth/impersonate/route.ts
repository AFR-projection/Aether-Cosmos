import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireMaster, createSession, destroySession, getClientIp } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/audit";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";

const schema = z.object({
  userId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const master = await requireMaster();
    const { userId } = schema.parse(await request.json());

    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) return apiError("User not found", 404);
    if (target.role === "master") return apiError("Cannot impersonate master", 403);

    const ip = getClientIp(request);
    await destroySession();
    await createSession(
      master.id,
      ip,
      request.headers.get("user-agent") ?? undefined,
      target.id
    );

    await logActivity(master, "impersonate", {
      resourceType: "user",
      resourceId: target.id,
      metadata: { targetUsername: target.username },
      ip,
    });

    return apiSuccess({ message: `Now impersonating ${target.username}` });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const master = await requireMaster();
    const ip = getClientIp(request);

    await logActivity(master, "impersonate", {
      resourceType: "user",
      resourceId: master.id,
      metadata: { action: "end" },
      ip,
    });

    await destroySession();
    await createSession(master.id, ip);
    return apiSuccess({ message: "Impersonation ended" });
  } catch (error) {
    return handleApiError(error);
  }
}
