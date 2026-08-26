import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { shares, files, activityLogs, fileContents } from "@/lib/db/schema";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { getClientIpFromRequest, parseUserAgent, getIpLocation } from "@/lib/access-tracking";
import { publishToUser } from "@/lib/realtime/events";
import { tiptapToPlainText } from "@/lib/search/tiptap-text";
import { getOrCreateActivityScope } from "@/lib/activity/activity-scope-server";
import { checkRateLimit } from "@/lib/security";
import { claimShareAccess, shareBudgetExhausted, shareExpired } from "@/lib/shares/access";
import { isPossibleShareToken } from "@/lib/shares/token";
import { readBoundedJson, bodyErrorResponse } from "@/lib/api/body";

/** A Tiptap document is prose, not a payload. */
const MAX_NOTE_BODY_BYTES = 2 * 1024 * 1024;

/** Anonymous callers, so these are the only ceilings on either handler. */
const VIEW_MAX_PER_MINUTE = 120;
const EDIT_MAX_PER_MINUTE = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    // Same answer as a token that does not exist, so this is not an oracle — it
    // just keeps an unbounded path segment out of the query and the cache key.
    if (!isPossibleShareToken(token)) return apiError("Share not found", 404);

    const ip = getClientIpFromRequest(request);
    const viewLimit = await checkRateLimit(`share_view:${ip}`, VIEW_MAX_PER_MINUTE, 60_000);
    if (!viewLimit.allowed) return apiError("Too many requests. Slow down.", 429);

    const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
    if (!share) return apiError("Share not found", 404);

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, share.fileId), isNull(files.deletedAt), eq(files.status, "ready")))
      .limit(1);

    if (!file) return apiError("File not found", 404);

    // Duration Check
    if (shareExpired(share)) {
      return apiError("Share link expired", 410);
    }

    /**
     * Notes have no R2 object — their body is Tiptap JSON in file_contents, so for
     * a note THIS endpoint is the content path and spends a unit of the budget.
     * For everything else the bytes leave via /preview, which spends it there;
     * counting in both places would charge two units for one visit.
     */
    let noteContent: unknown = null;
    let updatedShare = share;

    if (file.isNote) {
      const claimed = await claimShareAccess(share.id);
      if (!claimed) {
        return apiError("Share link has reached maximum access limit", 403);
      }
      updatedShare = claimed;

      const [content] = await db
        .select({ contentJson: fileContents.contentJson })
        .from(fileContents)
        .where(eq(fileContents.fileId, file.id))
        .limit(1);
      noteContent = content?.contentJson ?? null;
    } else if (shareBudgetExhausted(share)) {
      return apiError("Share link has reached maximum access limit", 403);
    }


    // Record the visit. For a note the claim above already moved the counter and
    // the timestamp; for a file only the timestamp belongs here.
    if (!file.isNote) {
      await db
        .update(shares)
        .set({ lastAccessedAt: new Date() })
        .where(eq(shares.id, share.id));
    }

    // Log detailed access info
    const userAgent = request.headers.get("user-agent") ?? "unknown";
    const deviceInfo = parseUserAgent(userAgent);

    // Fire-and-forget geolocation (non-blocking)
    getIpLocation(ip).then((location) => {
      getOrCreateActivityScope(share.sharedBy).then((scope) => db.insert(activityLogs).values({
        userId: share.sharedBy,
        activityScopeId: scope.id,
        action: "download",
        resourceType: "share",
        resourceId: share.id,
        metadata: {
          token,
          fileName: file.name,
          accessCount: updatedShare.accessCount,
          maxAccessCount: updatedShare.maxAccessCount,
          userAgent,
          device: deviceInfo.device,
          browser: deviceInfo.browser,
          os: deviceInfo.os,
          location,
        },
        ip,
      })).catch(() => {});
    });

    void publishToUser(share.sharedBy, {
      type: "share_access",
      shareId: share.id,
      fileName: file.name,
      accessCount: updatedShare.accessCount,
      token,
    });

    return apiSuccess({
      file: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        isNote: file.isNote,
      },
      note: file.isNote ? { content: noteContent } : null,
      permission: share.permission,
      accessCount: updatedShare.accessCount,
      maxAccessCount: updatedShare.maxAccessCount,
      lastAccessedAt: updatedShare.lastAccessedAt,
      expiresAt: updatedShare.expiresAt,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Save edits to a shared note. Only allowed when the share grants "edit"
 * permission and the target is a note (notes live in file_contents as Tiptap
 * JSON — regular files have no editable body here). No auth: the share token
 * itself is the capability. We deliberately do NOT touch accessCount here so
 * autosaves don't burn through a view-limited link.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    if (!isPossibleShareToken(token)) return apiError("Share not found", 404);

    // Rate limit: per share token, and per caller — the token limit alone let one
    // client spread writes across guessed tokens, and built the Redis key out of
    // whatever path segment arrived.
    const editorIp = getClientIpFromRequest(request);
    const ipLimit = await checkRateLimit(`share_edit_ip:${editorIp}`, EDIT_MAX_PER_MINUTE, 60_000);
    if (!ipLimit.allowed) {
      return apiError("Too many edit requests. Slow down.", 429);
    }
    const rateLimitCheck = await checkRateLimit(`share_edit:${token}`, EDIT_MAX_PER_MINUTE, 60_000);
    if (!rateLimitCheck.allowed) {
      return apiError("Too many edit requests. Slow down.", 429);
    }

    let body: { content?: unknown };
    try {
      body = await readBoundedJson<{ content?: unknown }>(request, MAX_NOTE_BODY_BYTES);
    } catch (error) {
      const response = bodyErrorResponse(error);
      if (response) return response;
      throw error;
    }
    if (body.content == null || typeof body.content !== "object") {
      return apiError("Missing note content", 400);
    }

    const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
    if (!share) return apiError("Share not found", 404);

    if (share.permission !== "edit") {
      return apiError("This share is view-only", 403);
    }

    if (shareExpired(share)) {
      return apiError("Share link expired", 410);
    }
    if (shareBudgetExhausted(share)) {
      return apiError("Share link has reached maximum access limit", 403);
    }

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, share.fileId), isNull(files.deletedAt), eq(files.status, "ready")))
      .limit(1);

    if (!file) return apiError("File not found", 404);
    if (!file.isNote) return apiError("Only notes can be edited via share", 400);

    // Keep the searchable plaintext in sync with the note body.
    await db
      .update(files)
      .set({ contentText: tiptapToPlainText(body.content), updatedAt: new Date() })
      .where(eq(files.id, file.id));

    const [existing] = await db
      .select({ id: fileContents.id })
      .from(fileContents)
      .where(eq(fileContents.fileId, file.id))
      .limit(1);

    if (existing) {
      await db
        .update(fileContents)
        .set({ contentJson: body.content, updatedAt: new Date() })
        .where(eq(fileContents.fileId, file.id));
    } else {
      await db.insert(fileContents).values({
        fileId: file.id,
        contentJson: body.content,
      });
    }

    // Let the owner's live session know their note changed under them.
    void publishToUser(share.sharedBy, {
      type: "share_access",
      shareId: share.id,
      fileName: file.name,
      accessCount: share.accessCount,
      token,
    });

    return apiSuccess({ saved: true });
  } catch (error) {
    return handleApiError(error);
  }
}
