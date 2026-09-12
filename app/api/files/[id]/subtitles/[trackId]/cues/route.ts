import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/shared/lib/auth/session";
import { getAccessibleFile } from "@/shared/lib/auth/permissions";
import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";
import {
  CUE_WINDOW_MAX_CUES,
  CUE_WINDOW_MAX_MS,
  getTrackForFile,
  listCueWindow,
  type CueCursor,
} from "@files/infrastructure/subtitles/tracks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    startMs: z.coerce.number().int().nonnegative().safe(),
    endMs: z.coerce.number().int().nonnegative().safe(),
    limit: z.coerce.number().int().min(1).max(CUE_WINDOW_MAX_CUES).default(CUE_WINDOW_MAX_CUES),
    cursor: z.string().max(120).optional(),
  })
  .refine((query) => query.endMs > query.startMs, {
    message: "endMs must be greater than startMs",
    path: ["endMs"],
  })
  .refine((query) => query.endMs - query.startMs <= CUE_WINDOW_MAX_MS, {
    message: `The cue window cannot exceed ${CUE_WINDOW_MAX_MS}ms`,
    path: ["endMs"],
  });

export function encodeCueCursor(cursor: CueCursor): string {
  return Buffer.from(JSON.stringify([cursor.startMs, cursor.idx]), "utf8").toString("base64url");
}

export function decodeCueCursor(value: string | undefined): CueCursor | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      decoded[0] < 0 ||
      !Number.isSafeInteger(decoded[1]) ||
      decoded[1] < 0
    ) {
      throw new Error("invalid cursor");
    }
    return { startMs: decoded[0], idx: decoded[1] };
  } catch {
    throw new z.ZodError([
      { code: "custom", path: ["cursor"], message: "Invalid cue cursor" },
    ]);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; trackId: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id, trackId } = await params;
    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) return apiError("File not found", 404);

    const track = await getTrackForFile(id, trackId);
    if (!track) return apiError("Subtitle track not found", 404);
    if (track.status !== "ready") {
      return apiError("These subtitles aren't finished yet", 409, {
        code: "SUBTITLE_NOT_READY",
        status: track.status,
        progress: track.progress,
      });
    }

    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const page = await listCueWindow(trackId, {
      startMs: query.startMs,
      endMs: query.endMs,
      limit: query.limit,
      cursor: decodeCueCursor(query.cursor),
    });
    return apiSuccess({
      cues: page.cues,
      nextCursor: page.nextCursor ? encodeCueCursor(page.nextCursor) : null,
      revision: track.revision,
      window: { startMs: query.startMs, endMs: query.endMs },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
