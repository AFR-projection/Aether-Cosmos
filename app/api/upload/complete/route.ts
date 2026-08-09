import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getClientIp } from "@/lib/auth/session";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId, canAccessUserResource } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import { objectExists, downloadFromR2Bytes } from "@/lib/storage/r2";
import { validateCsrf } from "@/lib/security";
import { validateFileMagicBytes } from "@/lib/security/file-validation";
import { checkSuspiciousActivity, logSuspiciousActivity } from "@/lib/security/suspicious-activity";
import { enqueueJob } from "@/lib/queue";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { recalculateUsedBytes } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";
import { publishToUser } from "@/lib/realtime/events";

const encryptionMetaSchema = z.object({
  salt: z.string().min(1),
  iv: z.string().min(1),
  version: z.literal(1),
});

const schema = z.object({
  fileId: z.string().uuid(),
  checksumSha256: z.string().optional(),
  encrypted: z.boolean().optional(),
  encryptionMeta: encryptionMetaSchema.optional(),
  originalMimeType: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const userId = getEffectiveUserId(sessionUser);
    const body = schema.parse(await request.json());
    const { fileId, checksumSha256 } = body;
    const ip = getClientIp(request);

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
      .limit(1);

    if (!file || !canAccessUserResource(sessionUser, file.userId)) {
      return apiError("File not found", 404);
    }

    const exists = await objectExists(file.r2Key);
    if (!exists) {
      await db.delete(files).where(eq(files.id, fileId));
      return apiError("Upload incomplete", 400);
    }

    const isEncrypted = body.encrypted ?? file.encrypted;
    if (!isEncrypted) {
      try {
        const headerBuffer = await downloadFromR2Bytes(file.r2Key, 16);
        const validation = validateFileMagicBytes(headerBuffer.buffer as ArrayBuffer, file.mimeType);
        if (validation.warning) {
          console.warn(`[UPLOAD WARN] ${validation.warning} — file: ${file.name} (${file.id})`);
        }
      } catch {
        // skip if header unreadable
      }
    }

    const suspicious = await checkSuspiciousActivity(userId, "upload", ip);
    if (suspicious.suspicious) {
      await logSuspiciousActivity(userId, "upload", suspicious.reason ?? "Unknown", ip);
    }

    const now = new Date();
    const updates: Partial<typeof files.$inferInsert> = {
      status: "ready",
      checksumSha256: checksumSha256 ?? null,
      completedAt: now,
      verifiedAt: now,
      failureCode: null,
      failureMessage: null,
      updatedAt: now,
    };
    if (body.encrypted !== undefined) updates.encrypted = body.encrypted;
    if (body.encryptionMeta !== undefined) updates.encryptionMeta = body.encryptionMeta;
    if (body.originalMimeType && isEncrypted) {
      // Keep original mime for client decrypt preview; ciphertext stays octet-stream on wire
      updates.mimeType = body.originalMimeType;
    }

    await db.update(files).set(updates).where(eq(files.id, fileId));

    await recalculateUsedBytes(userId);

    await logActivity(sessionUser, "upload", {
      resourceType: "file",
      resourceId: fileId,
      metadata: {
        name: file.name,
        size: file.sizeBytes,
        encrypted: isEncrypted,
        suspicious: suspicious.suspicious,
        riskLevel: suspicious.riskLevel,
      },
      ip,
    });

    if (
      !isEncrypted &&
      (file.mimeType.startsWith("image/") ||
        file.mimeType.startsWith("video/") ||
        file.mimeType === "application/pdf" ||
        file.mimeType.startsWith("audio/"))
    ) {
      await enqueueJob("generate_thumbnail", {
        fileId,
        r2Key: file.r2Key,
        mimeType: file.mimeType,
      });
    }

    void dispatchWebhookEvent(file.userId, "upload", {
      fileId,
      name: file.name,
      sizeBytes: file.sizeBytes,
      mimeType: body.originalMimeType ?? file.mimeType,
      encrypted: isEncrypted,
    });

    void publishToUser(file.userId, {
      type: "upload_complete",
      fileId,
      name: file.name,
      sizeBytes: file.sizeBytes,
    });

    return apiSuccess({ fileId, name: file.name });
  } catch (error) {
    return handleApiError(error);
  }
}
