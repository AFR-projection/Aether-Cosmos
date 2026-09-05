import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, fileRefusal } from "@/shared/lib/auth/permissions";
import { objectExists } from "@files/infrastructure/storage/r2";
import { validateCsrf } from "@/shared/lib/security";
import { enqueueJob, getQueue } from "@/shared/infrastructure/queue";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { subtitleSecondsRemaining } from "@/shared/lib/billing/subtitle-minutes";
import {
  canGenerateSubtitles,
  subtitleRefusalFor,
} from "@files/domain/services/subtitles/eligibility";
import {
  isSubtitleLanguage,
  UNDETERMINED_LANGUAGE,
} from "@files/domain/services/subtitles/languages";
import { SUBTITLE_MAX_TARGETS } from "@files/domain/services/subtitles/limits";
import { loadSubtitleConfig, subtitleCapability } from "@files/infrastructure/subtitles/config";
import {
  findAsrTrack,
  listTracks,
  requeueTrack,
  upsertTrack,
} from "@files/infrastructure/subtitles/tracks";

/**
 * A file's subtitle tracks: what exists, and asking for more.
 *
 * The POST here is the whole "turn subtitles on and they appear" gesture. It is one request, and
 * the client does not have to know whether a transcript already exists — that is worked out here,
 * because the answer decides whether anything gets billed:
 *
 *   * A ready transcript in the language being asked for → nothing to do, it already plays.
 *   * A ready transcript in another language → one translation job, no transcription.
 *   * No transcript → one transcription job, which queues the translations itself once it knows
 *     what language the audio actually is (see `subtitle-jobs.ts`). Asking for Indonesian
 *     subtitles on an Indonesian video must not produce a translation of a language into itself,
 *     and only the worker can know that.
 *
 * Every refusal that can be made cheaply is made here rather than in the worker, for the reason
 * `POST /api/files/extract-audio` gives: a caller who is out of quota, or whose file is not in
 * storage, should hear about it in the response instead of never.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const generateSchema = z.object({
  /**
   * Languages to watch in. Each is either satisfied by the transcript itself or becomes one
   * translation. Bounded because each one is a separate paid pass.
   */
  targets: z
    .array(z.string().trim().min(1).max(20))
    .min(1)
    .max(SUBTITLE_MAX_TARGETS),
  /**
   * What language the audio is, when the user knows better than the detector. Omitted or `null`
   * lets the provider decide, which is the normal case.
   */
  sourceLanguage: z.union([z.string().trim().min(1).max(20), z.null()]).optional(),
});

/** The shape the CC menu reads. Deliberately without anything that is not needed to render it. */
function trackView(track: Awaited<ReturnType<typeof listTracks>>[number]) {
  return {
    id: track.id,
    language: track.language,
    origin: track.origin,
    status: track.status,
    progress: track.progress,
    cueCount: track.cueCount,
    translatedFromId: track.translatedFromId,
    failureCode: track.failureCode,
    failureMessage: track.failureMessage,
    createdAt: track.createdAt,
    readyAt: track.readyAt,
  };
}

/**
 * Why this SERVER cannot make a track right now, or `null`.
 *
 * Separate from `SubtitleRefusal`, which is about the file. This one is about the instance, and it
 * exists because leaving it out was a real bug: the menu asked only whether the *file* was eligible,
 * so on a box with no queue it offered seven clickable languages whose every press returned 503.
 * A control that can only fail must not look ready — the same rule the mime and encryption checks
 * already followed.
 *
 * `getQueue()` is `null` when `REDIS_DISABLED=true`, which is the normal state of a local dev box
 * that has not started Redis. It does NOT prove a worker is running — nothing here can, since a
 * queue accepts jobs whether or not anybody is consuming them.
 */
function serverUnavailable(capability: { canTranscribe: boolean }): "not-configured" | "queue" | null {
  if (!capability.canTranscribe) return "not-configured";
  if (!getQueue()) return "queue";
  return null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) return apiError("File not found", 404);
    const file = accessible.file;

    const config = await loadSubtitleConfig();
    const capability = subtitleCapability(config);
    const refusal = subtitleRefusalFor(file);
    const unavailable = serverUnavailable(capability);

    return apiSuccess({
      tracks: (await listTracks(file.id)).map(trackView),
      /**
       * Whether this caller could ask for a new track — file eligible, permission held, AND the
       * server able to act on it. All three, so the menu never offers a press that must 503.
       */
      canGenerate:
        unavailable === null && canGenerateSubtitles({ ...file, canEdit: accessible.canEdit }),
      canTranslate: capability.canTranslate,
      /** Why this FILE cannot have subtitles. */
      refusal,
      /** Why this SERVER cannot make one right now. */
      unavailable,
      /** `null` means unlimited. Shown in the menu footer before anything is spent. */
      remainingSeconds: await subtitleSecondsRemaining(file.userId),
      /** Named in the footer, because the user is entitled to know where the audio goes. */
      provider: config.provider,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const body = generateSchema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible) return apiError("File not found", 404);
    // Making a track writes rows against the file and spends the instance's transcription
    // budget, so it takes the same permission as editing the file — and says why.
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);
    const file = accessible.file;

    const refusal = subtitleRefusalFor(file);
    if (refusal) {
      return apiError("Subtitles are not available for this file", 400, {
        code: `SUBTITLE_REFUSED_${refusal.toUpperCase()}`,
        refusal,
      });
    }

    /*
      The two server-level refusals come BEFORE the R2 existence check on purpose.

      `objectExists` is a network round trip to R2 and was measured at 1–8 seconds on a slow link.
      Spending that only to answer "this instance has no queue" — which is knowable in microseconds —
      made every one of those presses take a second to fail. Cheapest refusal first.
    */
    const config = await loadSubtitleConfig();
    const capability = subtitleCapability(config);
    if (!capability.canTranscribe) {
      return apiError("Subtitles aren't set up on this server yet.", 503, {
        code: "SUBTITLE_NOT_CONFIGURED",
      });
    }
    // Nothing below happens without the worker, so an unreachable queue is a 503 rather than a
    // `{ queued: true }` with nothing behind it. `null` here means REDIS_DISABLED or no Redis.
    if (!getQueue()) {
      return apiError("Subtitles are temporarily unavailable. Try again in a few minutes.", 503, {
        code: "SUBTITLE_QUEUE_UNAVAILABLE",
      });
    }

    if (file.r2Key.startsWith("notes/") || !(await objectExists(file.r2Key))) {
      return apiError("This file isn't in storage yet. Upload it again first.", 404);
    }

    // Tags are canonicalised by `languages.ts` and stored canonical, so anything else is a
    // client bug rather than a language this server merely lacks a model for.
    const targets = [...new Set(body.targets)].filter(isSubtitleLanguage);
    if (targets.length === 0) {
      return apiError("None of those languages are available", 400, {
        code: "SUBTITLE_LANGUAGE_UNKNOWN",
      });
    }
    const sourceLanguage =
      body.sourceLanguage && isSubtitleLanguage(body.sourceLanguage) ? body.sourceLanguage : null;

    const remaining = await subtitleSecondsRemaining(file.userId);
    // The worker repeats this against the real measured duration; this is the courtesy check
    // that refuses an account with nothing left before a worker slot and a download are spent.
    if (remaining !== null && remaining <= 0) {
      return apiError("This month's subtitle allowance is used up.", 429, {
        code: "SUBTITLE_QUOTA_EXCEEDED",
        remainingSeconds: 0,
      });
    }

    const existing = await findAsrTrack(file.id, db);

    /* ── The transcript is already there ──────────────────────────────────── */
    if (existing && existing.status === "ready") {
      const created: string[] = [];
      for (const target of targets) {
        // The transcript itself is one of the languages asked for: it already plays.
        if (target === existing.language) continue;
        if (!capability.canTranslate) continue;
        const track = await upsertTrack({
          fileId: file.id,
          language: target,
          origin: "translated",
          translatedFromId: existing.id,
          createdBy: sessionUser.id,
        });
        const queued = await enqueueJob("translate_subtitles", { trackId: track.id });
        if (!queued) {
          return apiError("Subtitles are temporarily unavailable. Try again in a few minutes.", 503, {
            code: "SUBTITLE_QUEUE_UNAVAILABLE",
          });
        }
        created.push(track.id);
      }

      await logActivity(sessionUser, "edit", {
        resourceType: "file",
        resourceId: file.id,
        metadata: { action: "translate_subtitles", targets, tracks: created.length },
        ip,
      });
      return apiSuccess({ queued: created.length > 0, tracks: (await listTracks(file.id)).map(trackView) });
    }

    /* ── A transcription is already running ───────────────────────────────── */
    if (existing && (existing.status === "queued" || existing.status === "processing")) {
      // Re-queueing the transcription would pay for the same audio twice. The languages asked
      // for are recorded as queued tracks and picked up when the transcript lands; the worker
      // enqueues its own targets, so anything asked for meanwhile is added here.
      for (const target of targets) {
        if (!capability.canTranslate) continue;
        await upsertTrack({
          fileId: file.id,
          language: target,
          origin: "translated",
          translatedFromId: existing.id,
          createdBy: sessionUser.id,
        });
      }
      return apiSuccess({
        queued: true,
        alreadyRunning: true,
        tracks: (await listTracks(file.id)).map(trackView),
      });
    }

    /* ── Nothing yet, or the last attempt failed ──────────────────────────── */
    const transcript = existing
      ? (await requeueTrack(existing.id), existing)
      : await upsertTrack({
          fileId: file.id,
          // The audio's language is not known yet, and a placeholder is honest about that. The
          // worker renames the row once the provider reports a detection.
          language: sourceLanguage ?? UNDETERMINED_LANGUAGE,
          origin: "asr",
          createdBy: sessionUser.id,
        });

    const queued = await enqueueJob("transcribe_media", {
      trackId: transcript.id,
      targets: capability.canTranslate ? targets : [],
    });
    if (!queued) {
      return apiError("Subtitles are temporarily unavailable. Try again in a few minutes.", 503, {
        code: "SUBTITLE_QUEUE_UNAVAILABLE",
      });
    }

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { action: "transcribe_media", targets },
      ip,
    });

    return apiSuccess({ queued: true, tracks: (await listTracks(file.id)).map(trackView) });
  } catch (error) {
    return handleApiError(error);
  }
}
