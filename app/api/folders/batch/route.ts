import { NextRequest } from "next/server";
import { eq, and, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, recalculateUsedBytes } from "@/shared/infrastructure/db";
import { folders, files, type Folder } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp, type SessionUser } from "@/shared/lib/auth/session";
import { getEffectiveUserId, resolveFolderAccess, shareRefusal } from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf, checkUserApiRateLimit } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { escapeLike } from "@/shared/lib/utils";
import { deleteR2Objects } from "@files/infrastructure/storage/r2";
import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";
import { UPLOAD_RATE_MULTIPLIER } from "@files/application/commands/limits";

/**
 * Kept in step with `FOLDER_BATCH_SIZE` in `src/features/files/domain/services/folder-tree-upload.ts`: the
 * client chunks a tree of any size into requests of at most this many paths. The
 * old cap of 200 in a single un-chunked request is why uploading a real project
 * silently lost its folders — this repository has 1,193 directories without
 * `node_modules`, so the request never got past validation.
 *
 * Each request reloads the caller's whole folder index once, so a bigger chunk is
 * strictly cheaper per path; 2,000 keeps a 20,000-directory tree down to ten calls.
 */
const MAX_PATHS_PER_REQUEST = 2000;

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
 * PostgreSQL and a request that timed out long before it finished; the same chunk now
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

/**
 * Create every folder in `paths`, one multi-row INSERT per depth level, and return
 * the path → id map.
 *
 * The previous shape was a `getOrCreateFolder` per path that inserted one row at a
 * time, awaiting each: a 10,000-directory project meant 10,000 sequential INSERT
 * round-trips and a request that ran for minutes before the platform killed it. The
 * dependency here is only ever parent → child, so a whole level can go in one
 * statement, turning that into one INSERT per level — about ten for any real tree.
 *
 * `paths` is expanded to include ancestors: a caller that asks for `a/b/c` gets `a`
 * and `a/b` too, so a client that chunks mid-subtree cannot produce an orphan.
 */
async function createFolderLevels(
  ownerId: string,
  paths: string[],
  cache: Map<string, FolderNode>,
  root: Folder | null
): Promise<Record<string, string>> {
  const rootPath = root?.materializedPath ?? "/";
  const rootDepth = root ? root.depth : -1;
  const rootId = root?.id ?? null;

  // Ancestors first, then group by depth. A Set keeps the expansion idempotent.
  const wanted = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    for (let i = 1; i <= parts.length; i++) wanted.add(parts.slice(0, i).join("/"));
  }

  const byLevel = new Map<number, string[]>();
  for (const path of wanted) {
    const level = path.split("/").length;
    const bucket = byLevel.get(level);
    if (bucket) bucket.push(path);
    else byLevel.set(level, [path]);
  }

  const resolved: Record<string, string> = {};
  /** path → materializedPath, so a child never has to re-derive its parent's. */
  const materialized = new Map<string, string>();
  const levels = [...byLevel.keys()].sort((a, b) => a - b);

  for (const level of levels) {
    const pending: { path: string; parentId: string | null; name: string; materializedPath: string; depth: number }[] = [];

    for (const path of byLevel.get(level)!) {
      const parts = path.split("/");
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join("/");
      // Levels run shallow-first, so the parent is already resolved unless it is
      // the root itself (level 1) or its own creation was skipped.
      const parentId = parentPath === "" ? rootId : resolved[parentPath];
      if (parentId === undefined) continue; // Parent missing: skip the whole subtree.
      // Paths of created folders must continue the ROOT's path, not restart at "/":
      // an upload into a subfolder used to write "/a/b/" for a folder that really
      // lives at "/root/a/b/".
      const parentMaterialized = parentPath === "" ? rootPath : materialized.get(parentPath);
      if (parentMaterialized === undefined) continue;

      const known = cache.get(cacheKey(parentId, name));
      if (known) {
        resolved[path] = known.id;
        materialized.set(path, known.materializedPath);
        continue;
      }
      pending.push({
        path,
        parentId,
        name,
        materializedPath: `${parentMaterialized}${name}/`,
        depth: rootDepth + level,
      });
    }

    if (pending.length === 0) continue;

    const inserted = await db
      .insert(folders)
      .values(
        pending.map((row) => ({
          userId: ownerId,
          parentId: row.parentId,
          name: row.name,
          materializedPath: row.materializedPath,
          depth: row.depth,
        }))
      )
      .returning({ id: folders.id, parentId: folders.parentId, name: folders.name, materializedPath: folders.materializedPath, depth: folders.depth });

    // `returning` preserves the order of `values`, but matching on parent+name is
    // independent of that guarantee and costs nothing.
    const byKey = new Map(inserted.map((row) => [cacheKey(row.parentId, row.name), row]));
    for (const row of pending) {
      const created = byKey.get(cacheKey(row.parentId, row.name));
      if (!created) continue;
      resolved[row.path] = created.id;
      materialized.set(row.path, created.materializedPath);
      cache.set(cacheKey(row.parentId, row.name), {
        id: created.id,
        materializedPath: created.materializedPath,
        depth: created.depth,
      });
    }
  }

  return resolved;
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();
    // Folder creation is part of an upload, not a page load: a folder upload issues
    // one of these per chunk of the tree back to back. On the plain per-user bucket
    // a real project tripped the limit mid-tree, `createFolderTree` threw, and the
    // client abandoned the upload with the folders from earlier chunks already
    // created — the "only folder names arrived" bug. Shares the upload bucket with
    // /api/uploads/* so the two cannot starve each other.
    const rl = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute, {
      bucket: "upload",
      multiplier: UPLOAD_RATE_MULTIPLIER,
    });
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
      .filter((p) => p.length > 0);

    const cache = await loadFolderIndex(ownerId);
    const result = await createFolderLevels(ownerId, uniquePaths, cache, root);

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
      // `LIKE`/`escapeLike`, matching app/api/folders/route.ts — a `%` or `_` in a
      // folder name would otherwise turn a subtree pattern into a wildcard over
      // the whole account, and `ILIKE` matched case-variant siblings too.
      const pattern = `${escapeLike(folder.materializedPath)}%`;
      if (body.action === "delete") {
        await db.execute(
          sql`
            UPDATE ${files}
            SET deleted_at = ${now}
            WHERE folder_id IN (
              SELECT id FROM ${folders}
              WHERE user_id = ${folder.userId}
                AND materialized_path LIKE ${pattern}
            )
          `
        );
        await db.execute(
          sql`
            UPDATE ${folders}
            SET deleted_at = ${now}
            WHERE user_id = ${folder.userId}
              AND materialized_path LIKE ${pattern}
          `
        );
      } else {
        await db.execute(
          sql`
            UPDATE ${folders}
            SET deleted_at = NULL
            WHERE user_id = ${folder.userId}
              AND materialized_path LIKE ${pattern}
          `
        );
        await db.execute(
          sql`
            UPDATE ${files}
            SET deleted_at = NULL
            WHERE folder_id IN (
              SELECT id FROM ${folders}
              WHERE user_id = ${folder.userId}
                AND materialized_path LIKE ${pattern}
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
      // Exact, literal prefix — see the note on the same pattern above.
      const pattern = `${escapeLike(folder.materializedPath)}%`;
      const subtreeFiles = await db
        .select({ r2Key: files.r2Key, thumbnailKey: files.thumbnailKey })
        .from(files)
        .where(
          sql`${files.folderId} IN (
            SELECT id FROM ${folders}
            WHERE user_id = ${folder.userId}
              AND materialized_path LIKE ${pattern}
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
              AND materialized_path LIKE ${pattern}
          )
        `
      );
      await db.execute(
        sql`
          DELETE FROM ${folders}
          WHERE user_id = ${folder.userId}
            AND materialized_path LIKE ${pattern}
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
