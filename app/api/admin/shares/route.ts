import { NextRequest } from "next/server";
import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { shares, files, users } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { z } from "zod";

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "shares");
    const { searchParams } = request.nextUrl;
    const status = searchParams.get("status") ?? "all"; // all | active | expired
    const ownerId = searchParams.get("ownerId");

    const now = new Date();
    const conditions = [];
    if (ownerId) conditions.push(eq(shares.sharedBy, ownerId));
    if (status === "active") {
      conditions.push(or(isNull(shares.expiresAt), gte(shares.expiresAt, now))!);
    } else if (status === "expired") {
      conditions.push(lt(shares.expiresAt, now));
    }

    const rows = await db
      .select({
        share: shares,
        fileName: files.name,
        fileMime: files.mimeType,
        fileSize: files.sizeBytes,
        ownerUsername: users.username,
        ownerId: users.id,
      })
      .from(shares)
      .innerJoin(files, eq(shares.fileId, files.id))
      .innerJoin(users, eq(shares.sharedBy, users.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(shares.createdAt))
      .limit(500);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    return apiSuccess({
      shares: rows.map((r) => {
        const expired = r.share.expiresAt ? new Date(r.share.expiresAt) < now : false;
        const maxed =
          r.share.maxAccessCount != null && r.share.accessCount >= r.share.maxAccessCount;
        return {
          id: r.share.id,
          token: r.share.token,
          shareUrl: `${appUrl}/shared/${r.share.token}`,
          permission: r.share.permission,
          expiresAt: r.share.expiresAt,
          accessCount: r.share.accessCount,
          maxAccessCount: r.share.maxAccessCount,
          lastAccessedAt: r.share.lastAccessedAt,
          createdAt: r.share.createdAt,
          fileId: r.share.fileId,
          fileName: r.fileName,
          fileMime: r.fileMime,
          fileSize: r.fileSize,
          ownerId: r.ownerId,
          ownerUsername: r.ownerUsername,
          status: expired || maxed ? "expired" : "active",
        };
      }),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const master = await requireMasterOrApiKey(request, "shares");
    const ip = getClientIp(request);
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(200),
      })
      .parse(await request.json());

    for (const id of body.ids) {
      await db.delete(shares).where(eq(shares.id, id));
    }

    await logActivity(master, "share", {
      ip,
      metadata: { action: "admin_revoke", count: body.ids.length, ids: body.ids },
    });

    return apiSuccess({ revoked: body.ids.length });
  } catch (error) {
    return handleApiError(error);
  }
}
