import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { files, users } from "@/shared/infrastructure/db/schema";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId, resolveFolderAccess } from "@/shared/lib/auth/permissions";
import {
  buildR2Key,
  getPresignedUploadUrl,
  MULTIPART_THRESHOLD_BYTES,
  createMultipartUpload,
  type MultipartPresign,
} from "@files/infrastructure/storage/r2";
import { validateCsrf, checkUserApiRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { getAdminSettings, isUploadAllowed, maxUploadBytes } from "@/shared/lib/settings/admin-settings";
import { UPLOAD_RATE_MULTIPLIER } from "@files/application/commands/limits";

const encryptionMetaSchema = z.object({
  salt: z.string().min(1),
  iv: z.string().min(1),
  version: z.literal(1),
});

const itemSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  folderId: z.string().uuid().nullable().optional(),
  encrypted: z.boolean().optional(),
  encryptionMeta: encryptionMetaSchema.optional(),
  clientId: z.string().max(64).optional(),
});

const schema = z.object({
  files: z.array(itemSchema).min(1).max(50),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();

    const rateLimit = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute, {
      bucket: "upload",
      multiplier: UPLOAD_RATE_MULTIPLIER,
    });
    if (!rateLimit.allowed) return apiError("Upload rate limit exceeded", 429);

    const body = schema.parse(await request.json());
    const maxSize = maxUploadBytes(settings);

    for (const item of body.files) {
      if (item.encrypted && !item.encryptionMeta) {
        return apiError("encryptionMeta required when encrypted", 400);
      }
      const policy = isUploadAllowed(item.mimeType, item.filename, settings);
      if (!policy.allowed) {
        return apiError(policy.reason ?? `File type not allowed: ${item.filename}`, 400);
      }
      if (item.sizeBytes > maxSize) {
        return apiError(
          `File exceeds maximum size (${settings.maxUploadSizeMB} MB): ${item.filename}`,
          400
        );
      }
    }

    const folderIds = [
      ...new Set(
        body.files
          .map((f) => f.folderId)
          .filter((id): id is string => typeof id === "string")
      ),
    ];
    for (const folderId of folderIds) {
      const access = await resolveFolderAccess(sessionUser, folderId);
      if (!access?.canEdit) return apiError("Folder not found", 404);
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return apiError("User not found", 404);

    const totalBytes = body.files.reduce((s, f) => s + f.sizeBytes, 0);
    if (user.usedBytes + totalBytes > user.quotaBytes) {
      return apiError("Storage quota exceeded for this batch", 400);
    }

    const results: {
      clientId?: string;
      fileId: string;
      r2Key: string;
      uploadUrl?: string;
      multipart?: MultipartPresign;
    }[] = [];

    for (const item of body.files) {
      const mime = item.encrypted ? "application/octet-stream" : item.mimeType;
      const [file] = await db
        .insert(files)
        .values({
          userId,
          folderId: item.folderId ?? null,
          name: item.filename,
          mimeType: mime,
          sizeBytes: item.sizeBytes,
          r2Key: "pending",
          checksumSha256: null,
          encrypted: item.encrypted ?? false,
          encryptionMeta: item.encryptionMeta ?? null,
        })
        .returning();

      const r2Key = buildR2Key(userId, file.id, item.filename);
      await db.update(files).set({ r2Key }).where(eq(files.id, file.id));

      if (item.sizeBytes >= MULTIPART_THRESHOLD_BYTES) {
        const multipart = await createMultipartUpload(r2Key, mime, item.sizeBytes);
        results.push({
          clientId: item.clientId,
          fileId: file.id,
          r2Key,
          multipart,
        });
      } else {
        const uploadUrl = await getPresignedUploadUrl(r2Key, mime, item.sizeBytes);
        results.push({
          clientId: item.clientId,
          fileId: file.id,
          r2Key,
          uploadUrl,
        });
      }
    }

    return apiSuccess({ uploads: results });
  } catch (error) {
    return handleApiError(error);
  }
}
