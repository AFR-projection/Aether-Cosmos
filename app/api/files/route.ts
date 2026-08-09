import { NextRequest } from "next/server";
import { eq, and, isNull, isNotNull, desc, lt, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getClientIp, requireAuth } from "@/lib/auth/session";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import {
  getEffectiveUserId,
  canAccessUserResource,
  resolveFolderAccess,
  getAccessibleFile,
} from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import {
  buildR2Key,
  copyR2Object,
  deleteR2Object,
} from "@/lib/storage/r2";
import { validateCsrf, checkUserApiRateLimit } from "@/lib/security";
import { tiptapToPlainText } from "@/lib/search/tiptap-text";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache/redis";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { recalculateUsedBytes } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";
import { getAdminSettings } from "@/lib/admin-settings";

const listSchema = z.object({
  folderId: z.string().uuid().nullable().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  trash: z.coerce.boolean().default(false),
  favorites: z.coerce.boolean().default(false),
});

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["read"]);
    const userId = getEffectiveUserId(sessionUser);
    const params = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    // Shared folder: list owner's files in that folder when member has access
    if (params.folderId && !params.trash && !params.favorites) {
      const access = await resolveFolderAccess(sessionUser, params.folderId);
      if (!access?.canView) return apiError("Folder not found", 404);

      const conditions = [
        eq(files.folderId, params.folderId),
        isNull(files.deletedAt),
        inArray(files.status, ["ready", "legacy_unverified"]),
      ];
      if (params.cursor) {
        conditions.push(lt(files.createdAt, new Date(params.cursor)));
      }

      const result = await db
        .select()
        .from(files)
        .where(and(...conditions))
        .orderBy(desc(files.createdAt))
        .limit(params.limit + 1);

      const hasMore = result.length > params.limit;
      const items = hasMore ? result.slice(0, params.limit) : result;
      const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;
      return apiSuccess({ files: items, nextCursor });
    }

    const cacheKey = `files:${userId}:${JSON.stringify(params)}`;
    const cached = await cacheGet<{ files: unknown[]; nextCursor: string | null }>(cacheKey);
    if (cached && Array.isArray(cached.files) && cached.files.length > 0) {
      return apiSuccess(cached);
    }

    const conditions = [eq(files.userId, userId)];

    if (params.trash) {
      conditions.push(isNotNull(files.deletedAt));
    } else {
      conditions.push(isNull(files.deletedAt));
      conditions.push(inArray(files.status, ["ready", "legacy_unverified"]));
    }

    if (params.favorites) {
      conditions.push(eq(files.isFavorite, true));
    }

    if (params.folderId) {
      conditions.push(eq(files.folderId, params.folderId));
    } else if (!params.trash && !params.favorites) {
      conditions.push(isNull(files.folderId));
    }

    if (params.cursor) {
      conditions.push(lt(files.createdAt, new Date(params.cursor)));
    }

    const result = await db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(desc(files.createdAt))
      .limit(params.limit + 1);

    const hasMore = result.length > params.limit;
    const items = hasMore ? result.slice(0, params.limit) : result;
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;

    const data = { files: items, nextCursor };
    await cacheSet(cacheKey, data, 15);
    return apiSuccess(data);
  } catch (error) {
    return handleApiError(error);
  }
}

const createNoteSchema = z.object({
  name: z.string().min(1).max(255).default("Untitled Note"),
  folderId: z.string().uuid().nullable().optional(),
  content: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();
    const rl = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute);
    if (!rl.allowed) return apiError("Rate limit exceeded", 429);

    const body = createNoteSchema.parse(await request.json());
    const ip = getClientIp(request);

    const [file] = await db
      .insert(files)
      .values({
        userId,
        folderId: body.folderId ?? null,
        name: body.name.endsWith(".note") ? body.name : `${body.name}.note`,
        mimeType: "application/json",
        sizeBytes: 0,
        r2Key: `notes/${userId}/${crypto.randomUUID()}`,
        isNote: true,
        // Plaintext of the note body feeds the full-text search vector.
        contentText: body.content ? tiptapToPlainText(body.content) : null,
      })
      .returning();

    if (body.content) {
      const { fileContents } = await import("@/lib/db/schema");
      await db.insert(fileContents).values({
        fileId: file.id,
        contentJson: body.content,
      });
    }

    await logActivity(sessionUser, "upload", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { name: file.name, type: "note" },
      ip,
    });

    return apiSuccess({ file });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["rename", "move", "favorite", "restore", "delete", "duplicate", "copy"]),
  name: z.string().optional(),
  folderId: z.string().uuid().nullable().optional(),
  targetFolderId: z.string().uuid().nullable().optional(),
});

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const body = patchSchema.parse(await request.json());
    const patchScope = body.action === "delete" ? (["delete"] as const) : (["write"] as const);
    const sessionUser = await requireAuthOrApiKey(request, [...patchScope]);
    const userId = getEffectiveUserId(sessionUser);
    const ip = getClientIp(request);

    const [file] = await db.select().from(files).where(eq(files.id, body.id)).limit(1);
    if (!file || !canAccessUserResource(sessionUser, file.userId)) {
      return apiError("File not found", 404);
    }

    cacheDelPattern(`search:${file.userId}:*`).catch(() => {});
    cacheDelPattern(`files:${file.userId}:*`).catch(() => {});

    switch (body.action) {
      case "rename": {
        if (!body.name) return apiError("Name required", 400);
        await db.update(files).set({ name: body.name, updatedAt: new Date() }).where(eq(files.id, body.id));
        await logActivity(sessionUser, "rename", { resourceType: "file", resourceId: body.id, ip });
        break;
      }
      case "move": {
        await db
          .update(files)
          .set({ folderId: body.folderId ?? null, updatedAt: new Date() })
          .where(eq(files.id, body.id));
        await logActivity(sessionUser, "move", { resourceType: "file", resourceId: body.id, ip });
        break;
      }
      case "favorite": {
        await db
          .update(files)
          .set({ isFavorite: !file.isFavorite, updatedAt: new Date() })
          .where(eq(files.id, body.id));
        await logActivity(sessionUser, "favorite", { resourceType: "file", resourceId: body.id, ip });
        break;
      }
      case "delete": {
        await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, body.id));
        await recalculateUsedBytes(file.userId);
        await logActivity(sessionUser, "delete", { resourceType: "file", resourceId: body.id, ip });
        break;
      }
      case "restore": {
        await db.update(files).set({ deletedAt: null }).where(eq(files.id, body.id));
        await recalculateUsedBytes(file.userId);
        await logActivity(sessionUser, "restore", { resourceType: "file", resourceId: body.id, ip });
        break;
      }
      case "duplicate":
      case "copy": {
        const destFolderId = body.targetFolderId ?? file.folderId;
        const copyName = body.action === "duplicate" ? `Copy of ${file.name}` : file.name;
        const [newFile] = await db
          .insert(files)
          .values({
            userId: file.userId,
            folderId: destFolderId,
            name: copyName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            r2Key: "pending",
            checksumSha256: file.checksumSha256,
            isNote: file.isNote,
          })
          .returning();

        const newKey = buildR2Key(userId, newFile.id, copyName);
        await copyR2Object(file.r2Key, newKey);
        const now = new Date();
        await db.update(files).set({
          r2Key: newKey,
          status: "ready",
          completedAt: now,
          verifiedAt: now,
          updatedAt: now,
        }).where(eq(files.id, newFile.id));
        await logActivity(sessionUser, "copy", {
          resourceType: "file",
          resourceId: newFile.id,
          metadata: { sourceId: body.id },
          ip,
        });
        return apiSuccess({ file: newFile });
      }
    }

    return apiSuccess({ id: body.id });
  } catch (error) {
    return handleApiError(error);
  }
}

const deleteSchema = z.object({
  id: z.string().uuid(),
  permanent: z.boolean().default(false),
});

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuthOrApiKey(request, ["delete"]);
    const body = deleteSchema.parse(await request.json());
    const ip = getClientIp(request);

    const [row] = await db.select().from(files).where(eq(files.id, body.id)).limit(1);
    if (!row) return apiError("File not found", 404);

    const ownedOrMaster = canAccessUserResource(sessionUser, row.userId);
    if (!ownedOrMaster) {
      if (row.deletedAt) return apiError("File not found", 404);
      const access = await getAccessibleFile(sessionUser, body.id);
      if (!access?.canEdit) return apiError("File not found", 404);
    }

    const file = row;

    cacheDelPattern(`search:${file.userId}:*`).catch(() => {});
    cacheDelPattern(`files:${file.userId}:*`).catch(() => {});

    if (body.permanent) {
      if (!file.deletedAt) {
        return apiError("File must be in recycle bin first", 400);
      }
      await deleteR2Object(file.r2Key);
      if (file.thumbnailKey) await deleteR2Object(file.thumbnailKey);
      await db.delete(files).where(eq(files.id, body.id));
    } else {
      await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, body.id));
    }

    await recalculateUsedBytes(file.userId);

    await logActivity(sessionUser, "delete", {
      resourceType: "file",
      resourceId: body.id,
      metadata: { permanent: body.permanent },
      ip,
    });

    void dispatchWebhookEvent(file.userId, "delete", {
      fileId: body.id,
      name: file.name,
      permanent: body.permanent,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
