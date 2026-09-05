import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, fileRefusal } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { normalizeCues } from "@files/domain/services/subtitles/cues";
import { SUBTITLE_MAX_CUES } from "@files/domain/services/subtitles/limits";
import { cuesToVtt } from "@files/domain/services/subtitles/vtt";
import {
  deleteTrack,
  getTrackForFile,
  listCues,
  replaceCues,
} from "@files/infrastructure/subtitles/tracks";
import { vttResponse } from "@files/application/subtitles/vtt-response";

/**
 * One subtitle track: read it as WebVTT, rewrite its lines, or remove it.
 *
 * GET is what a `<track src>` points at, which is why it answers with `text/vtt` rather than JSON
 * and why it is the one handler here with no CSRF check — a `<track>` element issues a plain GET.
 *
 * PATCH is the editor's save, and it replaces the whole track rather than patching lines. That is
 * deliberate: the editor can split, merge and delete, so the *number* of lines changes and a
 * per-line diff would have to reconcile two sets of indices. Sending the whole track makes "what
 * the user is looking at" and "what is stored" the same object.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cueSchema = z.object({
  startMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  endMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  text: z.string().max(2_000),
});

const patchSchema = z.object({
  /**
   * The track's lines, in order. `idx` is not accepted from the client: `normalizeCues` assigns
   * it, so a request cannot produce a track with a gap or a repeat in its numbering.
   */
  cues: z.array(cueSchema).max(SUBTITLE_MAX_CUES),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id, trackId } = await params;

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) return apiError("File not found", 404);

    // Scoped to the file whose permission was just checked, so a guessed track id from another
    // file cannot be read through this route.
    const track = await getTrackForFile(id, trackId);
    if (!track) return apiError("Subtitle track not found", 404);
    if (track.status !== "ready") {
      return apiError("These subtitles aren't finished yet", 409, {
        code: "SUBTITLE_NOT_READY",
        status: track.status,
        progress: track.progress,
      });
    }

    return vttResponse(cuesToVtt(await listCues(trackId)), {
      language: track.language,
      // `?download` turns the same body into a file the user keeps. This is the escape hatch for
      // the one thing an account backup cannot carry — see EXCLUDED_ACCOUNT_TABLES.
      fileName: _request.nextUrl.searchParams.has("download")
        ? `${accessible.file.name}.${track.language}.vtt`
        : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id, trackId } = await params;
    const body = patchSchema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible) return apiError("File not found", 404);
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);

    const track = await getTrackForFile(id, trackId);
    if (!track) return apiError("Subtitle track not found", 404);
    // A track being built is about to have its cues replaced by the worker, so accepting an edit
    // now would either lose the edit or lose the transcript, depending on who finished last.
    if (track.status === "queued" || track.status === "processing") {
      return apiError("These subtitles are still being made. Try again when they're ready.", 409, {
        code: "SUBTITLE_BUSY",
      });
    }

    // The same pass the worker applies: reading speed, minimum and maximum on screen, no overlap,
    // contiguous numbering. A hand edit gets the same treatment as a generated one, so a line
    // typed longer than its slot is given the time it needs instead of flashing past.
    const cues = normalizeCues(body.cues.map((cue, idx) => ({ idx, ...cue })));
    await replaceCues(trackId, cues);

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: id,
      metadata: { action: "edit_subtitles", trackId, cues: cues.length },
      ip,
    });

    return apiSuccess({ cueCount: cues.length, cues });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id, trackId } = await params;
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible) return apiError("File not found", 404);
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);

    const track = await getTrackForFile(id, trackId);
    if (!track) return apiError("Subtitle track not found", 404);

    await deleteTrack(trackId);
    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: id,
      metadata: { action: "delete_subtitles", trackId, language: track.language },
      ip,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
