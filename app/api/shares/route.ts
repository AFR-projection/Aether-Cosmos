import { NextRequest } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { files, shares } from "@/lib/db/schema";
import { requireAuth, getClientIp } from "@/lib/auth/session";
import { resolveFileAccess, fileRefusal } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";
import { getAdminSettings, shareExpiryPolicy } from "@/lib/admin-settings";

const createSchema = z.object({
  fileId: z.string().uuid(),
  permission: z.enum(["view", "edit"]).default("view"),
  expiresInMinutes: z.number().positive().optional(),
  maxAccessCount: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = createSchema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await resolveFileAccess(sessionUser, body.fileId);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }
    // A public link takes the file out of the sharing model entirely — anyone with the URL
    // can read it, and the OWNER carries that exposure. `canView` was not enough: a member
    // invited as "view" could publish someone else's file to the whole internet.
    if (!accessible.canOwnerOnlyFlags) {
      return apiError(fileRefusal(accessible, "publish"), 403);
    }
    const file = accessible.file;

    // Public links can be switched off entirely from Admin → Settings. Existing
    // links keep working; this only stops new ones being minted.
    const settings = await getAdminSettings();
    if (!settings.publicSharingEnabled) {
      return apiError("Public share links are disabled by the administrator.", 403);
    }

    /*
     * Expiry policy. Two things used to be missing: a link with no
     * `expiresInMinutes` lived forever, and a requested expiry had no ceiling at
     * all — `z.number().positive()` accepts a century. The default now fills in
     * the blank and the ceiling caps what anyone can ask for, both from settings.
     */
    const { defaultDays, maxDays } = shareExpiryPolicy(settings);
    const maxMinutes = maxDays > 0 ? maxDays * 24 * 60 : null;
    let expiryMinutes = body.expiresInMinutes ?? (defaultDays > 0 ? defaultDays * 24 * 60 : null);
    if (maxMinutes !== null && (expiryMinutes === null || expiryMinutes > maxMinutes)) {
      expiryMinutes = maxMinutes;
    }

    const token = nanoid(32);
    const expiresAt = expiryMinutes ? new Date(Date.now() + expiryMinutes * 60000) : null;

    const [share] = await db
      .insert(shares)
      .values({
        fileId: body.fileId,
        sharedBy: sessionUser.effectiveUserId,
        token,
        permission: body.permission,
        expiresAt,
        maxAccessCount: body.maxAccessCount,
      })
      .returning();

    await logActivity(sessionUser, "share", {
      resourceType: "file",
      resourceId: body.fileId,
      metadata: { token },
      ip,
    });

    dispatchWebhookEvent(file.userId, "share", {
      fileId: body.fileId,
      name: file.name,
      shareId: share.id,
      permission: body.permission,
    }).catch(() => {});

    const shareUrl = `${process.env.NEXT_PUBLIC_APP_URL}/shared/${token}`;
    return apiSuccess({ share, shareUrl });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuth();
    const userId = sessionUser.effectiveUserId;

    const result = await db
      .select({ share: shares, file: files })
      .from(shares)
      .innerJoin(files, eq(shares.fileId, files.id))
      .where(eq(shares.sharedBy, userId))
      .orderBy(desc(shares.createdAt));

    return apiSuccess({ shares: result });
  } catch (error) {
    return handleApiError(error);
  }
}

const deleteShareSchema = z.object({
  id: z.string().uuid(),
});

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = deleteShareSchema.parse(await request.json());

    const [share] = await db.select().from(shares).where(eq(shares.id, id)).limit(1);
    if (!share) return apiError("Share not found", 404);
    if (share.sharedBy !== sessionUser.effectiveUserId && sessionUser.role !== "master") {
      return apiError("Forbidden", 403);
    }

    await db.delete(shares).where(eq(shares.id, id));
    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
