import { NextRequest } from "next/server";
import { requireAuth } from "@/shared/lib/auth/session";
import { getAccessibleFile } from "@/shared/lib/auth/permissions";
import {
  downloadFromR2Stream,
  objectExists,
  getPresignedDownloadUrl,
  headObject,
} from "@files/infrastructure/storage/r2";
import { recordBandwidth, BandwidthQuotaError } from "@/shared/lib/billing/bandwidth";
import { apiSuccess, apiError } from "@/shared/api/response";
import { getSafeMimeType, shouldForceDownload } from "@/shared/lib/security/mime";
import { parseRangeHeader, rangeLength, toReadableStream } from "@files/infrastructure/storage/http-range";

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

    const exists = await objectExists(file.r2Key);
    if (!exists) {
      return apiError("This file isn't in storage yet. Try uploading it again.", 404);
    }

    if (format === "json") {
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

    const meta = await headObject(file.r2Key);
    const totalSize = meta.contentLength || file.sizeBytes;
    const rangeHeader = request.headers.get("range");
    const parsedRange = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

    const bytesToBill = parsedRange ? rangeLength(parsedRange) : totalSize;

    try {
      await recordBandwidth(file.userId, bytesToBill);
    } catch (err) {
      if (err instanceof BandwidthQuotaError) {
        return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429);
      }
      throw err;
    }

    const r2 = await downloadFromR2Stream(
      file.r2Key,
      parsedRange?.byteRange
    );

    if (!r2.body) {
      return apiError("This file is empty", 404);
    }

    const stream = toReadableStream(r2.body);
    const isPartial = parsedRange !== null && r2.statusCode === 206;

    const safeMimeType = getSafeMimeType(
      file.mimeType || meta.contentType || "application/octet-stream",
      file.name
    );
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
