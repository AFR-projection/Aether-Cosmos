import { NextRequest } from "next/server";
import { eq, and, isNull, isNotNull, desc } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { files, folders } from "@/shared/infrastructure/db/schema";
import { requireAuth, requireMaster } from "@/shared/lib/auth/session";
import { getEffectiveUserId, isMaster } from "@/shared/lib/auth/permissions";
import { apiSuccess, handleApiError } from "@/shared/api/response";

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuth();
    const allUsers = request.nextUrl.searchParams.get("all") === "true";

    if (allUsers && !isMaster(sessionUser)) {
      await requireMaster();
    }

    const userId = allUsers ? undefined : getEffectiveUserId(sessionUser);

    // `restore_batch_id IS NULL` is the one read-path change the per-account restore needs.
    // A restore stages its rows with `deleted_at = NOW()` so every other listing hides them
    // for free; this endpoint is the single place that looks for deleted rows on purpose, and
    // without the filter a restore in flight would spill half an archive into the bin. Both
    // arms get it, including the master's `?all=true` view — a staged row is not in anyone's
    // recycle bin, not even the operator's.
    const fileConditions = [isNotNull(files.deletedAt), isNull(files.restoreBatchId)];
    const folderConditions = [isNotNull(folders.deletedAt), isNull(folders.restoreBatchId)];

    if (userId) {
      fileConditions.push(eq(files.userId, userId));
      folderConditions.push(eq(folders.userId, userId));
    }

    const deletedFiles = await db
      .select()
      .from(files)
      .where(and(...fileConditions))
      .orderBy(desc(files.deletedAt))
      .limit(100);

    const deletedFolders = await db
      .select()
      .from(folders)
      .where(and(...folderConditions))
      .orderBy(desc(folders.deletedAt))
      .limit(100);

    return apiSuccess({ files: deletedFiles, folders: deletedFolders });
  } catch (error) {
    return handleApiError(error);
  }
}
