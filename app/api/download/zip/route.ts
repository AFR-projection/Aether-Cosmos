import { NextRequest } from "next/server";
import { Readable, PassThrough } from "stream";
import { ZipArchive } from "archiver";
import { z } from "zod";
import { inArray, and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getClientIp } from "@/lib/auth/session";
import { canAccessUserResource, getEffectiveUserId } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import { downloadFromR2Stream } from "@/lib/storage/r2";
import { validateCsrf } from "@/lib/security";
import { apiError, handleApiError } from "@/lib/api/response";
import { recordBandwidth, BandwidthQuotaError } from "@/lib/billing/bandwidth";

const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

function uniqueZipName(name: string, used: Map<string, number>): string {
  const count = used.get(name) ?? 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)} (${count})${name.slice(dot)}`;
  return `${name} (${count})`;
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const sessionUser = await requireAuthOrApiKey(request, ["download"]);
    const userId = getEffectiveUserId(sessionUser);
    const body = schema.parse(await request.json());
    const ip = getClientIp(request);

    const rows = await db
      .select()
      .from(files)
      .where(and(inArray(files.id, body.ids), isNull(files.deletedAt), eq(files.status, "ready")));

    if (rows.length === 0) return apiError("No files found", 404);

    for (const row of rows) {
      if (!canAccessUserResource(sessionUser, row.userId)) {
        return apiError("File not found", 404);
      }
    }

    const downloadable = rows.filter(
      (r) => !r.isNote && r.r2Key && r.r2Key !== "pending" && !r.r2Key.startsWith("notes/")
    );

    // End-to-end encrypted files are stored as ciphertext the server can't
    // decrypt. Never let them into a server-built ZIP — that would leak
    // unusable-but-unprotected bytes and defeat the passphrase gate. They must
    // be downloaded individually and decrypted in the browser.
    const encryptedInSelection = downloadable.filter((r) => r.encrypted);
    if (encryptedInSelection.length > 0) {
      return apiError(
        "File terenkripsi tidak bisa dimasukkan ke ZIP — download satu per satu dengan passphrase",
        400
      );
    }

    if (downloadable.length === 0) {
      return apiError("No downloadable files in selection", 400);
    }

    const totalBytes = downloadable.reduce((s, f) => s + Number(f.sizeBytes || 0), 0);
    if (totalBytes > MAX_ZIP_BYTES) {
      return apiError("Selected files exceed the 2 GB ZIP limit", 400);
    }

    try {
      await recordBandwidth(userId, totalBytes);
    } catch (err) {
      if (err instanceof BandwidthQuotaError) {
        return apiError(err.message, 429);
      }
      throw err;
    }

    const pass = new PassThrough();
    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on("error", (err: Error) => {
      console.error("[zip]", err);
      pass.destroy(err);
    });
    archive.pipe(pass);

    const nameCounts = new Map<string, number>();

    void (async () => {
      try {
        for (const file of downloadable) {
          const obj = await downloadFromR2Stream(file.r2Key);
          if (!obj.body) continue;

          // In the Node runtime the AWS SDK returns a Node Readable (e.g.
          // ChecksumStream) which archiver accepts directly. Only convert when
          // R2 hands back a web ReadableStream (edge/other runtimes).
          const body = obj.body as unknown;
          const nodeStream =
            typeof (body as { pipe?: unknown }).pipe === "function"
              ? (body as Readable)
              : Readable.fromWeb(body as import("stream/web").ReadableStream);

          const entryName = uniqueZipName(file.name, nameCounts);
          archive.append(nodeStream, { name: entryName });
        }
        await archive.finalize();
      } catch (err) {
        console.error("[zip] build failed", err);
        try {
          archive.abort();
        } catch {
          // ignore
        }
        pass.destroy(err instanceof Error ? err : new Error("ZIP failed"));
      }
    })();

    await logActivity(sessionUser, "download", {
      resourceType: "file",
      resourceId: downloadable[0].id,
      metadata: { zip: true, count: downloadable.length, totalBytes },
      ip,
    });

    const webStream = Readable.toWeb(pass) as unknown as ReadableStream;

    return new Response(webStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="download.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
