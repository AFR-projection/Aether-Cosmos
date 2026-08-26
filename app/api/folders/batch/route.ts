import { NextRequest } from "next/server";
import { eq, and, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, recalculateUsedBytes } from "@/lib/db";
import { folders, files, type Folder } from "@/lib/db/schema";
import { requireAuth, getClientIp, type SessionUser } from "@/lib/auth/session";
import { getEffectiveUserId, resolveFolderAccess, shareRefusal } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import { validateCsrf, checkUserApiRateLimit } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { getAdminSettings } from "@/lib/admin-settings";
import { escapeRegex } from "@/lib/utils";
import { deleteR2Objects } from "@/lib/storage/r2";
import { cacheDelPattern } from "@/lib/cache/redis";

/**
 * Kept in step with `FOLDER_BATCH_SIZE` in `lib/files/folder-tree-upload.ts`: the
 * client chunks a tree of any size into requests of at most this many paths. The
 * old cap of 200 in a single un-chunked request is why uploading a real project
 * silently lost its folders — this repository has 1,193 directories without
 * `node_modules`, so the request never got past validation.
 */
const MAX_PATHS_PER_REQUEST = 500;

const schema = z.object({
  paths: z.array(z.string().min(1).max(1024)).min(1).max(MAX_PATHS_PER_REQUEST),
  rootFolderId: z.string().uuid().nullable().optional(),
});

type FolderNode = { id: string; materializedPath: string; depth: number };

/** `parentId` + name is what identifies a sibling; the root level has no parent. */
function cacheKey(parentId: string | null, name: string): string {
  return `${parentId ?? "root"}:${name}`;
}

/**
 * One query for every folder the owner already has, instead of a SELECT per path
 * segment. A 500-path chunk four levels deep meant ~2,000 sequential round-trips to
 * Neon and a request that timed out long before it finished; the same chunk now
 * costs one read plus an insert per genuinely new folder.
 */
async function loadFolderIndex(ownerId: string): Promise<Map<string, FolderNode>> {
  const rows = await db
    .select({
      id: folders.id,
      parentId: folders.parentId,
      name: folders.name,
      materializedPath: folders.materializedPath,
      depth: folders.depth,
    })
    .from(folders)
    .where(and(eq(folders.userId, ownerId), isNull(folders.deletedAt)));

  const index = new Map<string, FolderNode>();
  for (const row of rows) {
    index.set(cacheKey(row.parentId, row.name), {
      id: row.id,
      materializedPath: row.materializedPath,
      depth: row.depth,
    });
  }
  return index;
}

async function getOrCreateFolder(
  userId: string,
  pathParts: string[],
  cache: Map<string, FolderNode>,
  root: Folder | null = null,
): Promise<string | null> {
  let parentId: string | null = root?.id ?? null;
  // Paths of created folders must continue the ROOT's path, not restart at "/": an upload
  // into a subfolder used to write "/a/b/" for a folder that really lives at "/root/a/b/".
  let parentPath: string = root?.materializedPath ?? "/";
  let parentDepth: number = root ? root.depth : -1;

  for (const name of pathParts) {
    const key = cacheKey(parentId, name);
    const known = cache.get(key);

    if (known) {
      parentId = known.id;
      parentPath = known.materializedPath;
      parentDepth = known.depth;
      continue;
    }

    const materializedPath = `${parentPath}${name}/`;
    const depth = parentDepth + 1;

    const [created]: { id: string }[] = await db
      .insert(folders)
      .values({
        userId,
        parentId: parentId ?? null,
        name,
        materializedPath,
        depth,
      })
      .returning({ id: folders.id });

    parentId = created.id;
    parentPath = materializedPath;
    parentDepth = depth;
    cache.set(key, { id: created.id, materializedPath, depth });
  }

  return parentId;
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();
    const rl = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute);
    if (!rl.allowed) return apiError("Rate limit exceeded", 429);
    const { paths, rootFolderId } = schema.parse(await request.json());

    // Folder trees created under a shared root belong to the folder's OWNER, and require
    // edit rights there — a viewer must not be able to seed folders in someone else's tree.
    let root: Folder | null = null;
    let ownerId = userId;
    if (rootFolderId) {
      const access = await resolveFolderAccess(sessionUser, rootFolderId);
      if (!access) return apiError("Root folder not found", 404);
      if (!access.canEdit) {
        // Same wording as every other refusal for this role — the message lives in
        // shareRefusal so a viewer is told the same thing wherever they hit the wall.
        return apiError(shareRefusal(access, "create"), 403);
      }
      root = access.folder;
      ownerId = access.folder.userId;
    }

    const uniquePaths = [...new Set(paths.map((p: string) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")))]
      // Parents before children, so a chunk that contains both creates the parent
      // once and reuses it instead of racing to insert two rows with the same name.
      .sort((a, b) => a.split("/").length - b.split("/").length);

    const cache = await loadFolderIndex(ownerId);
    const result: Record<string, string> = {};

    for (const path of uniquePaths) {
      const parts = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
      if (parts.length === 0) continue;
      const folderId = await getOrCreateFolder(ownerId, parts, cache, root);
      if (folderId) {
        result[path] = folderId;
      }
    }

    return apiSuccess({ folders: result });
  } catch (error) {
    return handleApiError(error);
  }
}

const opsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["delete", "restore"]),
});

/**
 * Resolve every id through the capability model, refusing the WHOLE batch on the first
 * folder the caller may not touch.
 *
 * All-or-nothing on purpose: a batch that half-applies is worse than one that fails, and a
 * per-row skip would silently hide "you only had view access" from the user. `resolveBatch`
 * also returns the OWNER's rows, so the subtree SQL below can never be scoped to the
 * caller's user_id by accident.
 */
async function resolveBatch(
  sessionUser: SessionUser,
  ids: string[],
  need: "canTrashFolder" | "canPurge",
  what: "delete" | "restore"
): Promise<{ rows: Folder[] } | { refusal: ReturnType<typeof apiError> }> {
  const rows: Folder[] = [];
  for (const id of ids) {
    const access = await resolveFolderAccess(sessionUser, id, { includeDeleted: true });
    if (!access) return { refusal: apiError("Folder not found", 404) };
    if (!access[need]) return { refusal: apiError(shareRefusal(access, what), 403) };
    rows.push(access.folder);
  }
  return { rows };
}

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = opsSchema.parse(await request.json());
    const ip = getClientIp(request);

    // Trashing needs canTrashFolder (false for the shared root — a member LEAVES a share
    // instead of deleting it out of the owner's account); restoring from the bin is
    // irreversible-ish bookkeeping on the owner's quota, so it needs canPurge.
    const resolved = await resolveBatch(
      sessionUser,
      body.ids,
      body.action === "delete" ? "canTrashFolder" : "canPurge",
      body.action
    );
    if ("refusal" in resolved) return resolved.refusal;
    const rows = resolved.rows;

    const now = new Date();
    const ownerIds = [...new Set(rows.map((r) => r.userId))];

    for (const folder of rows) {
      const pattern = `${escapeRegex(folder.materializedPath)}%`;
      if (body.action === "delete") {
        await db.execute(
          sql`
            UPDATE ${files}
            SET deleted_at = ${now}
            WHERE folder_id IN (
              SELECT id FROM ${folders}
              WHERE user_id = ${folder.userId}
                AND materialized_path ILIKE ${pattern}
            )
          `
        );
        await db.execute(
          sql`
            UPDATE ${folders}
            SET deleted_at = ${now}
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${pattern}
          `
        );
      } else {
        await db.execute(
          sql`
            UPDATE ${folders}
            SET deleted_at = NULL
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${pattern}
          `
        );
        await db.execute(
          sql`
            UPDATE ${files}
            SET deleted_at = NULL
            WHERE folder_id IN (
              SELECT id FROM ${folders}
              WHERE user_id = ${folder.userId}
                AND materialized_path ILIKE ${pattern}
            )
          `
        );
      }
    }

    for (const ownerId of ownerIds) {
      cacheDelPattern(`search:${ownerId}:*`).catch(() => {});
      await recalculateUsedBytes(ownerId);
    }

    await logActivity(sessionUser, body.action === "delete" ? "delete_folder" : "restore", {
      resourceType: "folder",
      resourceId: rows[0].id,
      metadata: { batch: true, count: rows.length, action: body.action },
      ip,
    });

    return apiSuccess({ ids: rows.map((r) => r.id), count: rows.length, action: body.action });
  } catch (error) {
    return handleApiError(error);
  }
}

const permanentSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  permanent: z.literal(true),
});

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = permanentSchema.parse(await request.json());
    const ip = getClientIp(request);

    // Purging someone else's tree is never a collaborator's call, whatever their role.
    const resolved = await resolveBatch(sessionUser, body.ids, "canPurge", "delete");
    if ("refusal" in resolved) return resolved.refusal;
    const rows = resolved.rows;

    const ownerIds = [...new Set(rows.map((r) => r.userId))];
    const keys: string[] = [];

    for (const folder of rows) {
      const pattern = `${escapeRegex(folder.materializedPath)}%`;
      const subtreeFiles = await db
        .select({ r2Key: files.r2Key, thumbnailKey: files.thumbnailKey })
        .from(files)
        .where(
          sql`${files.folderId} IN (
            SELECT id FROM ${folders}
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${pattern}
          )`
        );

      for (const row of subtreeFiles) {
        if (row.r2Key) keys.push(row.r2Key);
        if (row.thumbnailKey) keys.push(row.thumbnailKey);
      }

      await db.execute(
        sql`
          DELETE FROM ${files}
          WHERE folder_id IN (
            SELECT id FROM ${folders}
            WHERE user_id = ${folder.userId}
              AND materialized_path ILIKE ${pattern}
          )
        `
      );
      await db.execute(
        sql`
          DELETE FROM ${folders}
          WHERE user_id = ${folder.userId}
            AND materialized_path ILIKE ${pattern}
        `
      );
    }

    await deleteR2Objects(keys);

    for (const ownerId of ownerIds) {
      cacheDelPattern(`search:${ownerId}:*`).catch(() => {});
      await recalculateUsedBytes(ownerId);
    }

    await logActivity(sessionUser, "delete_folder", {
      resourceType: "folder",
      resourceId: rows[0].id,
      metadata: { batch: true, permanent: true, count: rows.length },
      ip,
    });

    return apiSuccess({ deleted: true, count: rows.length });
  } catch (error) {
    return handleApiError(error);
  }
}
