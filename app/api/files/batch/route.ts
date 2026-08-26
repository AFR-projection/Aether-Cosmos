import { NextRequest } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { files, type File } from "@/lib/db/schema";
import { getClientIp, requireAuth, type SessionUser } from "@/lib/auth/session";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import {
  resolveFileAccess,
  resolveWritableDestination,
  fileDomainOwnerId,
  fileRefusal,
  type FileAccess,
} from "@/lib/auth/permissions";
import { logActivity } from "@/lib/auth/audit";
import { deleteR2Objects } from "@/lib/storage/r2";
import { validateCsrf } from "@/lib/security";
import { cacheDelPattern } from "@/lib/cache/redis";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { recalculateUsedBytes } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";

const patchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["delete", "restore", "favorite", "move"]),
  // Destination folder for action="move" (null/omitted = move to root).
  folderId: z.string().uuid().nullable().optional(),
});

type FileCapability = "canEdit" | "canTrash" | "canPurge" | "canOwnerOnlyFlags";

/**
 * Resolve every id through the capability model, refusing the WHOLE batch on the first file
 * the caller may not touch.
 *
 * All-or-nothing on purpose: a partially applied destructive batch is worse than a rejected
 * one, and silently skipping rows would hide "you only have view access" from the user.
 */
async function resolveBatch(
  sessionUser: SessionUser,
  ids: string[],
  need: FileCapability,
  what: Parameters<typeof fileRefusal>[1]
): Promise<{ rows: File[] } | { refusal: ReturnType<typeof apiError> }> {
  const rows: File[] = [];
  for (const id of ids) {
    const access: FileAccess | null = await resolveFileAccess(sessionUser, id, {
      includeDeleted: true,
      anyStatus: true,
    });
    if (!access) return { refusal: apiError("File not found", 404) };
    if (!access[need]) return { refusal: apiError(fileRefusal(access, what), 403) };
    rows.push(access.file);
  }
  return { rows };
}

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = patchSchema.parse(await request.json());
    const ip = getClientIp(request);

    // Same capability split as the single-file route: trashing is allowed for `edit`
    // members, restoring and the favourite flag stay with the owner.
    const need: FileCapability =
      body.action === "delete"
        ? "canTrash"
        : body.action === "restore"
          ? "canPurge"
          : body.action === "favorite"
            ? "canOwnerOnlyFlags"
            : "canEdit";
    const what: Parameters<typeof fileRefusal>[1] =
      body.action === "delete"
        ? "trash"
        : body.action === "restore"
          ? "restore"
          : body.action === "favorite"
            ? "favorite"
            : "edit";

    const resolved = await resolveBatch(sessionUser, body.ids, need, what);
    if ("refusal" in resolved) return resolved.refusal;
    const rows = resolved.rows;

    const ids = rows.map((r) => r.id);
    const ownerIds = [...new Set(rows.map((r) => r.userId))];

    for (const ownerId of ownerIds) {
      cacheDelPattern(`search:${ownerId}:*`).catch(() => {});
      cacheDelPattern(`files:${ownerId}:*`).catch(() => {});
    }

    const now = new Date();

    switch (body.action) {
      case "delete": {
        await db
          .update(files)
          .set({ deletedAt: now, updatedAt: now })
          .where(inArray(files.id, ids));
        for (const ownerId of ownerIds) {
          await recalculateUsedBytes(ownerId);
        }
        break;
      }
      case "restore": {
        await db
          .update(files)
          .set({ deletedAt: null, updatedAt: now })
          .where(inArray(files.id, ids));
        for (const ownerId of ownerIds) {
          await recalculateUsedBytes(ownerId);
        }
        break;
      }
      case "favorite": {
        // Toggle individually would be N queries; set all to favorite=true when any false, else unfavorite all
        const allFavorite = rows.every((r) => r.isFavorite);
        await db
          .update(files)
          .set({ isFavorite: !allFavorite, updatedAt: now })
          .where(inArray(files.id, ids));
        break;
      }
      case "move": {
        // Every file must be allowed to land there on its own terms: same owner, same
        // sharing domain. A mixed batch can only move somewhere that holds for ALL of them,
        // so one refusal rejects the batch (checked per distinct owner/domain pair, not per
        // file, to keep the query count down on a 500-file selection).
        const checked = new Set<string>();
        for (const row of rows) {
          const domainOwnerId = await fileDomainOwnerId(row);
          const pair = `${row.userId}:${domainOwnerId}`;
          if (checked.has(pair)) continue;
          checked.add(pair);
          const dest = await resolveWritableDestination(sessionUser, body.folderId ?? null, {
            fileOwnerId: row.userId,
            domainOwnerId,
          });
          if (!dest.ok) return apiError(dest.message, dest.status);
        }
        await db
          .update(files)
          .set({ folderId: body.folderId ?? null, updatedAt: now })
          .where(inArray(files.id, ids));
        break;
      }
    }

    await logActivity(sessionUser, body.action === "favorite" ? "favorite" : body.action, {
      resourceType: "file",
      resourceId: ids[0],
      metadata: { batch: true, count: ids.length, action: body.action },
      ip,
    });

    return apiSuccess({ ids, count: ids.length, action: body.action });
  } catch (error) {
    return handleApiError(error);
  }
}

const deleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  permanent: z.literal(true),
});

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuthOrApiKey(request, ["delete"]);
    const body = deleteSchema.parse(await request.json());
    const ip = getClientIp(request);

    // Purging is owner-only, whatever the member's role.
    const resolved = await resolveBatch(sessionUser, body.ids, "canPurge", "purge");
    if ("refusal" in resolved) return resolved.refusal;
    // Only what is already in the bin can be purged — the same guard the single-file route
    // applies, kept here so a batch cannot skip the recycle bin entirely.
    const rows = resolved.rows.filter((r) => r.deletedAt);
    if (rows.length === 0) return apiError("No trashed files found", 404);

    const ids = rows.map((r) => r.id);
    const ownerIds = [...new Set(rows.map((r) => r.userId))];
    const keys: string[] = [];
    for (const row of rows) {
      keys.push(row.r2Key);
      if (row.thumbnailKey) keys.push(row.thumbnailKey);
    }

    await deleteR2Objects(keys);
    await db.delete(files).where(inArray(files.id, ids));

    for (const ownerId of ownerIds) {
      cacheDelPattern(`search:${ownerId}:*`).catch(() => {});
      cacheDelPattern(`files:${ownerId}:*`).catch(() => {});
      await recalculateUsedBytes(ownerId);
    }

    await logActivity(sessionUser, "delete", {
      resourceType: "file",
      resourceId: ids[0],
      metadata: { batch: true, permanent: true, count: ids.length },
      ip,
    });

    for (const row of rows) {
      void dispatchWebhookEvent(row.userId, "delete", {
        fileId: row.id,
        name: row.name,
        permanent: true,
      });
    }

    return apiSuccess({ deleted: true, count: ids.length });
  } catch (error) {
    return handleApiError(error);
  }
}
