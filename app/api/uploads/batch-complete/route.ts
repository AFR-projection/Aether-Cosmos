import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { getClientIp } from "@/shared/lib/auth/session";
import { validateCsrf, checkUserApiRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { completeUpload, getUpload, UploadServiceError } from "@files/infrastructure/storage/upload-service";
import { enqueueJob } from "@/shared/infrastructure/queue";
import { enqueueMediaInspection } from "@files/application/jobs/media-inspection";
import { dispatchWebhookEvent } from "@/shared/infrastructure/webhooks/dispatch";
import { publishToUser } from "@/shared/infrastructure/realtime/events";
import { logActivity } from "@/shared/lib/auth/audit";
import {
  BATCH_COMPLETE_MAX_SESSIONS,
  COMPLETE_DB_CONCURRENCY,
  UPLOAD_RATE_MULTIPLIER,
} from "@files/application/commands/limits";

/**
 * Finalize many single-part uploads in one request.
 *
 * The per-file `/api/uploads/[id]/complete` is not just one HTTP round trip per
 * file: it also writes an audit row, publishes a realtime event and dispatches a
 * webhook for every single file. A 5,000-file folder therefore produced 5,000 SSE
 * frames into the uploader's own tab, which the browser then had to parse and
 * dispatch while the upload was still running. Here the per-file work that MUST be
 * per-file (verification, thumbnails, media inspection) stays per file, and the
 * reporting is aggregated into one audit row and one realtime event.
 *
 * Multipart uploads keep the dedicated route: they are large by definition, so the
 * handshake is a rounding error, and they carry a parts list this shape has no room
 * for.
 */

const schema = z.object({
  sessions: z
    .array(
      z.object({
        sessionId: z.string().uuid(),
        checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      })
    )
    .min(1)
    .max(BATCH_COMPLETE_MAX_SESSIONS),
});

type Outcome =
  | { sessionId: string; ok: true; fileId: string; name: string }
  | { sessionId: string; ok: false; error: string; code: string };

/** Bounded-concurrency map that preserves input order in the output array. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function wantsThumbnail(mimeType: string): boolean {
  if (mimeType.startsWith("application/octet-stream")) return false;
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf"
  );
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
    const ip = getClientIp(request);
    const succeeded: { fileId: string; name: string; sizeBytes: number; mimeType: string }[] = [];

    const outcomes = await mapPool<{ sessionId: string; checksumSha256?: string }, Outcome>(
      body.sessions,
      COMPLETE_DB_CONCURRENCY,
      async ({ sessionId, checksumSha256 }) => {
        try {
          const before = await getUpload(sessionId, userId);
          const result = await completeUpload(sessionId, userId, [], checksumSha256);

          // Only a transition into "ready" earns the follow-up work; a replayed
          // complete must not enqueue a second thumbnail job or re-bill the quota.
          if (before.status !== "completed" && before.fileStatus !== "ready") {
            const after = await getUpload(sessionId, userId);
            if (wantsThumbnail(after.mimeType)) {
              await enqueueJob(
                "generate_thumbnail",
                { fileId: after.fileId, r2Key: after.objectKey, mimeType: after.mimeType, version: after.version },
                { jobId: `thumb-${after.fileId}-v${after.version}` }
              );
            }
            await enqueueMediaInspection({
              id: after.fileId,
              r2Key: after.objectKey,
              mimeType: after.mimeType,
              encrypted: after.encrypted,
              version: after.version,
            });
            succeeded.push({
              fileId: after.fileId,
              name: after.name,
              sizeBytes: after.totalSizeBytes,
              mimeType: after.mimeType,
            });
          }
          return { sessionId, ok: true, fileId: result.fileId, name: result.name };
        } catch (error) {
          if (error instanceof UploadServiceError) {
            return { sessionId, ok: false, error: error.message, code: error.code };
          }
          return {
            sessionId,
            ok: false,
            error: error instanceof Error ? error.message : "FINALIZATION_FAILED",
            code: "FINALIZATION_FAILED",
          };
        }
      }
    );

    if (succeeded.length > 0) {
      for (const file of succeeded) {
        void dispatchWebhookEvent(userId, "upload", {
          fileId: file.fileId,
          name: file.name,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
        });
      }
      // One frame for the whole batch. Other devices need to know something landed
      // and how much; naming one representative file keeps the existing toast
      // wording usable without shipping 5,000 names down the channel.
      void publishToUser(userId, {
        type: "upload_batch_complete",
        count: succeeded.length,
        fileIds: succeeded.map((file) => file.fileId),
        name: succeeded[0].name,
        sizeBytes: succeeded.reduce((sum, file) => sum + file.sizeBytes, 0),
      });
      await logActivity(sessionUser, "upload", {
        resourceType: "file",
        resourceId: succeeded[0].fileId,
        metadata: { batch: true, count: succeeded.length, verified: true },
        ip,
      });
    }

    return apiSuccess({
      results: outcomes,
      completed: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
