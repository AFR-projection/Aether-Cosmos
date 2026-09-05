import { NextRequest } from "next/server";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, fileRefusal } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { normalizeCues } from "@files/domain/services/subtitles/cues";
import { isSubtitleLanguage } from "@files/domain/services/subtitles/languages";
import {
  SUBTITLE_MAX_CUES,
  SUBTITLE_UPLOAD_MAX_BYTES,
} from "@files/domain/services/subtitles/limits";
import { parseSubtitleFile } from "@files/domain/services/subtitles/vtt";
import { replaceCues, upsertTrack } from "@files/infrastructure/subtitles/tracks";

/**
 * Attach a `.srt` or `.vtt` somebody already has.
 *
 * The cheapest useful half of this feature, and the only one that works with no provider
 * configured at all: a user who downloaded subtitles for a film elsewhere can put them on the
 * video here and watch. It is also the return path for the one thing an account backup cannot
 * carry — a track downloaded before a restore comes back in through this route.
 *
 * Multipart rather than JSON because the input is a file the user picked, and reading it as text
 * server-side means the browser never has to parse it to know whether it is valid.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Belt and braces with the size check: a `.srt` is text, and 2 MB of it is a very long film. */
const ALLOWED_EXTENSIONS = [".srt", ".vtt"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible) return apiError("File not found", 404);
    // Attaching writes a track against the file, so it takes write permission — the same bar as
    // generating one, even though this costs nothing.
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);

    const form = await request.formData();
    const upload = form.get("file");
    const language = form.get("language");

    if (!(upload instanceof File)) {
      return apiError("No subtitle file was attached", 400, { code: "SUBTITLE_UPLOAD_MISSING" });
    }
    if (typeof language !== "string" || !isSubtitleLanguage(language)) {
      return apiError("Pick the language of this file", 400, {
        code: "SUBTITLE_LANGUAGE_UNKNOWN",
      });
    }
    if (upload.size > SUBTITLE_UPLOAD_MAX_BYTES) {
      return apiError("That subtitle file is too large", 413, {
        code: "SUBTITLE_UPLOAD_TOO_LARGE",
        maxBytes: SUBTITLE_UPLOAD_MAX_BYTES,
      });
    }
    const lower = upload.name.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return apiError("Only .srt and .vtt files can be attached", 400, {
        code: "SUBTITLE_UPLOAD_WRONG_TYPE",
      });
    }

    // Both formats are text. `parseSubtitleFile` reads either, tolerates a BOM and CRLF, and
    // treats a comma and a full stop as the same decimal separator.
    const cues = normalizeCues(parseSubtitleFile(await upload.text())).slice(0, SUBTITLE_MAX_CUES);
    if (cues.length === 0) {
      return apiError("No subtitle lines could be read from that file", 400, {
        code: "SUBTITLE_UPLOAD_EMPTY",
      });
    }

    // `origin: "uploaded"` keeps this distinct from a generated track of the same language: a
    // Japanese film may legitimately have both, and the menu marks which is which.
    const track = await upsertTrack({
      fileId: id,
      language,
      origin: "uploaded",
      createdBy: sessionUser.id,
      status: "ready",
      cueCount: cues.length,
    });
    await replaceCues(track.id, cues);

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: id,
      metadata: { action: "attach_subtitles", language, cues: cues.length },
      ip,
    });

    return apiSuccess({ trackId: track.id, language, cueCount: cues.length });
  } catch (error) {
    return handleApiError(error);
  }
}
