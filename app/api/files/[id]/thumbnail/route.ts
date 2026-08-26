import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { resolveFileAccess } from "@/lib/auth/permissions";
import { downloadFromR2Stream } from "@/lib/storage/r2";
import { apiError } from "@/lib/api/response";

const THUMB_SIZES = [150, 300, 600, 1200] as const;
type ThumbSize = (typeof THUMB_SIZES)[number];

/** Largest original we will serve verbatim when no thumbnail exists yet. */
const ORIGINAL_FALLBACK_MAX_BYTES = 256 * 1024;

function parseSize(val: string | null): ThumbSize {
  const n = parseInt(val ?? "300", 10);
  if (THUMB_SIZES.includes(n as ThumbSize)) return n as ThumbSize;
  return 300;
}

function getThumbKey(fileId: string, size: ThumbSize, ext: string = "webp"): string {
  return `thumbnails/${fileId}_${size}.${ext}`;
}

function getLegacyThumbKey(fileId: string): string {
  return `thumbnails/${fileId}.jpg`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;
    const size = parseSize(request.nextUrl.searchParams.get("size"));

    // Ownership was not the right question: a member browsing a shared folder could list
    // the files but every thumbnail 404'd, so the grid rendered nothing but placeholders.
    const accessible = await resolveFileAccess(sessionUser, id);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }
    const file = accessible.file;

    const thumbKey = getThumbKey(file.id, size);
    const legacyKey = getLegacyThumbKey(file.id);

    // Prefer the size-specific key, then whatever thumbnailKey points to
    // (e.g. legacy .jpg or the default 300px).
    const keysToTry = [thumbKey];
    if (file.thumbnailKey && !keysToTry.includes(file.thumbnailKey)) {
      keysToTry.push(file.thumbnailKey);
    }
    if (file.thumbnailKey === legacyKey && !keysToTry.includes(legacyKey)) {
      keysToTry.push(legacyKey);
    }
    // Falling back to the original is only safe when the original is already
    // thumbnail-sized. Streaming a multi-megabyte camera photo into a 170px
    // grid tile burns the user's data and stalls low-end devices, so anything
    // larger returns 404 and the UI renders its icon placeholder instead.
    if (file.mimeType.startsWith("image/") && file.sizeBytes <= ORIGINAL_FALLBACK_MAX_BYTES) {
      keysToTry.push(file.r2Key);
    }

    for (const r2Key of keysToTry) {
      try {
        // No HEAD probe first — GET already fails on a missing key, and the
        // extra round trip doubled R2 latency for every tile in the grid.
        const r2 = await downloadFromR2Stream(r2Key);
        if (!r2.body) continue;

        let stream: ReadableStream;
        if (r2.body instanceof ReadableStream) {
          stream = r2.body;
        } else if ("pipe" in r2.body && typeof r2.body.pipe === "function") {
          stream = new ReadableStream({
            start(controller) {
              const nodeStream = r2.body as NodeJS.ReadableStream;
              nodeStream.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
              nodeStream.on("end", () => controller.close());
              nodeStream.on("error", (err: Error) => controller.error(err));
            },
          });
        } else {
          stream = r2.body as unknown as ReadableStream;
        }

        const headers = new Headers();
        const contentType = r2Key === file.r2Key
          ? file.mimeType
          : r2Key.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg";
        headers.set("Content-Type", contentType);
        headers.set("Content-Length", String(r2.contentLength ?? 0));
        // `private`: these are per-user files behind auth, so shared proxies
        // and CDNs must never hold a copy.
        headers.set("Cache-Control", "private, max-age=86400");

        return new Response(stream, { status: 200, headers });
      } catch {
        continue;
      }
    }

    return apiError("Thumbnail not available", 404);
  } catch (error) {
    console.error("[THUMBNAIL ERROR]", error);
    return apiError("Thumbnail not available", 500);
  }
}
