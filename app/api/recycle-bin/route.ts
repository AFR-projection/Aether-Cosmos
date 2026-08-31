import { NextRequest } from "next/server";
import { eq, and, isNotNull, desc } from "drizzle-orm";
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

    const fileConditions = [isNotNull(files.deletedAt)];
    const folderConditions = [isNotNull(folders.deletedAt)];

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
