import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { files } from "@/shared/infrastructure/db/schema";
import { requireAuth } from "@/shared/lib/auth/session";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { abortMultipartUpload, deleteR2Object } from "@files/infrastructure/storage/r2";

const schema = z.object({
  fileId: z.string().uuid(),
  multipart: z
    .object({
      uploadId: z.string().min(1).max(512),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const { fileId, multipart } = schema.parse(await request.json());

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId)))
      .limit(1);

    if (!file) return apiError("File not found", 404);

    // Abort in-flight multipart upload so R2 doesn't keep orphaned parts
    if (multipart?.uploadId && file.r2Key && file.r2Key !== "pending") {
      await abortMultipartUpload(file.r2Key, multipart.uploadId).catch(() => {});
    }
    // Clean up any partially-written single-PUT object
    if (file.r2Key && file.r2Key !== "pending") {
      await deleteR2Object(file.r2Key).catch(() => {});
    }

    await db.delete(files).where(eq(files.id, fileId));
    return apiSuccess({ cancelled: true });
  } catch (error) {
    return handleApiError(error);
  }
}
