import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { getClientIp } from "@/lib/auth/session";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { completeUpload, getUpload, type UploadPartInput } from "@/lib/storage/upload-service";
import { enqueueJob } from "@/lib/queue";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";
import { publishToUser } from "@/lib/realtime/events";
import { logActivity } from "@/lib/auth/audit";

const schema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  parts: z.array(z.object({
    partNumber: z.number().int().positive(),
    etag: z.string().min(1).max(512),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  })).max(10_000).default([]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const userId = getEffectiveUserId(sessionUser);
    const { id } = await params;
    const body = schema.parse(await request.json());
    const before = await getUpload(id, userId);
    const result = await completeUpload(id, userId, body.parts as UploadPartInput[], body.checksumSha256);

    if (before.status !== "completed" && before.fileStatus !== "ready") {
      const after = await getUpload(id, userId);
      if (!after.mimeType.startsWith("application/octet-stream") &&
        (after.mimeType.startsWith("image/") || after.mimeType.startsWith("video/") || after.mimeType === "application/pdf" || after.mimeType.startsWith("audio/"))) {
        await enqueueJob("generate_thumbnail", { fileId: after.fileId, r2Key: after.objectKey, mimeType: after.mimeType });
      }
      void dispatchWebhookEvent(userId, "upload", { fileId: after.fileId, name: after.name, sizeBytes: after.totalSizeBytes, mimeType: after.mimeType });
      void publishToUser(userId, { type: "upload_complete", fileId: after.fileId, name: after.name, sizeBytes: after.totalSizeBytes });
      await logActivity(sessionUser, "upload", { resourceType: "file", resourceId: after.fileId, metadata: { uploadSessionId: id, verified: true }, ip: getClientIp(request) });
    }
    return apiSuccess(result);
  } catch (error) {
    return handleApiError(error);
  }
}
