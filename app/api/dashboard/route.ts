import { eq, and, isNull, desc, count, sum } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { files, folders, activityLogs, users } from "@/shared/infrastructure/db/schema";
import { requireAuth } from "@/shared/lib/auth/session";
import { getEffectiveUserId, isMaster } from "@/shared/lib/auth/permissions";
import { NextResponse } from "next/server";
import { SECURITY_HEADERS } from "@/shared/lib/security";
import { handleApiError } from "@/shared/api/response";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";

export async function GET() {
  try {
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);

    const [fileStats] = await db
      .select({ total: count(), totalSize: sum(files.sizeBytes) })
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.status, "ready")));

    const [folderStats] = await db
      .select({ total: count() })
      .from(folders)
      .where(and(eq(folders.userId, userId), isNull(folders.deletedAt)));

    const recentFiles = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt), eq(files.status, "ready")))
      .orderBy(desc(files.createdAt))
      .limit(10);

    const recentActivity = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.userId, userId))
      .orderBy(desc(activityLogs.createdAt))
      .limit(15);

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    let globalStats = null;
    if (isMaster(sessionUser)) {
      const [allUsers] = await db.select({ total: count() }).from(users);
      const [allFiles] = await db
        .select({ total: count(), totalSize: sum(files.sizeBytes) })
        .from(files)
        .where(and(isNull(files.deletedAt), eq(files.status, "ready")));
      globalStats = {
        totalUsers: allUsers.total,
        totalFiles: allFiles.total,
        totalStorage: Number(allFiles.totalSize ?? 0),
      };
    }

    const usedBytes = user?.usedBytes ?? Number(fileStats.totalSize ?? 0);
    const settings = await getAdminSettings();

    const data = {
      stats: {
        totalFiles: fileStats.total,
        totalFolders: folderStats.total,
        storageUsed: usedBytes,
        storageQuota: user?.quotaBytes ?? 0,
        storageRemaining: (user?.quotaBytes ?? 0) - usedBytes,
        storageWarningThreshold: settings.storageWarningThreshold,
      },
      recentFiles,
      recentActivity,
      globalStats,
    };

    return NextResponse.json(
      { success: true, data },
      {
        headers: {
          ...SECURITY_HEADERS,
          "Cache-Control": "private, max-age=30, s-maxage=30",
        },
      }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
