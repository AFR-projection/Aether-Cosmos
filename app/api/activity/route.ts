import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { activityLogs, activityActionEnum, files, folders } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { validateCsrf } from "@/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/lib/api/response";

const querySchema = z.object({
  action: z.string().optional(),
  status: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const TYPE_MAP: Record<string, string> = {
  delete_folder: "delete",
};

const FILE_ACTIONS = ["upload", "download", "delete", "delete_folder", "restore", "rename", "move", "copy", "create_folder"] as const;

function metadataValue(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const conditions = [eq(activityLogs.userId, userId)];

    if (query.action && query.action !== "all" && query.action !== "processing" && query.action !== "success" && query.action !== "failed" && query.action !== "cancelled") {
      const action = query.action === "delete" ? ["delete", "delete_folder"] : [query.action];
      if (action.every((value) => !FILE_ACTIONS.includes(value as (typeof FILE_ACTIONS)[number]))) {
        return apiError("Invalid activity type", 400);
      }
      conditions.push(inArray(activityLogs.action, action as (typeof activityActionEnum.enumValues)[number][]));
    } else if (!query.action || query.action === "all" || ["processing", "success", "failed", "cancelled"].includes(query.action)) {
      conditions.push(inArray(activityLogs.action, [...FILE_ACTIONS] as (typeof activityActionEnum.enumValues)[number][]));
    }
    if (query.from) conditions.push(gte(activityLogs.createdAt, query.from));
    if (query.to) conditions.push(lte(activityLogs.createdAt, query.to));

    const rows = await db
      .select()
      .from(activityLogs)
      .where(and(...conditions))
      .orderBy(query.sort === "oldest" ? activityLogs.createdAt : desc(activityLogs.createdAt))
      .limit(query.limit);

    const fileIds = rows.filter((row) => row.resourceType === "file" && row.resourceId && z.string().uuid().safeParse(row.resourceId).success).map((row) => row.resourceId as string);
    const folderIds = rows.filter((row) => row.resourceType === "folder" && row.resourceId && z.string().uuid().safeParse(row.resourceId).success).map((row) => row.resourceId as string);
    const [fileRows, folderRows] = await Promise.all([
      fileIds.length > 0 ? db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileIds)) : Promise.resolve([]),
      folderIds.length > 0 ? db.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, folderIds)) : Promise.resolve([]),
    ]);
    const names = new Map([...fileRows, ...folderRows].map((row) => [row.id, row.name]));

    const items = rows
      .map((row) => {
        const metadata = row.metadata;
        const status = metadataValue(metadata, "status") ?? "completed";
        const type = TYPE_MAP[row.action] ?? row.action;
        return {
          id: `server-${row.id}`,
          activityId: row.id,
          type,
          status: status === "done" ? "done" : status,
          phase: status === "done" ? "completed" : status,
          name: metadataValue(metadata, "name") ?? metadataValue(metadata, "filename") ?? (row.resourceId ? names.get(row.resourceId) : undefined) ?? row.resourceId ?? row.action,
          detail: metadataValue(metadata, "detail") ?? metadataValue(metadata, "action"),
          fileId: row.resourceType === "file" ? row.resourceId ?? undefined : undefined,
          source: metadataValue(metadata, "source"),
          destination: metadataValue(metadata, "destination"),
          error: metadataValue(metadata, "error") ?? metadataValue(metadata, "errorMessage"),
          startedAt: row.createdAt.getTime(),
          endedAt: row.createdAt.getTime(),
          total: Number(metadataValue(metadata, "sizeBytes") ?? 0),
          loaded: Number(metadataValue(metadata, "sizeBytes") ?? 0),
          progress: status === "failed" || status === "cancelled" ? 0 : 100,
        };
      })
      .filter((item) => {
        if (query.search) {
          const needle = query.search.toLowerCase();
          if (!`${item.name} ${item.detail ?? ""} ${item.source ?? ""} ${item.destination ?? ""}`.toLowerCase().includes(needle)) return false;
        }
        if (query.status === "success" && !["done", "completed"].includes(item.status)) return false;
        if (query.status === "failed" && item.status !== "failed") return false;
        if (query.status === "cancelled" && item.status !== "cancelled") return false;
        if (query.status === "processing" && ["done", "completed", "failed", "cancelled"].includes(item.status)) return false;
        return true;
      });

    return apiSuccess({ items });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    await db.delete(activityLogs).where(eq(activityLogs.userId, userId));
    return apiSuccess({ cleared: true });
  } catch (error) {
    return handleApiError(error);
  }
}
