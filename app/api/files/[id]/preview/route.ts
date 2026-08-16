import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { getAccessibleFile } from "@/lib/auth/permissions";
import {
  downloadFromR2Stream,
  objectExists,
  getPresignedDownloadUrl,
  headObject,
} from "@/lib/storage/r2";
import { recordBandwidth, BandwidthQuotaError } from "@/lib/billing/bandwidth";
import { apiSuccess, apiError } from "@/lib/api/response";
import { getSafeMimeType, shouldForceDownload } from "@/lib/security/mime";

function parseRangeHeader(
  rangeHeader: string,
  totalSize: number
): { start: number; end: number; byteRange: string } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  let start = match[1] ? parseInt(match[1], 10) : NaN;
  let end = match[2] ? parseInt(match[2], 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    // suffix range: bytes=-500
    const suffixLength = end;
    if (Number.isNaN(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else if (Number.isNaN(end)) {
    end = totalSize - 1;
  }

  if (start < 0 || end < start || start >= totalSize) return null;
  end = Math.min(end, totalSize - 1);

  return { start, end, byteRange: `bytes=${start}-${end}` };
}

function toReadableStream(body: unknown): ReadableStream {
  if (body instanceof ReadableStream) return body;
  if (body && typeof body === "object" && "pipe" in body && typeof (body as { pipe: unknown }).pipe === "function") {
    return new ReadableStream({
      start(controller) {
        const nodeStream = body as NodeJS.ReadableStream & {
          on: (event: string, cb: (...args: unknown[]) => void) => void;
        };
        nodeStream.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err: Error) => controller.error(err));
      },
    });
  }
  return body as ReadableStream;
}

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
      return apiError("File belum ada di storage. Coba upload ulang.", 404);
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

    const bytesToBill = parsedRange
      ? parsedRange.end - parsedRange.start + 1
      : totalSize;

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
      return apiError("File kosong", 404);
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
      const chunkSize = parsedRange.end - parsedRange.start + 1;
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
    return apiError("Gagal memuat preview", 500);
  }
}
