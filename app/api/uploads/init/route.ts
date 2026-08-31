import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId, resolveFolderAccess } from "@/shared/lib/auth/permissions";
import { validateCsrf, checkUserApiRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { getAdminSettings, isUploadAllowed, maxUploadBytes } from "@/shared/lib/settings/admin-settings";
import { initUpload } from "@files/infrastructure/storage/upload-service";
import { UPLOAD_RATE_MULTIPLIER } from "@files/application/commands/limits";

const encryptionMetaSchema = z.object({
  salt: z.string().min(1),
  iv: z.string().min(1),
  version: z.literal(1),
});

const schema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive().safe(),
  folderId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().min(16).max(128).optional(),
  encrypted: z.boolean().default(false),
  encryptionMeta: encryptionMetaSchema.optional(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();
    const rateLimit = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute, {
      bucket: "upload",
      multiplier: UPLOAD_RATE_MULTIPLIER,
    });
    if (!rateLimit.allowed) return apiError("Upload rate limit exceeded", 429);

    const body = schema.parse(await request.json());
    const idempotencyKey =
      body.idempotencyKey ?? request.headers.get("idempotency-key") ?? crypto.randomUUID();
    if (body.encrypted && !body.encryptionMeta) {
      return apiError("encryptionMeta required when encrypted", 400);
    }
    const policy = isUploadAllowed(body.mimeType, body.filename, settings);
    if (!policy.allowed) return apiError(policy.reason ?? "File type not allowed", 400);
    if (body.sizeBytes > maxUploadBytes(settings)) {
      return apiError(`File exceeds maximum size (${settings.maxUploadSizeMB} MB)`, 400);
    }
    if (body.folderId) {
      const access = await resolveFolderAccess(sessionUser, body.folderId);
      if (!access?.canEdit) return apiError("Folder not found", 404);
    }

    const result = await initUpload({
      userId,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      folderId: body.folderId ?? null,
      idempotencyKey,
      encrypted: body.encrypted,
      encryptionMeta: body.encryptionMeta ?? null,
      checksumSha256: body.checksumSha256,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    return apiSuccess(result, 200);
  } catch (error) {
    return handleApiError(error);
  }
}
