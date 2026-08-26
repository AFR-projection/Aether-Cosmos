import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { folders } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { resolveFolderAccess } from "@/lib/auth/permissions";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";

/**
 * The ancestor chain for a folder, so `/files?folder=<id>` can show where it is.
 *
 * A deep link carries only an id, and the listing endpoints return a folder's
 * CHILDREN — never the folder itself — so the browser had no name to display and
 * headed the page with the literal word "Folder".
 *
 * The walk follows `parent_id`, not `materialized_path`: paths are built from
 * names, so two root folders that share a name share a path, and a prefix match
 * would report both as ancestors of the same child.
 */

/** Trees are a handful of levels deep in practice; the cap only stops a cycle spinning. */
const MAX_DEPTH = 64;

export type FolderCrumb = { id: string; name: string };

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;

    // A malformed id would otherwise reach Postgres as an invalid uuid and raise.
    if (!z.string().uuid().safeParse(id).success) {
      return apiError("Folder not found", 404);
    }

    const access = await resolveFolderAccess(sessionUser, id);
    if (!access?.canView) return apiError("Folder not found", 404);

    const rows = (await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, name, parent_id, 0 AS lvl
          FROM ${folders}
         WHERE id = ${id}
        UNION ALL
        SELECT f.id, f.name, f.parent_id, c.lvl + 1
          FROM ${folders} f
          JOIN chain c ON f.id = c.parent_id
         WHERE f.user_id = ${access.folder.userId}
           AND f.deleted_at IS NULL
           AND c.lvl < ${MAX_DEPTH}
      )
      SELECT id, name FROM chain ORDER BY lvl DESC
    `)) as unknown as Array<{ id: string; name: string }>;

    let crumbs: FolderCrumb[] = rows.map((r) => ({ id: r.id, name: r.name }));

    // A member is shown the share root and below, never the owner's folders above
    // it — the names alone would map out a tree they were not given. `trimmed` is
    // also what tells the client to drop the "My Files" root link, so it is set for
    // every borrowed tree, including when the browsed folder IS the share root and
    // there was nothing above to cut.
    let trimmed = false;
    if (access.shareRootId && !access.isOwner) {
      trimmed = true;
      const start = crumbs.findIndex((c) => c.id === access.shareRootId);
      if (start > 0) crumbs = crumbs.slice(start);
    }

    return apiSuccess(
      { crumbs, trimmed },
      200,
      { "Cache-Control": "private, max-age=10" }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
