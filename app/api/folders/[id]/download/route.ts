import { NextRequest } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { archiveJobItems, archiveJobs, files, folders } from "@/lib/db/schema";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId, resolveFolderAccess } from "@/lib/auth/permissions";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { enqueueJob } from "@/lib/queue";
import { escapeLike } from "@/lib/utils";

const requestSchema = z.object({
  idempotencyKey: z.string().min(16).max(128).optional(),
  archiveName: z.string().min(1).max(180).optional(),
});

function archiveSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/]/g, "_")
     
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  return cleaned === "." || cleaned === ".." || cleaned.length === 0 ? "_" : cleaned;
}

function archiveFileName(value: string): string {
  const base = archiveSegment(value).replace(/\.zip$/i, "");
  return `${base || "archive"}.zip`;
}

function uniqueArchivePath(path: string, used: Map<string, number>): string {
  const count = used.get(path) ?? 0;
  used.set(path, count + 1);
  if (count === 0) return path;

  const slash = path.lastIndexOf("/");
  const parent = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const renamed = dot > 0
    ? `${name.slice(0, dot)} (${count})${name.slice(dot)}`
    : `${name} (${count})`;
  return `${parent}${renamed}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuthOrApiKey(request, ["download"]);
    const userId = getEffectiveUserId(sessionUser);
    const { id: folderId } = await params;
    const access = await resolveFolderAccess(sessionUser, folderId);
    if (!access?.canView) return apiError("Folder not found", 404);

    const body = requestSchema.parse(await request.json().catch(() => ({})));
    const idempotencyKey = body.idempotencyKey ?? crypto.randomUUID();
    const [existing] = await db
      .select()
      .from(archiveJobs)
      .where(and(eq(archiveJobs.userId, userId), eq(archiveJobs.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return apiSuccess({ job: existing }, existing.status === "ready" ? 200 : 202);

    const folderPrefix = `${escapeLike(access.folder.materializedPath)}%`;
    const treeFolders = await db
      .select({ id: folders.id, materializedPath: folders.materializedPath })
      .from(folders)
      .where(and(
        eq(folders.userId, access.folder.userId),
        isNull(folders.deletedAt),
        sql`${folders.materializedPath} LIKE ${folderPrefix} ESCAPE '\\'`
      ));
    const folderIds = treeFolders.map((folder) => folder.id);
    if (!folderIds.includes(folderId)) return apiError("Folder not found", 404);

    const sourceFiles = await db
      .select({
        id: files.id,
        name: files.name,
        sizeBytes: files.sizeBytes,
        r2Key: files.r2Key,
        encrypted: files.encrypted,
        folderPath: folders.materializedPath,
      })
      .from(files)
      .innerJoin(folders, eq(files.folderId, folders.id))
      .where(and(
        eq(files.userId, access.folder.userId),
        inArray(files.folderId, folderIds),
        isNull(files.deletedAt),
        eq(files.status, "ready"),
        eq(files.isNote, false)
      ));

    if (sourceFiles.some((file) => file.encrypted)) {
      return apiError("File terenkripsi tidak bisa dimasukkan ke archive server", 400);
    }
    const downloadable = sourceFiles.filter(
      (file) => file.r2Key && file.r2Key !== "pending" && !file.r2Key.startsWith("notes/")
    );
    if (downloadable.length === 0) return apiError("Folder tidak memiliki file yang siap di-download", 400);

    const usedPaths = new Map<string, number>();
    const items = downloadable.map((file) => {
      const relativeFolder = file.folderPath.startsWith(access.folder.materializedPath)
        ? file.folderPath.slice(access.folder.materializedPath.length)
        : file.folderPath;
      const segments = relativeFolder.split("/").filter(Boolean).map(archiveSegment);
      const rawPath = [archiveSegment(access.folder.name), ...segments, archiveSegment(file.name)].join("/");
      return {
        fileId: file.id,
        archivePath: uniqueArchivePath(rawPath, usedPaths),
        objectKey: file.r2Key,
        sizeBytes: Number(file.sizeBytes),
      };
    });
    const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
    const now = new Date();
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      userId,
      folderId,
      idempotencyKey,
      objectKey: `archives/${userId}/${jobId}.zip`,
      archiveName: archiveFileName(body.archiveName ?? access.folder.name),
      status: "created" as const,
      totalFiles: items.length,
      processedFiles: 0,
      totalBytes,
      processedBytes: 0,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    };

    await db.transaction(async (tx) => {
      await tx.insert(archiveJobs).values(job);
      for (let offset = 0; offset < items.length; offset += 500) {
        await tx.insert(archiveJobItems).values(
          items.slice(offset, offset + 500).map((item) => ({ archiveJobId: jobId, ...item }))
        );
      }
    });

    const queued = await enqueueJob("build_archive", { archiveJobId: jobId }, { jobId: `archive:${jobId}` });
    if (!queued) {
      await db.update(archiveJobs).set({
        status: "failed",
        errorCode: "QUEUE_UNAVAILABLE",
        errorMessage: "Archive worker queue is unavailable",
        updatedAt: new Date(),
      }).where(and(eq(archiveJobs.id, jobId), eq(archiveJobs.status, "created")));
      return apiError("Archive worker sedang tidak tersedia, silakan coba lagi", 503);
    }

    return apiSuccess({ job }, 202);
  } catch (error) {
    return handleApiError(error);
  }
}
