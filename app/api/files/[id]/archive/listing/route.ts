import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/session";
import { resolveFileAccess } from "@/lib/auth/permissions";
import { downloadFromR2Stream } from "@/lib/storage/r2";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import {
  ARCHIVE_INSPECT_MAX_BYTES,
  archiveErrorResponse,
  archiveTooLargeResponse,
  readArchiveBuffer,
} from "@/lib/storage/archive-read";
import JSZip from "jszip";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;

    // Peeking inside an archive is a read: a member of the shared folder may do it.
    const accessible = await resolveFileAccess(sessionUser, id);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }
    const file = accessible.file;

    // Refuse before spending the bandwidth when the recorded size already says no.
    if (Number(file.sizeBytes) > ARCHIVE_INSPECT_MAX_BYTES) {
      return archiveTooLargeResponse();
    }

    const r2 = await downloadFromR2Stream(file.r2Key);
    if (!r2.body) {
      return apiError("File is empty", 404);
    }

    let buffer: Buffer;
    try {
      buffer = await readArchiveBuffer(r2.body, ARCHIVE_INSPECT_MAX_BYTES);
    } catch (error) {
      const response = archiveErrorResponse(error);
      if (response) return response;
      throw error;
    }

    const zip = await JSZip.loadAsync(buffer);

    const entries: Array<{
      path: string;
      name: string;
      dir: boolean;
      size: number;
      compressedSize: number;
      date: string;
    }> = [];

    let totalFiles = 0;
    let totalFolders = 0;
    let totalSize = 0;
    let totalCompressedSize = 0;

    zip.forEach((path, entry) => {
      const isDir = entry.dir;
      const raw = entry as typeof entry & {
        uncompressedSize?: number;
        compressedSize?: number;
      };
      const size = isDir ? 0 : (raw.uncompressedSize ?? 0);
      const compressedSize = isDir ? 0 : (raw.compressedSize ?? 0);
      const name = path.split("/").pop() || path;
      entries.push({
        path,
        name,
        dir: isDir,
        size,
        compressedSize,
        date: entry.date ? entry.date.toISOString() : "",
      });
      if (isDir) {
        totalFolders++;
      } else {
        totalFiles++;
        totalSize += size;
        totalCompressedSize += compressedSize;
      }
    });

    entries.sort((a, b) => {
      if (a.dir && !b.dir) return -1;
      if (!a.dir && b.dir) return 1;
      return a.path.localeCompare(b.path);
    });

    return apiSuccess({
      entries,
      summary: {
        totalFiles,
        totalFolders,
        totalSize,
        totalCompressedSize,
        format: file.name.split(".").pop()?.toLowerCase() ?? "zip",
      },
    });
  } catch (error) {
    console.error("[ARCHIVE LISTING ERROR]", error);
    return handleApiError(error);
  }
}
