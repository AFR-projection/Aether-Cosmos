import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { shares, files, activityLogs, fileContents } from "@/lib/db/schema";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { getClientIpFromRequest, parseUserAgent, getIpLocation } from "@/lib/access-tracking";
import { publishToUser } from "@/lib/realtime/events";
import { tiptapToPlainText } from "@/lib/search/tiptap-text";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
    if (!share) return apiError("Share not found", 404);

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, share.fileId), isNull(files.deletedAt), eq(files.status, "ready")))
      .limit(1);

    if (!file) return apiError("File not found", 404);

    // Duration Check
    if (share.expiresAt && share.expiresAt < new Date()) {
      return apiError("Share link expired", 410);
    }

    // Access Count Check
    if (share.maxAccessCount && share.accessCount >= share.maxAccessCount) {
      return apiError("Share link has reached maximum access limit", 403);
    }

    // Notes have no R2 object — their body is Tiptap JSON in file_contents.
    // Include it so the public page can render (and, if permitted, edit) it
    // instead of trying to stream a file that doesn't exist.
    let noteContent: unknown = null;
    if (file.isNote) {
      const [content] = await db
        .select({ contentJson: fileContents.contentJson })
        .from(fileContents)
        .where(eq(fileContents.fileId, file.id))
        .limit(1);
      noteContent = content?.contentJson ?? null;
    }

    // Increment access count (track page view)
    const [updatedShare] = await db
      .update(shares)
      .set({
        accessCount: share.accessCount + 1,
        lastAccessedAt: new Date(),
      })
      .where(eq(shares.id, share.id))
      .returning();

    // Log detailed access info
    const ip = getClientIpFromRequest(request);
    const userAgent = request.headers.get("user-agent") ?? "unknown";
    const deviceInfo = parseUserAgent(userAgent);

    // Fire-and-forget geolocation (non-blocking)
    getIpLocation(ip).then((location) => {
      db.insert(activityLogs).values({
        userId: share.sharedBy,
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
      }).catch(() => {});
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

    const body = (await request.json()) as { content?: unknown };
    if (body.content == null || typeof body.content !== "object") {
      return apiError("Missing note content", 400);
    }

    const [share] = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
    if (!share) return apiError("Share not found", 404);

    if (share.permission !== "edit") {
      return apiError("This share is view-only", 403);
    }

    if (share.expiresAt && share.expiresAt < new Date()) {
      return apiError("Share link expired", 410);
    }
    if (share.maxAccessCount && share.accessCount >= share.maxAccessCount) {
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
