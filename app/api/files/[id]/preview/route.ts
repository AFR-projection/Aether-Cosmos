import { NextRequest } from "next/server";
import { requireAuth } from "@/shared/lib/auth/session";
import { getAccessibleFile } from "@/shared/lib/auth/permissions";
import {
  downloadFromR2Stream,
  objectExists,
  getPresignedDownloadUrl,
} from "@files/infrastructure/storage/r2";
import { recordBandwidth, BandwidthQuotaError } from "@/shared/lib/billing/bandwidth";
import { apiSuccess, apiError } from "@/shared/api/response";
import { getSafeMimeType, shouldForceDownload } from "@/shared/lib/security/mime";
import {
  isContinuationRange,
  parseRangeHeader,
  rangeLength,
  toReadableStream,
} from "@files/infrastructure/storage/http-range";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;
    const format = request.nextUrl.searchParams.get("format");

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }
    const file = accessible.file;

    if (file.isNote || file.r2Key.startsWith("notes/")) {
      return apiError("Preview not available for notes", 400);
    }

    if (format === "json") {
      // Kept only on this path: it answers with a presigned URL, and handing out a signed link to
      // an object that is not there would fail in the browser with nothing to explain it.
      if (!(await objectExists(file.r2Key))) {
        return apiError("This file isn't in storage yet. Try uploading it again.", 404);
      }
      try {
        await recordBandwidth(file.userId, file.sizeBytes);
      } catch (err) {
        if (err instanceof BandwidthQuotaError) {
          return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429);
        }
        throw err;
      }
      const url = await getPresignedDownloadUrl(file.r2Key);
      return apiSuccess({ url });
    }

    /*
      ── Why this path does no HEAD requests, and bills only once ──

      A video player issues one range request per buffer segment and one per seek — dozens to
      hundreds over a single playback. This route used to spend, on every one of them:

        objectExists()   R2 HEAD              ~170 ms
        headObject()     R2 HEAD, same object  ~65 ms
        recordBandwidth() SELECT + UPDATE users ~254 ms   (measured against Aiven)

      That is ~490 ms of latency before a byte moves, repeated per chunk, which is what "patah-patah"
      actually was. Worse, `recordBandwidth` is a read-modify-write on ONE `users` row: concurrent
      range requests from the same viewer serialise on that row lock, and a handful in flight turned
      into the 21-second 206 responses in the logs.

      None of it was buying anything:
        - the object's size is already on the row this request has in hand;
        - R2's own GET response carries the authoritative `Content-Range` / `Content-Length`;
        - a missing object surfaces as a failed GET, which is handled below.

      Billing is now once per delivery rather than once per chunk: the initial request pays for the
      whole object, and continuation ranges are free. That is the same rule the public share route
      already applies via `isContinuationRange`. It over-bills somebody who watches ten seconds of a
      film and stops — a bounded, predictable inaccuracy — and in exchange the meter leaves the hot
      path entirely.
    */
    const totalSize = file.sizeBytes;
    const parsed = parseRangeHeader(request.headers.get("range"), totalSize);
    if (parsed.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${totalSize}`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    const parsedRange = parsed.kind === "range" ? parsed.range : null;

    if (!isContinuationRange(parsedRange)) {
      try {
        await recordBandwidth(file.userId, totalSize);
      } catch (err) {
        if (err instanceof BandwidthQuotaError) {
          return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429);
        }
        throw err;
      }
    }

    let r2: Awaited<ReturnType<typeof downloadFromR2Stream>>;
    try {
      r2 = await downloadFromR2Stream(file.r2Key, parsedRange?.byteRange);
    } catch {
      // The one thing the dropped HEAD used to tell us, learned from the request that was going to
      // happen anyway rather than from an extra round trip before it.
      return apiError("This file isn't in storage yet. Try uploading it again.", 404);
    }

    if (!r2.body) {
      return apiError("This file is empty", 404);
    }

    const stream = toReadableStream(r2.body);
    const isPartial = parsedRange !== null && r2.statusCode === 206;

    const safeMimeType = getSafeMimeType(
      file.mimeType || "application/octet-stream",
      file.name
    );
    const forceDownload = shouldForceDownload(file.name);

    const headers = new Headers();
    headers.set("Content-Type", safeMimeType);
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", "bytes");
    if (r2.eTag) headers.set("ETag", r2.eTag);
    if (r2.lastModified) headers.set("Last-Modified", r2.lastModified.toUTCString());
    headers.set(
      "Content-Disposition",
      forceDownload
        ? `attachment; filename="${encodeURIComponent(file.name)}"`
        : `inline; filename="${encodeURIComponent(file.name)}"`
    );

    if (isPartial && parsedRange) {
      const chunkSize = rangeLength(parsedRange);
      headers.set("Content-Length", String(chunkSize));
      headers.set(
        "Content-Range",
        r2.contentRange ?? `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`
      );
      return new Response(stream, { status: 206, headers });
    }

    headers.set("Content-Length", String(r2.contentLength ?? totalSize));
    return new Response(stream, { status: 200, headers });
  } catch (error) {
    console.error("[PREVIEW ERROR]", error);
    return apiError("Couldn't load the preview", 500);
  }
}
