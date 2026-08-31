import { NextRequest } from "next/server";
import { Readable } from "stream";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile } from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { getPresignedDownloadUrl, objectExists, downloadFromR2Stream, encodeContentDispositionFilename } from "@files/infrastructure/storage/r2";
import { recordBandwidth, BandwidthQuotaError } from "@/shared/lib/billing/bandwidth";
import { apiError, handleApiError } from "@/shared/api/response";
import { getSafeMimeType } from "@/shared/lib/security/mime";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["download"]);
    const { id } = await params;
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }
    const file = accessible.file;

    if (file.isNote || file.r2Key.startsWith("notes/")) {
      // Notes aren't stored as R2 objects — they're exported from the editor
      // (Markdown / TXT / PDF). Open the note to download it.
      return apiError("Open the note to export it (Markdown/TXT/PDF) — notes aren't stored as files", 400);
    }

    const exists = await objectExists(file.r2Key);
    if (!exists) {
      return apiError("This file was never uploaded to storage, or it's gone", 404);
    }

    try {
      await recordBandwidth(file.userId, file.sizeBytes);
    } catch (err) {
      if (err instanceof BandwidthQuotaError) {
        return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429);
      }
      throw err;
    }

    await logActivity(sessionUser, "download", {
      resourceType: "file",
      resourceId: id,
      metadata: { name: file.name },
      ip,
    });

    const safeMimeType = getSafeMimeType(file.mimeType, file.name);

    // Proxy mode (?proxy=1): stream the file through the server so the client
    // can observe byte progress and resume via Range requests. Costs server
    // bandwidth, so it is opt-in — the default path redirects straight to R2.
    if (request.nextUrl.searchParams.get("proxy") === "1") {
      const range = request.headers.get("range") ?? undefined;
      const obj = await downloadFromR2Stream(file.r2Key, range);
      if (!obj.body) {
        return apiError("File stream unavailable", 502);
      }

      const headers = new Headers({
        "Content-Type": safeMimeType,
        "Content-Disposition": `attachment; ${encodeContentDispositionFilename(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      if (obj.contentLength != null) headers.set("Content-Length", String(obj.contentLength));
      if (obj.contentRange) headers.set("Content-Range", obj.contentRange);

      // 206 when responding to a Range request, else 200.
      const status = range && obj.contentRange ? 206 : 200;

      // A Response body needs a WEB ReadableStream. In the Node runtime the AWS
      // SDK gives a Node Readable, so convert it; if it's already a web stream
      // (edge runtime), use it as-is.
      const body = obj.body as unknown;
      const webStream =
        typeof (body as { pipe?: unknown }).pipe === "function"
          ? (Readable.toWeb(body as Readable) as unknown as ReadableStream)
          : (body as ReadableStream);

      return new Response(webStream, { status, headers });
    }

    // Default: force download straight from R2. The disposition and content-type
    // are baked into the presigned URL so R2 serves them directly — headers on
    // our 302 redirect would not carry over to R2.
    const url = await getPresignedDownloadUrl(file.r2Key, {
      downloadName: file.name,
      contentType: safeMimeType,
    });

    return Response.redirect(url, 302);
  } catch (error) {
    return handleApiError(error);
  }
}
