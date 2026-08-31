import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { fileContents, changeHistory } from "@/shared/infrastructure/db/schema";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { tiptapToPlainText } from "@/shared/lib/search/tiptap-text";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuthOrApiKey(_request, ["read"]);
    const { id } = await params;

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canView) {
      return apiError("File not found", 404);
    }

    const [content] = await db
      .select()
      .from(fileContents)
      .where(eq(fileContents.fileId, id))
      .limit(1);

    return apiSuccess({ file: accessible.file, content: content ?? null });
  } catch (error) {
    return handleApiError(error);
  }
}

const updateSchema = z.object({
  content: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuthOrApiKey(request, ["write"]);
    const { id } = await params;
    const body = updateSchema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible?.canEdit) {
      return apiError("File not found", 404);
    }
    const file = accessible.file;

    const [existing] = await db
      .select()
      .from(fileContents)
      .where(eq(fileContents.fileId, id))
      .limit(1);

    if (existing) {
      await db
        .update(fileContents)
        .set({
          contentJson: body.content ?? existing.contentJson,
          annotationsJson: body.annotations ?? existing.annotationsJson,
          updatedAt: new Date(),
        })
        .where(eq(fileContents.fileId, id));
    } else {
      await db.insert(fileContents).values({
        fileId: id,
        contentJson: body.content ?? null,
        annotationsJson: body.annotations ?? null,
      });
    }

    const { files } = await import("@/shared/infrastructure/db/schema");
    await db
      .update(files)
      .set({
        version: file.version + 1,
        updatedAt: new Date(),
        // Refresh searchable text when the note body changed.
        ...(body.content !== undefined
          ? { contentText: tiptapToPlainText(body.content) }
          : {}),
      })
      .where(eq(files.id, id));

    await db.insert(changeHistory).values({
      fileId: id,
      userId: getEffectiveUserId(sessionUser),
      changeType: "edit",
      snapshot: body.content ?? body.annotations ?? {},
    });

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: id,
      ip,
    });

    return apiSuccess({ saved: true });
  } catch (error) {
    return handleApiError(error);
  }
}
