import { NextRequest } from "next/server";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getClientIp } from "@/lib/auth/session";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import {
  objectExists,
  downloadFromR2Bytes,
  completeMultipartUpload,
  abortMultipartUpload,
} from "@/lib/storage/r2";
import { validateCsrf, checkUserApiRateLimit } from "@/lib/security";
import { validateFileMagicBytes } from "@/lib/security/file-validation";
import { enqueueJob } from "@/lib/queue";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { recalculateUsedBytes } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";
import { publishToUser } from "@/lib/realtime/events";
import { getAdminSettings } from "@/lib/admin-settings";
import { UPLOAD_RATE_MULTIPLIER } from "@/lib/upload/limits";

const encryptionMetaSchema = z.object({
  salt: z.string().min(1),
  iv: z.string().min(1),
  version: z.literal(1),
});

const itemSchema = z.object({
  fileId: z.string().uuid(),
  checksumSha256: z.string().optional(),
  encrypted: z.boolean().optional(),
  encryptionMeta: encryptionMetaSchema.optional(),
  originalMimeType: z.string().optional(),
  multipart: z
    .object({
      uploadId: z.string().min(1),
      parts: z
        .array(
          z.object({
            partNumber: z.number().int().positive(),
            etag: z.string().min(1),
          })
        )
        .min(1),
    })
    .optional(),
});

const schema = z.object({
  files: z.array(itemSchema).min(1).max(50),
});

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

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
    const ids = body.files.map((f) => f.fileId);

    const rows = await db
      .select()
      .from(files)
      .where(and(inArray(files.id, ids), isNull(files.deletedAt)));

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const file = byId.get(id);
      // Same as /upload/complete: only the uploader may finalise their own pending row.
      if (!file || file.userId !== userId) {
        return apiError("File not found", 404);
      }
    }

    const completed: { fileId: string; name: string }[] = [];
    const failed: { fileId: string; error: string }[] = [];

    await mapLimited(body.files, 8, async (item) => {
      const file = byId.get(item.fileId)!;
      try {
        if (item.multipart) {
          await completeMultipartUpload(
            file.r2Key,
            item.multipart.uploadId,
            item.multipart.parts
          );
        }

        const exists = await objectExists(file.r2Key);
        if (!exists) {
          await db.delete(files).where(eq(files.id, item.fileId));
          failed.push({ fileId: item.fileId, error: "Upload incomplete" });
          return;
        }

        const isEncrypted = item.encrypted ?? file.encrypted;
        if (!isEncrypted) {
          try {
            const headerBuffer = await downloadFromR2Bytes(file.r2Key, 16);
            const validation = validateFileMagicBytes(
              headerBuffer.buffer as ArrayBuffer,
              file.mimeType
            );
            if (validation.warning) {
              console.warn(`[UPLOAD WARN] ${validation.warning} — file: ${file.name}`);
            }
          } catch {
            // skip
          }
        }

        const updates: Partial<typeof files.$inferInsert> = {
          checksumSha256: item.checksumSha256 ?? null,
          updatedAt: new Date(),
        };
        if (item.encrypted !== undefined) updates.encrypted = item.encrypted;
        if (item.encryptionMeta !== undefined) updates.encryptionMeta = item.encryptionMeta;
        if (item.originalMimeType && isEncrypted) {
          updates.mimeType = item.originalMimeType;
        }

        await db.update(files).set(updates).where(eq(files.id, item.fileId));

        const mime = item.originalMimeType ?? file.mimeType;
        if (
          !isEncrypted &&
          (mime.startsWith("image/") ||
            mime.startsWith("video/") ||
            mime === "application/pdf" ||
            mime.startsWith("audio/"))
        ) {
          await enqueueJob("generate_thumbnail", {
            fileId: item.fileId,
            r2Key: file.r2Key,
            mimeType: mime,
          });
        }

        void dispatchWebhookEvent(file.userId, "upload", {
          fileId: item.fileId,
          name: file.name,
          sizeBytes: file.sizeBytes,
          mimeType: mime,
          encrypted: isEncrypted,
        });

        void publishToUser(file.userId, {
          type: "upload_complete",
          fileId: item.fileId,
          name: file.name,
          sizeBytes: file.sizeBytes,
        });

        completed.push({ fileId: item.fileId, name: file.name });
      } catch (err) {
        if (item.multipart) {
          await abortMultipartUpload(file.r2Key, item.multipart.uploadId);
        }
        failed.push({
          fileId: item.fileId,
          error: err instanceof Error ? err.message : "Complete failed",
        });
      }
    });

    await recalculateUsedBytes(userId);

    if (completed.length > 0) {
      await logActivity(sessionUser, "upload", {
        resourceType: "file",
        resourceId: completed[0].fileId,
        metadata: { batch: true, count: completed.length, failed: failed.length },
        ip,
      });
    }

    return apiSuccess({ completed, failed });
  } catch (error) {
    return handleApiError(error);
  }
}
