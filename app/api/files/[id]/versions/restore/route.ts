import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, getEffectiveUserId, fileRefusal } from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { restoreFileVersion } from "@files/application/commands/versions";
import { enqueueJob } from "@/shared/infrastructure/queue";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";

const schema = z.object({
  version: z.number().int().positive(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const body = schema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible) return apiError("File not found", 404);
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);

    const restored = await restoreFileVersion(
      accessible.file,
      body.version,
      getEffectiveUserId(sessionUser)
    );

    cacheDelPattern(`files:${accessible.file.userId}:*`).catch(() => {});

    if (
      restored.mimeType.startsWith("image/") ||
      restored.mimeType.startsWith("video/") ||
      restored.mimeType === "application/pdf" ||
      restored.mimeType.startsWith("audio/")
    ) {
      await enqueueJob("generate_thumbnail", {
        fileId: restored.id,
        r2Key: restored.r2Key,
        mimeType: restored.mimeType,
      });
    }

    await logActivity(sessionUser, "restore", {
      resourceType: "file",
      resourceId: id,
      metadata: { version: body.version },
      ip,
    });

    return apiSuccess({ file: restored });
  } catch (error) {
    if (error instanceof Error && error.message === "Version not found") {
      return apiError("Version not found", 404);
    }
    return handleApiError(error);
  }
}
