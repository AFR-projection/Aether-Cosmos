import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, recalculateUsedBytes } from "@/shared/infrastructure/db";
import { folders, files, type Folder } from "@/shared/infrastructure/db/schema";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import {
  getEffectiveUserId,
  listAccessibleFolders,
  resolveFolderAccess,
  shareRefusal,
} from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf, SECURITY_HEADERS, checkUserApiRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { escapeRegex } from "@/shared/lib/utils";
import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { deleteR2Objects } from "@files/infrastructure/storage/r2";
import { createFolderDeletionJob } from "@files/infrastructure/storage/deletion-service";

const LARGE_FOLDER_DELETE_THRESHOLD = 500;

/** Materialized path + depth for a new/moved folder under `parent` (null = tree root). */
function pathUnder(parent: Folder | null, name: string): { materializedPath: string; depth: number } {
  if (!parent) return { materializedPath: `/${name}/`, depth: 0 };
  return {
    materializedPath: `${parent.materializedPath}${name}/`,
    depth: parent.depth + 1,
  };
}


export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["read"]);
    const parentId = request.nextUrl.searchParams.get("parentId");
    const trash = request.nextUrl.searchParams.get("trash") === "true";

    const result = await listAccessibleFolders(
      sessionUser,
      parentId || null,
      trash
    );

    return NextResponse.json(
      { success: true, data: { folders: result } },
      {
        headers: {
          ...SECURITY_HEADERS,
          "Cache-Control": "private, max-age=10, s-maxage=10",
        },
      }
    );
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();
    const rl = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute);
    if (!rl.allowed) return apiError("Rate limit exceeded", 429);

    const body = createSchema.parse(await request.json());
    const ip = getClientIp(request);

    let ownerId = userId;
    let parent: Folder | null = null;
    if (body.parentId) {
      const access = await resolveFolderAccess(sessionUser, body.parentId);
      if (!access) return apiError("Parent folder not found", 404);
      if (!access.canEdit) return apiError(shareRefusal(access, "create"), 403);
      parent = access.folder;
      // A subfolder lives in the OWNER's tree, whoever created it — otherwise the
      // materialized path and the owner's quota would disagree with each other.
      ownerId = access.folder.userId;
    }

    cacheDelPattern(`search:${ownerId}:*`).catch(() => {});

    const { materializedPath, depth } = pathUnder(parent, body.name);

    const [folder] = await db
      .insert(folders)
      .values({
        userId: ownerId,
        parentId: body.parentId ?? null,
        name: body.name,
        materializedPath,
        depth,
      })
      .returning();

    await logActivity(sessionUser, "create_folder", {
      resourceType: "folder",
      resourceId: folder.id,
      ip,
    });

    return apiSuccess({ folder });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["rename", "move", "restore", "delete"]),
  name: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = patchSchema.parse(await request.json());
    const ip = getClientIp(request);

    // Trashed folders are visible to `restore`, so the row is resolved with deleted ones
    // included and each action checks its own capability below.
    const access = await resolveFolderAccess(sessionUser, body.id, { includeDeleted: true });
    if (!access) return apiError("Folder not found", 404);

    const folder = access.folder;
    // Every subtree rewrite below is scoped to the OWNER's rows, not the caller's: a
    // collaborator (or a master) editing someone else's folder must still update that
    // owner's children, or the materialized paths silently rot.
    const ownerId = folder.userId;

    cacheDelPattern(`search:${ownerId}:*`).catch(() => {});

    const oldPath = folder.materializedPath;

    switch (body.action) {
      case "rename": {
        if (!access.canEdit || (access.isShareRoot && !access.isOwner)) {
          return apiError(shareRefusal(access, "rename"), 403);
        }
        if (!body.name) return apiError("Name required", 400);
        const parentPrefix = folder.materializedPath.slice(0, -(folder.name.length + 1));
        const newPath = `${parentPrefix}${body.name}/`;
        await db
          .update(folders)
          .set({ name: body.name, materializedPath: newPath, updatedAt: new Date() })
          .where(eq(folders.id, body.id));
        // Bulk update all children — single SQL query
        const oldLen = oldPath.length;
        await db.execute(
          sql`
            UPDATE ${folders}
            SET materialized_path = CONCAT(${newPath}, SUBSTRING(materialized_path, ${oldLen + 1})),
                updated_at = NOW()
            WHERE user_id = ${ownerId}
              AND materialized_path ILIKE ${escapeRegex(oldPath) + '%'}
              AND id != ${body.id}
          `
        );
        await logActivity(sessionUser, "rename", { resourceType: "folder", resourceId: body.id, ip });
        break;
      }
      case "move": {
        if (!access.canEdit || (access.isShareRoot && !access.isOwner)) {
          return apiError(shareRefusal(access, "move"), 403);
        }

        let parent: Folder | null = null;
        if (body.parentId) {
          const destAccess = await resolveFolderAccess(sessionUser, body.parentId);
          if (!destAccess) return apiError("Destination folder not found", 404);
          if (!destAccess.canEdit) return apiError(shareRefusal(destAccess, "move"), 403);
          if (destAccess.folder.userId !== ownerId) {
            return apiError("A folder can't be moved into another owner's account", 400);
          }
          // Moving a folder inside its own subtree would orphan the whole branch.
          if (
            destAccess.folder.id === folder.id ||
            destAccess.folder.materializedPath.startsWith(oldPath)
          ) {
            return apiError("A folder can't be moved inside itself", 400);
          }
          parent = destAccess.folder;
        } else if (!access.isOwner) {
          // Moving to the tree root would drag the folder out of the shared subtree.
          return apiError(shareRefusal(access, "move"), 403);
        }

        const { materializedPath: newPath, depth } = pathUnder(parent, folder.name);
        await db
          .update(folders)
          .set({ parentId: body.parentId ?? null, materializedPath: newPath, depth, updatedAt: new Date() })
          .where(eq(folders.id, body.id));
        // Bulk update all children — single SQL query
        const oldLen = oldPath.length;
        const depthDiff = depth - folder.depth;
        await db.execute(
          sql`
            UPDATE ${folders}
            SET materialized_path = CONCAT(${newPath}, SUBSTRING(materialized_path, ${oldLen + 1})),
                depth = depth + ${depthDiff},
                updated_at = NOW()
            WHERE user_id = ${ownerId}
              AND materialized_path ILIKE ${escapeRegex(oldPath) + '%'}
              AND id != ${body.id}
          `
        );
        await logActivity(sessionUser, "move", { resourceType: "folder", resourceId: body.id, ip });
        break;
      }
      case "delete": {
        if (!access.canTrashFolder) return apiError(shareRefusal(access, "delete"), 403);
        // Bulk soft-delete all sub-folders and their files — single queries
        await db.execute(
          sql`
            UPDATE ${folders}
            SET deleted_at = NOW()
            WHERE user_id = ${ownerId}
              AND materialized_path ILIKE ${escapeRegex(folder.materializedPath) + '%'}
          `
        );
        await db.execute(
          sql`
            UPDATE ${files}
            SET deleted_at = NOW()
            WHERE folder_id IN (
              SELECT id FROM ${folders}
              WHERE user_id = ${ownerId}
                AND materialized_path ILIKE ${escapeRegex(folder.materializedPath) + '%'}
            )
          `
        );
        await recalculateUsedBytes(ownerId);
        await logActivity(sessionUser, "delete_folder", {
          resourceType: "folder",
          resourceId: body.id,
          metadata: { onBehalfOfOwner: !access.isOwner ? ownerId : undefined },
          ip,
        });
        break;
      }
      case "restore": {
        if (!access.canPurge) return apiError(shareRefusal(access, "restore"), 403);
        // The whole subtree went to the bin together, so it comes back together —
        // restoring only the top row used to leave the children stranded there.
        await db.execute(
          sql`
            UPDATE ${folders}
            SET deleted_at = NULL
            WHERE user_id = ${ownerId}
              AND materialized_path ILIKE ${escapeRegex(folder.materializedPath) + '%'}
          `
        );
        await db.execute(
          sql`
            UPDATE ${files}
            SET deleted_at = NULL
            WHERE folder_id IN (
              SELECT id FROM ${folders}
              WHERE user_id = ${ownerId}
                AND materialized_path ILIKE ${escapeRegex(folder.materializedPath) + '%'}
            )
          `
        );
        await recalculateUsedBytes(ownerId);
        await logActivity(sessionUser, "restore", { resourceType: "folder", resourceId: body.id, ip });
        break;
      }
    }

    return apiSuccess({ id: body.id });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id, permanent, idempotencyKey } = z
      .object({ id: z.string().uuid(), permanent: z.boolean().default(false), idempotencyKey: z.string().min(16).max(128).optional() })
      .parse(await request.json());
    const ip = getClientIp(request);

    const [folder] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
    if (!folder) return apiError("Folder not found", 404);

    const access = await resolveFolderAccess(sessionUser, id, { includeDeleted: true });
    if (!access) return apiError("Folder not found", 404);
    // Deleting a whole folder tree — permanently or into the bin — stays with the owner.
    // A collaborator leaves the share instead (DELETE /api/folders/[id]/members).
    if (permanent ? !access.canPurge : !access.canTrashFolder) {
      return apiError(shareRefusal(access, "delete"), 403);
    }

    const subPathPattern = `${escapeRegex(folder.materializedPath)}%`;

    if (permanent) {
      const subtreeFiles = await db
        .select({ r2Key: files.r2Key, thumbnailKey: files.thumbnailKey })
        .from(files)
        .where(
          sql`${files.folderId} IN (
            SELECT id FROM ${folders}
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${subPathPattern}
          )`
        );

      if (subtreeFiles.length > LARGE_FOLDER_DELETE_THRESHOLD) {
        const deletion = await createFolderDeletionJob(
          folder.userId,
          folder.id,
          idempotencyKey ?? crypto.randomUUID()
        );
        if (!deletion) return apiError("Folder not found", 404);
        if (!deletion.queued) return apiError("The deletion worker is unavailable right now — please try again", 503);
        await logActivity(sessionUser, "delete_folder", {
          resourceType: "folder",
          resourceId: id,
          metadata: { permanent: true, asynchronous: true, jobId: deletion.job.id, count: subtreeFiles.length },
          ip,
        });
        return apiSuccess({ deleteJob: deletion.job }, 202);
      }

      const keys: string[] = [];
      for (const f of subtreeFiles) {
        if (f.r2Key) keys.push(f.r2Key);
        if (f.thumbnailKey) keys.push(f.thumbnailKey);
      }
      await deleteR2Objects(keys);

      await db.execute(
        sql`
          DELETE FROM ${files}
          WHERE folder_id IN (
            SELECT id FROM ${folders}
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${subPathPattern}
          )
        `
      );
      await db.execute(
        sql`
          DELETE FROM ${folders}
          WHERE user_id = ${folder.userId}
            AND materialized_path ILIKE ${subPathPattern}
        `
      );
      await recalculateUsedBytes(folder.userId);
    } else {
      const now = new Date();
      await db.execute(
        sql`
          UPDATE ${files}
          SET deleted_at = NOW()
          WHERE folder_id IN (
            SELECT id FROM ${folders}
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${subPathPattern}
          )
        `
      );
      await db.execute(
        sql`
          UPDATE ${folders}
          SET deleted_at = NOW()
          WHERE user_id = ${folder.userId}
            AND materialized_path ILIKE ${subPathPattern}
        `
      );
      await recalculateUsedBytes(folder.userId);
    }

    await logActivity(sessionUser, "delete_folder", {
      resourceType: "folder",
      resourceId: id,
      metadata: { permanent },
      ip,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
