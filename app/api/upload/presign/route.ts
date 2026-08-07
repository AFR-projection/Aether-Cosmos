import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { files, users } from "@/lib/db/schema";
import { getClientIp } from "@/lib/auth/session";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId, resolveFolderAccess } from "@/lib/auth/permissions";
import {
  buildR2Key,
  getPresignedUploadUrl,
} from "@/lib/storage/r2";
import { validateCsrf, checkUserApiRateLimit } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { getAdminSettings, isUploadAllowed, maxUploadBytes } from "@/lib/admin-settings";
import { UPLOAD_RATE_MULTIPLIER } from "@/lib/upload/limits";

const encryptionMetaSchema = z.object({
  salt: z.string().min(1),
  iv: z.string().min(1),
  version: z.literal(1),
});

const schema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  folderId: z.string().uuid().nullable().optional(),
  encrypted: z.boolean().optional(),
  encryptionMeta: encryptionMetaSchema.optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const userId = getEffectiveUserId(sessionUser);
    const ip = getClientIp(request);
    const settings = await getAdminSettings();

    const rateLimit = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute, {
      bucket: "upload",
      multiplier: UPLOAD_RATE_MULTIPLIER,
    });
    if (!rateLimit.allowed) return apiError("Upload rate limit exceeded", 429);

    const body = schema.parse(await request.json());

    if (body.encrypted && !body.encryptionMeta) {
      return apiError("encryptionMeta required when encrypted", 400);
    }

    const policy = isUploadAllowed(body.mimeType, body.filename, settings);
    if (!policy.allowed) {
      return apiError(policy.reason ?? "File type not allowed", 400);
    }

    if (body.sizeBytes > maxUploadBytes(settings)) {
      return apiError(
        `File exceeds maximum size (${settings.maxUploadSizeMB} MB)`,
        400
      );
    }

    if (body.folderId) {
      const access = await resolveFolderAccess(sessionUser, body.folderId);
      if (!access?.canEdit) return apiError("Folder not found", 404);
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return apiError("User not found", 404);

    if (user.usedBytes + body.sizeBytes > user.quotaBytes) {
      return apiError("Storage quota exceeded", 400);
    }

    const [file] = await db
      .insert(files)
      .values({
        userId,
        folderId: body.folderId ?? null,
        name: body.filename,
        mimeType: body.encrypted ? "application/octet-stream" : body.mimeType,
        sizeBytes: body.sizeBytes,
        r2Key: "pending",
        checksumSha256: null,
        encrypted: body.encrypted ?? false,
        encryptionMeta: body.encryptionMeta ?? null,
      })
      .returning();

    const r2Key = buildR2Key(userId, file.id, body.filename);
    await db.update(files).set({ r2Key }).where(eq(files.id, file.id));

    const uploadUrl = await getPresignedUploadUrl(
      r2Key,
      body.encrypted ? "application/octet-stream" : body.mimeType,
      body.sizeBytes
    );

    void ip;

    return apiSuccess({
      fileId: file.id,
      uploadUrl,
      r2Key,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
