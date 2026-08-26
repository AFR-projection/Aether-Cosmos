import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { shares, files } from "@/lib/db/schema";
import { downloadFromR2Stream } from "@/lib/storage/r2";
import { apiError, handleApiError } from "@/lib/api/response";
import { getSafeMimeType, shouldForceDownload } from "@/lib/security/mime";
import { claimShareAccess, shareExpired, shareResumeIsFree } from "@/lib/shares/access";
import { isPossibleShareToken } from "@/lib/shares/token";
import {
  isContinuationRange,
  parseRangeHeader,
  rangeLength,
  toReadableStream,
} from "@/lib/storage/http-range";
import { recordBandwidth, BandwidthQuotaError } from "@/lib/billing/bandwidth";
import { checkRateLimit } from "@/lib/security";
import { getClientIpFromRequest } from "@/lib/access-tracking";

/**
 * Public content path for a share link. Anonymous, so every ceiling here is the
 * only ceiling.
 */
const PREVIEW_MAX_PER_MINUTE = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    // A token that cannot exist gets the same answer as one that does not: no
    // oracle, and the unbounded path segment never reaches a query or a cache key.
    if (!isPossibleShareToken(token)) return apiError("Share not found", 404);

    const ip = getClientIpFromRequest(request);
    const limit = await checkRateLimit(`share_preview:${ip}`, PREVIEW_MAX_PER_MINUTE, 60_000);
    if (!limit.allowed) return apiError("Too many requests. Slow down.", 429);

    const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
    if (!share) return apiError("Share not found", 404);

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, share.fileId), isNull(files.deletedAt), eq(files.status, "ready")))
      .limit(1);

    if (!file) return apiError("File not found", 404);

    // Duration Check
    if (shareExpired(share)) {
      return apiError("Share link expired", 410);
    }

    /**
     * This is where the bytes leave, so this is where the access budget is spent.
     *
     * It used to read a counter that only the metadata endpoint incremented and
     * then serve the file regardless: a caller who requested this URL directly
     * never moved the counter, so `maxAccessCount` bounded nothing at all — a
     * "one download" link was an unlimited one.
     *
     * A resumed transfer continues an access that was already paid for and is not
     * charged again — but only a real one. The exemption used to be granted to any
     * `Range` that did not start at byte 0, and the range was then ignored and the
     * whole object served with a `200`, so `Range: bytes=1-` was an unlimited free
     * download. Now the range is honoured (206 + `Content-Range`) and the exemption
     * requires a paid access to resume from, inside `SHARE_RESUME_WINDOW_MS`.
     */
    const totalSize = file.sizeBytes;
    const rangeHeader = request.headers.get("range");
    const parsedRange = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;
    const freeContinuation = isContinuationRange(parsedRange) && shareResumeIsFree(share);

    if (!freeContinuation) {
      const claimed = await claimShareAccess(share.id);
      if (!claimed) {
        return apiError("Share link has reached maximum access limit", 403);
      }
    }

    // Public egress is still the owner's egress. Every other byte-serving route
    // meters it; this one did not, so a share link was an unmetered channel around
    // the owner's bandwidth quota.
    const bytesToBill = parsedRange ? rangeLength(parsedRange) : totalSize;
    try {
      await recordBandwidth(file.userId, bytesToBill);
    } catch (error) {
      if (error instanceof BandwidthQuotaError) {
        return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429);
      }
      throw error;
    }

    // Stream straight from R2 to the browser — never buffered here.
    const r2 = await downloadFromR2Stream(file.r2Key, parsedRange?.byteRange);

    if (!r2.body) {
      return apiError("File is empty", 404);
    }

    const stream = toReadableStream(r2.body);
    const isPartial = parsedRange !== null && r2.statusCode === 206;

    const safeMimeType = getSafeMimeType(file.mimeType, file.name);
    const forceDownload = shouldForceDownload(file.name);

    const headers = new Headers();
    headers.set("Content-Type", safeMimeType);
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", "bytes");
    headers.set(
      "Content-Disposition",
      forceDownload
        ? `attachment; filename="${encodeURIComponent(file.name)}"`
        : `inline; filename="${encodeURIComponent(file.name)}"`
    );

    if (isPartial && parsedRange) {
      headers.set("Content-Length", String(rangeLength(parsedRange)));
      headers.set(
        "Content-Range",
        r2.contentRange ?? `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`
      );
      return new Response(stream, { status: 206, headers });
    }

    headers.set("Content-Length", String(r2.contentLength ?? totalSize));
    return new Response(stream, { status: 200, headers });
  } catch (error) {
    return handleApiError(error);
  }
}
