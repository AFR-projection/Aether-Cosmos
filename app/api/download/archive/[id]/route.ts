import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { archiveJobs } from "@/shared/infrastructure/db/schema";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { getPresignedDownloadUrl, headObject } from "@files/infrastructure/storage/r2";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuthOrApiKey(_request, ["download"]);
    const userId = getEffectiveUserId(sessionUser);
    const { id } = await params;
    const [job] = await db
      .select()
      .from(archiveJobs)
      .where(and(eq(archiveJobs.id, id), eq(archiveJobs.userId, userId)))
      .limit(1);

    if (!job) return apiError("Archive job not found", 404);
    if (job.status === "ready") {
      try {
        const object = await headObject(job.objectKey);
        if (object.contentLength <= 0) {
          return apiError("Archive object is invalid", 409);
        }
      } catch {
        return apiError("Archive object is missing", 409);
      }

      const downloadUrl = await getPresignedDownloadUrl(job.objectKey, {
        downloadName: job.archiveName,
        contentType: "application/zip",
      });
      return apiSuccess({ job, downloadUrl });
    }

    return apiSuccess({ job });
  } catch (error) {
    return handleApiError(error);
  }
}
