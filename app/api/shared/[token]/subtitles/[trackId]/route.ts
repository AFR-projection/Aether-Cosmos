import { NextRequest } from "next/server";
import { apiError, handleApiError } from "@/shared/api/response";
import { resolveSharedFile } from "@shares/application/shared-subtitles";
import { cuesToVtt } from "@files/domain/services/subtitles/vtt";
import {
  getTrackForFile,
  getWholeVttSize,
  listCues,
  wholeVttRequiresSegmentation,
  WHOLE_VTT_MAX_CUES,
  WHOLE_VTT_MAX_ESTIMATED_BYTES,
} from "@files/infrastructure/subtitles/tracks";
import { vttResponse } from "@files/application/subtitles/vtt-response";

/**
 * One subtitle track of a shared video, as WebVTT.
 *
 * What a `<track src>` on the public share page points at. The track is looked up scoped to the
 * file the token resolved to, so a guessed track id from a different file cannot be read through a
 * valid token — the token grants one file, not a query.
 *
 * No download parameter here, unlike the authenticated route: the owner may keep a copy of their
 * own subtitles, and a stranger with a view link has not been given that.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; trackId: string }> }
) {
  try {
    const { token, trackId } = await params;
    const resolved = await resolveSharedFile(request, token);
    if (!resolved.ok) return resolved.response;

    const track = await getTrackForFile(resolved.file.fileId, trackId);
    // A track that is not ready is reported as missing rather than as pending: to an anonymous
    // caller the two are the same fact, and the second one describes internal state.
    if (!track || track.status !== "ready") return apiError("Subtitle track not found", 404);

    const wholeSize = await getWholeVttSize(trackId);
    if (wholeVttRequiresSegmentation(wholeSize)) {
      return apiError("This subtitle track must be read in cue windows", 413, {
        code: "SEGMENTED_SUBTITLE_REQUIRED",
        cueCount: wholeSize.cueCount,
        estimatedBytes: wholeSize.estimatedBytes,
        maxCues: WHOLE_VTT_MAX_CUES,
        maxEstimatedBytes: WHOLE_VTT_MAX_ESTIMATED_BYTES,
        cuesUrl: `/api/shared/${token}/subtitles/${trackId}/cues`,
      });
    }

    const response = vttResponse(cuesToVtt(await listCues(trackId)), {
      language: track.language,
    });
    response.headers.set("X-Subtitle-Revision", String(track.revision));
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
