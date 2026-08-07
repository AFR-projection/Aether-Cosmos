import { NextRequest } from "next/server";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, recalculateUsedBytes } from "@/lib/db";
import { folders, files } from "@/lib/db/schema";
import { requireAuth, getClientIp } from "@/lib/auth/session";
import { getEffectiveUserId, canAccessUserResource } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import { validateCsrf, checkUserApiRateLimit } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { getAdminSettings } from "@/lib/admin-settings";
import { escapeRegex } from "@/lib/utils";
import { deleteR2Objects } from "@/lib/storage/r2";
import { cacheDelPattern } from "@/lib/cache/redis";

const schema = z.object({
  paths: z.array(z.string().min(1).max(1024)).min(1).max(200),
  rootFolderId: z.string().uuid().nullable().optional(),
});

async function getOrCreateFolder(
  userId: string,
  pathParts: string[],
  cache: Map<string, string>,
  rootFolderId: string | null = null,
): Promise<string | null> {
  let parentId: string | null = rootFolderId;

  for (let i = 0; i < pathParts.length; i++) {
    const name: string = pathParts[i];
    const cacheKey: string = `${parentId ?? "root"}:${name}`;

    if (cache.has(cacheKey)) {
      parentId = cache.get(cacheKey)!;
      continue;
    }

    const conditions = [
      eq(folders.userId, userId),
      eq(folders.name, name),
      isNull(folders.deletedAt),
    ];
    if (parentId) {
      conditions.push(eq(folders.parentId, parentId));
    } else {
      conditions.push(isNull(folders.parentId));
    }

    const [existing] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(...conditions))
      .limit(1);

    if (existing) {
      parentId = existing.id;
      cache.set(cacheKey, parentId);
      continue;
    }

    const materializedPath = `/${pathParts.slice(0, i + 1).join("/")}/`;
    const depth = i;

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
    cache.set(cacheKey, created.id);
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

    const uniquePaths = [...new Set(paths.map((p: string) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")))];

    const cache = new Map<string, string>();
    const result: Record<string, string> = {};

    for (const path of uniquePaths) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 0) continue;
      const folderId = await getOrCreateFolder(userId, parts, cache, rootFolderId ?? null);
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

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = opsSchema.parse(await request.json());
    const ip = getClientIp(request);

    const rows = await db.select().from(folders).where(inArray(folders.id, body.ids));
    if (rows.length === 0) return apiError("No folders found", 404);

    for (const row of rows) {
      if (!canAccessUserResource(sessionUser, row.userId)) {
        return apiError("Folder not found", 404);
      }
    }

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

    const rows = await db.select().from(folders).where(inArray(folders.id, body.ids));
    if (rows.length === 0) return apiError("No folders found", 404);

    for (const row of rows) {
      if (!canAccessUserResource(sessionUser, row.userId)) {
        return apiError("Folder not found", 404);
      }
    }

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
