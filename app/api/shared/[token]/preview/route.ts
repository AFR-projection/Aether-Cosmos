import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { shares, files } from "@/lib/db/schema";
import { downloadFromR2Stream } from "@/lib/storage/r2";
import { apiError, handleApiError } from "@/lib/api/response";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
    if (!share) return apiError("Share not found", 404);

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, share.fileId), isNull(files.deletedAt), eq(files.status, "ready")))
      .limit(1);

    if (!file) return apiError("File not found", 404);

    // Duration Check
    if (share.expiresAt && share.expiresAt < new Date()) {
      return apiError("Share link expired", 410);
    }

    // Access Count Check (already incremented by info endpoint)
    if (share.maxAccessCount && share.accessCount >= share.maxAccessCount) {
      return apiError("Share link has reached maximum access limit", 403);
    }

    // Stream file dari R2 langsung ke browser
    const r2 = await downloadFromR2Stream(file.r2Key);

    if (!r2.body) {
      return apiError("File is empty", 404);
    }

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
    headers.set("Content-Type", file.mimeType);
    headers.set("Content-Length", String(r2.contentLength ?? 0));
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", "bytes");

    return new Response(stream, { status: 200, headers });
  } catch (error) {
    return handleApiError(error);
  }
}
