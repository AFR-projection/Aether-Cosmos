import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { shares, files } from "@/shared/infrastructure/db/schema";
import { apiError } from "@/shared/api/response";
import { checkRateLimit } from "@/shared/lib/security";
import { getClientIpFromRequest } from "@/shared/lib/access-tracking";
import { shareExpired } from "@shares/application/access";
import { isPossibleShareToken } from "@shares/domain/token";

/**
 * Resolving a share token to a file, for the subtitle routes.
 *
 * Two routes need exactly the same seven checks in exactly the same order, and getting one of them
 * wrong in one of the two would be a quiet hole rather than a visible bug — so the sequence lives
 * here once.
 *
 * Deliberately does NOT spend the share's access budget. That budget exists to limit how many times
 * the *content* is delivered, and it is claimed where the video's bytes leave, in
 * `app/api/shared/[token]/preview/route.ts`. A subtitle track is metadata about a view that has
 * already been paid for: charging for it would make a `maxAccessCount = 1` link unwatchable the
 * moment the viewer turned subtitles on, and charging per track would make it depend on how many
 * languages exist.
 */

/** Anonymous callers, so this is the only ceiling on either subtitle route. */
const SUBTITLE_MAX_PER_MINUTE = 120;

export type SharedFileForSubtitles = {
  fileId: string;
  fileName: string;
};

/** The file behind a token, or the response to return instead. */
export async function resolveSharedFile(
  request: NextRequest,
  token: string
): Promise<{ ok: true; file: SharedFileForSubtitles } | { ok: false; response: Response }> {
  // A token that cannot exist gets the same answer as one that does not: no oracle, and the
  // unbounded path segment never reaches a query or a cache key.
  if (!isPossibleShareToken(token)) {
    return { ok: false, response: apiError("Share not found", 404) };
  }

  const ip = getClientIpFromRequest(request);
  const limit = await checkRateLimit(`share_subtitles:${ip}`, SUBTITLE_MAX_PER_MINUTE, 60_000);
  if (!limit.allowed) {
    return { ok: false, response: apiError("Too many requests. Slow down.", 429) };
  }

  const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
  if (!share) return { ok: false, response: apiError("Share not found", 404) };

  const [file] = await db
    .select({ id: files.id, name: files.name })
    .from(files)
    .where(and(eq(files.id, share.fileId), isNull(files.deletedAt), eq(files.status, "ready")))
    .limit(1);
  if (!file) return { ok: false, response: apiError("File not found", 404) };

  if (shareExpired(share)) {
    return { ok: false, response: apiError("Share link expired", 410) };
  }

  return { ok: true, file: { fileId: file.id, fileName: file.name } };
}
