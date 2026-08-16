import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { getAccessibleFile } from "@/lib/auth/permissions";
import { downloadFromR2Stream } from "@/lib/storage/r2";
import { recordBandwidth, BandwidthQuotaError } from "@/lib/billing/bandwidth";
import { apiError, handleApiError } from "@/lib/api/response";
import { getSafeMimeType, shouldForceDownload } from "@/lib/security/mime";
import JSZip from "jszip";

const TEXT_TYPES = new Set([
  "txt", "md", "mdx", "json", "yaml", "yml", "toml", "cfg", "conf",
  "ts", "tsx", "mjs", "cjs", "kt",
  "swift", "c", "cpp", "h", "hpp", "cs",
  "css", "scss", "less", "sass", "sql",
  "vue", "svelte", "astro", "gitignore", "dockerignore", "log", "csv", "tsv",
]);

const MIME_MAP: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
  pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
};

function getMime(ext: string): string {
  return MIME_MAP[ext] || (TEXT_TYPES.has(ext) ? "text/plain" : "application/octet-stream");
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;
    const filePath = request.nextUrl.searchParams.get("path");

    if (!filePath) {
      return apiError("Missing path parameter", 400);
    }

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }
    const file = accessible.file;

    const r2 = await downloadFromR2Stream(file.r2Key);
    if (!r2.body) {
      return apiError("File is empty", 404);
    }

    const chunks: Uint8Array[] = [];
    if (r2.body instanceof ReadableStream) {
      const reader = r2.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } else if ("on" in r2.body && typeof (r2.body as NodeJS.ReadableStream).on === "function") {
      const bufs: Buffer[] = [];
      for await (const chunk of r2.body as AsyncIterable<Buffer>) {
        bufs.push(chunk);
      }
      chunks.push(Buffer.concat(bufs));
    } else {
      return apiError("Unsupported stream type", 500);
    }

    const buffer = Buffer.concat(chunks);
    const zip = await JSZip.loadAsync(buffer);

    const entry = zip.file(filePath);
    if (!entry) {
      return apiError(`File "${filePath}" not found in archive`, 404);
    }

    const content = await entry.async("uint8array");
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const rawMime = getMime(ext);
    const safeMime = getSafeMimeType(rawMime, entry.name);
    const forceDownload = shouldForceDownload(entry.name);

    try {
      await recordBandwidth(file.userId, content.length);
    } catch (err) {
      if (err instanceof BandwidthQuotaError) {
        return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429);
      }
      throw err;
    }

    const headers = new Headers();
    headers.set("Content-Type", safeMime);
    headers.set("Content-Length", String(content.length));
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set(
      "Content-Disposition",
      forceDownload
        ? `attachment; filename="${encodeURIComponent(entry.name)}"`
        : `inline; filename="${encodeURIComponent(entry.name)}"`
    );

    return new Response(new Uint8Array(content), { status: 200, headers });
  } catch (error) {
    console.error("[ARCHIVE EXTRACT ERROR]", error);
    return handleApiError(error);
  }
}
