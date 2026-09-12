import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId, resolveFolderAccess } from "@/shared/lib/auth/permissions";
import { validateCsrf, checkUserApiRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { getAdminSettings, isUploadAllowed, maxUploadBytes } from "@/shared/lib/settings/admin-settings";
import { initUpload, UploadServiceError } from "@files/infrastructure/storage/upload-service";
import {
  BATCH_INIT_MAX_FILES,
  INIT_DB_CONCURRENCY,
  UPLOAD_RATE_MULTIPLIER,
} from "@files/application/commands/limits";

/**
 * Open many upload sessions in one request.
 *
 * A folder upload is dominated by small files, and the per-file `/api/uploads/init`
 * made each one cost its own HTTP round trip plus its own slot in the per-user rate
 * bucket. A 5,000-file project needed 5,000 inits; at the upload bucket's ceiling
 * that alone is over sixteen minutes of nothing but handshakes, and everything past
 * the ceiling 429'd and burned the client's retries. Batching collapses that to one
 * request per {@link BATCH_INIT_MAX_FILES} files.
 *
 * Per-file failures are reported per file and never fail the batch: one blocked
 * extension or one over-quota file must not take the other 199 down with it. That is
 * the same principle the client now follows when a folder path fails to resolve.
 */

const encryptionMetaSchema = z.object({
  salt: z.string().min(1),
  iv: z.string().min(1),
  version: z.literal(1),
});

const fileSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  // Zero is a real size — see the same note in ../init/route.ts.
  sizeBytes: z.number().int().nonnegative().safe(),
  folderId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().min(16).max(128),
  encrypted: z.boolean().default(false),
  encryptionMeta: encryptionMetaSchema.optional(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

const schema = z.object({
  files: z.array(fileSchema).min(1).max(BATCH_INIT_MAX_FILES),
});

type FileInput = z.infer<typeof fileSchema>;

type BatchInitResult =
  | { index: number; ok: true; sessionId: string; fileId: string; objectKey: string; uploadType: "single" | "multipart"; status: string; totalSizeBytes: number; partSizeBytes: number | null; partCount: number; uploadId: string | null; uploadUrl: string | null }
  | { index: number; ok: false; error: string; code: string };

/** Bounded-concurrency map that preserves input order in the output array. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

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
    const sizeCeiling = maxUploadBytes(settings);

    // One access check per DISTINCT folder. A folder upload puts many files in the
    // same directory, and `resolveFolderAccess` is several queries deep.
    const folderVerdicts = new Map<string, boolean>();
    for (const folderId of new Set(body.files.map((f) => f.folderId).filter((id): id is string => !!id))) {
      const access = await resolveFolderAccess(sessionUser, folderId);
      folderVerdicts.set(folderId, !!access?.canEdit);
    }

    /** Everything that can be judged without touching the database. */
    function precheck(file: FileInput): { error: string; code: string } | null {
      if (file.encrypted && !file.encryptionMeta) {
        return { error: "encryptionMeta required when encrypted", code: "ENCRYPTION_META_REQUIRED" };
      }
      const policy = isUploadAllowed(file.mimeType, file.filename, settings);
      if (!policy.allowed) {
        return { error: policy.reason ?? "File type not allowed", code: "FILE_TYPE_BLOCKED" };
      }
      if (file.sizeBytes > sizeCeiling) {
        return { error: `File exceeds maximum size (${settings.maxUploadSizeMB} MB)`, code: "FILE_TOO_LARGE" };
      }
      if (file.folderId && !folderVerdicts.get(file.folderId)) {
        return { error: "Folder not found", code: "FOLDER_NOT_FOUND" };
      }
      return null;
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const results = await mapPool<FileInput, BatchInitResult>(
      body.files,
      INIT_DB_CONCURRENCY,
      async (file, index) => {
        const refusal = precheck(file);
        if (refusal) return { index, ok: false, ...refusal };
        try {
          const result = await initUpload({
            userId,
            filename: file.filename,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            folderId: file.folderId ?? null,
            idempotencyKey: file.idempotencyKey,
            encrypted: file.encrypted,
            encryptionMeta: file.encryptionMeta ?? null,
            checksumSha256: file.checksumSha256,
            expiresAt,
          });
          return { index, ok: true, ...result };
        } catch (error) {
          // Quota and idempotency conflicts are per-file facts, not batch failures.
          if (error instanceof UploadServiceError) {
            return { index, ok: false, error: error.message, code: error.code };
          }
          return {
            index,
            ok: false,
            error: error instanceof Error ? error.message : "UPLOAD_INIT_FAILED",
            code: "UPLOAD_INIT_FAILED",
          };
        }
      }
    );

    return apiSuccess({ results });
  } catch (error) {
    return handleApiError(error);
  }
}
