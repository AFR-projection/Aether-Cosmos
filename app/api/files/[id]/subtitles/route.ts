import { NextRequest } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { subtitlePipelineRuns } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, fileRefusal } from "@/shared/lib/auth/permissions";
import { objectExists } from "@files/infrastructure/storage/r2";
import { validateCsrf } from "@/shared/lib/security";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { subtitleSecondsRemaining } from "@/shared/lib/billing/subtitle-minutes";
import {
  canGenerateSubtitles,
  subtitleRefusalFor,
} from "@files/domain/services/subtitles/eligibility";
import {
  isSubtitleLanguage,
} from "@files/domain/services/subtitles/languages";
import { SUBTITLE_WHOLE_TRACK_MAX_CUES } from "@files/domain/services/subtitles/limits";
import { loadSubtitleConfig, subtitleCapability } from "@files/infrastructure/subtitles/config";
import { listTracks } from "@files/infrastructure/subtitles/tracks";
import { ensureSubtitlePipeline } from "@files/application/subtitles/pipeline/ensure";
import { postgresSubtitlePipelineStore } from "@files/infrastructure/subtitles/pipeline-store";

/**
 * A file's subtitle tracks: what exists, and asking for more.
 *
 * Under the durable pipeline, every eligible video already has a run being processed
 * in the background — this route mostly reports state. POST only ensures the run
 * exists (idempotent) and records extra manual language targets; it never starts
 * provider work directly, so a press here can never double-bill.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const generateSchema = z.object({
  /**
   * Extra languages beyond the automatic per-locale fan-out. Bounded because each
   * one is a separate paid pass; automatic locale targets are already covered by the
   * run and never need to be listed here.
   */
  targets: z
    .array(z.string().trim().min(1).max(20))
    .min(1)
    .max(20),
  sourceLanguage: z.union([z.string().trim().min(1).max(20), z.null()]).optional(),
});

/** The shape the CC menu reads. Deliberately without anything not needed to render it. */
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
    /**
     * Delivery mode, derived from the stored cue count rather than a live aggregate over
     * `subtitle_cues`: `cue_count` is maintained in step by the pipeline and the editor, and the
     * whole-file route independently re-checks the real size before answering. A track above the
     * whole-file cue threshold must be read through the cue-window route; the overlay needs to
     * know that up front, because the whole-file GET would answer 413.
     */
    deliveryMode:
      track.cueCount > SUBTITLE_WHOLE_TRACK_MAX_CUES ? ("segmented" as const) : ("whole" as const),
    /** Opaque version used to invalidate cue caches and reject stale editor saves. */
    revision: track.revision,
    durationSeconds: track.durationSeconds,
  };
}

/** Latest pipeline run aggregate for this file: phase, progress, unsupported reason. */
async function pipelineView(fileId: string) {
  const [run] = await db
    .select({
      id: subtitlePipelineRuns.id,
      status: subtitlePipelineRuns.status,
      stage: subtitlePipelineRuns.stage,
      progress: subtitlePipelineRuns.progress,
      unsupportedCode: subtitlePipelineRuns.unsupportedCode,
      failureCode: subtitlePipelineRuns.failureCode,
      failureMessage: subtitlePipelineRuns.failureMessage,
      totalWorkItems: subtitlePipelineRuns.totalWorkItems,
      completedWorkItems: subtitlePipelineRuns.completedWorkItems,
      durationMs: subtitlePipelineRuns.durationMs,
      completedAt: subtitlePipelineRuns.completedAt,
    })
    .from(subtitlePipelineRuns)
    .where(eq(subtitlePipelineRuns.fileId, fileId))
    .orderBy(desc(subtitlePipelineRuns.createdAt))
    .limit(1);
  return run ?? null;
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

    return apiSuccess({
      tracks: (await listTracks(file.id)).map(trackView),
      pipeline: await pipelineView(file.id),
      canGenerate: canGenerateSubtitles({ ...file, canEdit: accessible.canEdit }),
      canTranslate: capability.canTranslate,
      /** Why this FILE cannot have subtitles. */
      refusal,
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

    const remaining = await subtitleSecondsRemaining(file.userId);
    // The pipeline repeats this against the real measured duration; this is the courtesy check
    // that refuses an account with nothing left before a worker slot and a download are spent.
    if (remaining !== null && remaining <= 0) {
      return apiError("This month's subtitle allowance is used up.", 429, {
        code: "SUBTITLE_QUOTA_EXCEEDED",
        remainingSeconds: 0,
      });
    }

    const store = postgresSubtitlePipelineStore();

    // Idempotent ensure: creates the run for the exact current source version when
    // missing, and is a no-op when the background trigger already made one.
    const { run, created } = await ensureSubtitlePipeline({ fileId: file.id }, store);

    // Manual targets beyond the automatic locale fan-out. Automatic targets are
    // created by ensure itself; the pipeline translates every one of these the same
    // bounded way. Recorded as manual so the catalog distinguishes them.
    const existingTargetLanguages = new Set(
      (await store.listTargets(run.id)).map((t) => t.language)
    );
    const manualTargets = targets.filter((t) => !existingTargetLanguages.has(t));
    if (manualTargets.length > 0) {
      await store.addAutomaticTargets(run.id, manualTargets, run.localeSetHash, new Date());
    }

    // A fresh run while a legacy track row is still mid-flight from the old queue
    // path is converted by the reconciliation sweep; nothing to enqueue here — the
    // outbox pump delivers every pending work item on its own schedule.

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { action: "ensure_subtitle_pipeline", created, manualTargets },
      ip,
    });

    return apiSuccess({
      queued: true,
      created,
      pipeline: await pipelineView(file.id),
      tracks: (await listTracks(file.id)).map(trackView),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
