import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { folderMembers, folders, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { apiSuccess, handleApiError } from "@/lib/api/response";

export async function GET(_request: NextRequest) {
  try {
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);

    const rows = await db
      .select({
        memberId: folderMembers.id,
        role: folderMembers.role,
        sharedAt: folderMembers.createdAt,
        folderId: folders.id,
        folderName: folders.name,
        folderCreatedAt: folders.createdAt,
        ownerId: folders.userId,
        ownerUsername: users.username,
      })
      .from(folderMembers)
      .innerJoin(folders, and(eq(folderMembers.folderId, folders.id), isNull(folders.deletedAt)))
      .innerJoin(users, eq(folders.userId, users.id))
      .where(eq(folderMembers.userId, userId))
      .orderBy(folderMembers.createdAt);

    return apiSuccess({ shared: rows });
  } catch (error) {
    return handleApiError(error);
  }
}
