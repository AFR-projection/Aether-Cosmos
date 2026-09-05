import { NextRequest } from "next/server";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { resolveSharedFile } from "@shares/application/shared-subtitles";
import { listTracks } from "@files/infrastructure/subtitles/tracks";

/**
 * The subtitle tracks of a shared video.
 *
 * Read-only, and the token is the capability — the same model the shared-note routes already use.
 * Only `ready` tracks are listed: a stranger has no use for a progress bar on work they cannot
 * start, and exposing a half-finished track would let them watch it fill in.
 *
 * There is no POST here, and there is not going to be one. Generating a track spends the operator's
 * transcription budget, and a public link handing that out is the one thing this feature must never
 * do.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const resolved = await resolveSharedFile(request, token);
    if (!resolved.ok) return resolved.response;

    const tracks = (await listTracks(resolved.file.fileId))
      .filter((track) => track.status === "ready" && track.cueCount > 0)
      .map((track) => ({
        id: track.id,
        language: track.language,
        origin: track.origin,
        // Fixed rather than read from the row: everything listed here is ready by construction,
        // and shipping the real column would leak how the sausage is made for no benefit.
        status: "ready" as const,
        progress: 100,
        cueCount: track.cueCount,
        translatedFromId: null,
        failureCode: null,
        failureMessage: null,
        createdAt: track.createdAt,
        readyAt: track.readyAt,
      }));

    return apiSuccess({ tracks });
  } catch (error) {
    return handleApiError(error);
  }
}
