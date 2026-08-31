import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import {
  getAccessibleFile,
  fileRefusal,
  fileDomainOwnerId,
  resolveWritableDestination,
} from "@/shared/lib/auth/permissions";
import { objectExists } from "@files/infrastructure/storage/r2";
import { validateCsrf } from "@/shared/lib/security";
import { enqueueJob, getQueue } from "@/shared/infrastructure/queue";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { EXTRACT_AUDIO_SOURCE_MAX_BYTES } from "@files/domain/services/edit-limits";
import { canExtractAudioFrom } from "@files/domain/services/media-edit";

/**
 * Pull the audio track out of a video into a new file.
 *
 * Separate from `/api/files/edit` because this one CREATES a file rather than rewriting
 * one: it needs a writable destination folder, quota headroom, and an owner to file the
 * result under, none of which an in-place edit has to think about.
 *
 * The work itself is a re-encode in the worker, so the answer here is `{ queued: true }`
 * and every refusal that can be made cheaply is made now — a caller who is out of quota
 * or whose file is not in storage should hear about it in the response, not never.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const extractSchema = z.object({ fileId: z.string().uuid() });

/**
 * Refuse an account with no room left before spending a worker slot on it.
 *
 * The extracted size is not knowable until ffmpeg has run, so this is the headroom check
 * the route CAN make; the worker repeats it against the real output before it writes
 * anything.
 */
async function headroomRefusal(ownerId: string) {
  const [owner] = await db
    .select({
      quotaBytes: users.quotaBytes,
      usedBytes: users.usedBytes,
      reservedBytes: users.reservedBytes,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner) return null;
  if (owner.usedBytes + owner.reservedBytes < owner.quotaBytes) return null;
  return apiError("This would go over the storage quota. Free up some space first.", 413, {
    code: "QUOTA_EXCEEDED",
    quotaBytes: owner.quotaBytes,
    usedBytes: owner.usedBytes,
  });
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = extractSchema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, body.fileId);
    if (!accessible) return apiError("File not found", 404);
    // Creating the audio file is a write into the video's folder, so it takes the same
    // permission as editing the video — and says why rather than answering a bare 404.
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);
    const file = accessible.file;

    if (!canExtractAudioFrom(file.mimeType)) {
      return apiError("Only video files have an audio track to pull out", 400, {
        code: "EXTRACT_AUDIO_MIME_REFUSED",
      });
    }

    // The server holds ciphertext and no key, so ffmpeg would be handed noise.
    if (file.encrypted) {
      return apiError("Encrypted files can't be processed on the server", 400, {
        code: "EXTRACT_AUDIO_ENCRYPTED_REFUSED",
      });
    }

    if (file.r2Key.startsWith("notes/") || !(await objectExists(file.r2Key))) {
      return apiError("This file isn't in storage yet. Upload it again first.", 404);
    }

    if (Number(file.sizeBytes) > EXTRACT_AUDIO_SOURCE_MAX_BYTES) {
      return apiError("This video is too large to extract audio from", 413, {
        code: "EXTRACT_AUDIO_SOURCE_TOO_LARGE",
        maxBytes: EXTRACT_AUDIO_SOURCE_MAX_BYTES,
      });
    }

    // The new file lands beside the video, which is only allowed for a caller who could
    // have put a file there themselves — a shared folder they can read but not write to
    // sends the result somewhere they can.
    const destination = await resolveWritableDestination(sessionUser, file.folderId, {
      fileOwnerId: file.userId,
      domainOwnerId: await fileDomainOwnerId(file),
    });
    if (!destination.ok) return apiError(destination.message, destination.status);

    const refusal = await headroomRefusal(file.userId);
    if (refusal) return refusal;

    // The extraction only happens in the worker, so an unreachable queue means it never
    // happens. Answered as a 503 rather than a `{ queued: true }` nothing is behind.
    if (!getQueue()) {
      return apiError("Extracting audio is temporarily unavailable. Try again in a few minutes.", 503, {
        code: "EXTRACT_AUDIO_QUEUE_UNAVAILABLE",
      });
    }

    const queued = await enqueueJob("extract_audio", {
      fileId: file.id,
      r2Key: file.r2Key,
      mimeType: file.mimeType,
      // Passed rather than re-read in the worker: the destination is the answer to a
      // permission question this request already asked, and the owner is who the new file
      // belongs to regardless of who pressed the button.
      userId: file.userId,
      folderId: destination.folderId,
      name: file.name,
    });
    if (!queued) {
      return apiError("Extracting audio is temporarily unavailable. Try again in a few minutes.", 503, {
        code: "EXTRACT_AUDIO_QUEUE_UNAVAILABLE",
      });
    }

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { action: "extract_audio" },
      ip,
    });

    return apiSuccess({ queued: true });
  } catch (error) {
    return handleApiError(error);
  }
}
