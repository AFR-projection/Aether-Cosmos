import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { folderMembers, folderInvitations, users } from "@/lib/db/schema";
import { requireAuth, getClientIp } from "@/lib/auth/session";
import { getEffectiveUserId, resolveFolderAccess } from "@/lib/auth/permissions";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuth();
    const { id } = await params;

    const access = await resolveFolderAccess(sessionUser, id);
    if (!access?.canView) return apiError("Folder not found", 404);

    const members = await db
      .select({
        id: folderMembers.id,
        userId: folderMembers.userId,
        role: folderMembers.role,
        createdAt: folderMembers.createdAt,
        username: users.username,
        invitedBy: folderMembers.invitedBy,
      })
      .from(folderMembers)
      .innerJoin(users, eq(folderMembers.userId, users.id))
      .where(eq(folderMembers.folderId, id));

    return apiSuccess({
      members,
      ownerId: access.folder.userId,
      canManage: access.canManageMembers,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const inviteSchema = z.object({
  username: z.string().min(1).max(100),
  role: z.enum(["view", "edit"]).default("view"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const body = inviteSchema.parse(await request.json());
    void getClientIp(request);

    const access = await resolveFolderAccess(sessionUser, id);
    if (!access) return apiError("Folder not found", 404);
    if (!access.canManageMembers) return apiError("Only the owner can manage members", 403);

    const [invitee] = await db
      .select()
      .from(users)
      .where(eq(users.username, body.username.trim()))
      .limit(1);

    if (!invitee) return apiError("User not found", 404);
    if (invitee.id === access.folder.userId) {
      return apiError("Owner is already a member", 400);
    }
    if (invitee.id === getEffectiveUserId(sessionUser)) {
      return apiError("Cannot invite yourself", 400);
    }

    // Check if already a member
    const [existingMember] = await db
      .select()
      .from(folderMembers)
      .where(and(eq(folderMembers.folderId, id), eq(folderMembers.userId, invitee.id)))
      .limit(1);

    if (existingMember) {
      return apiError("User is already a member of this folder", 400);
    }

    // Check if invitation already exists
    const [existingInvitation] = await db
      .select()
      .from(folderInvitations)
      .where(
        and(
          eq(folderInvitations.folderId, id),
          eq(folderInvitations.invitedUserId, invitee.id),
          eq(folderInvitations.status, "pending")
        )
      )
      .limit(1);

    if (existingInvitation) {
      // Update existing pending invitation with new role
      const [updated] = await db
        .update(folderInvitations)
        .set({ role: body.role })
        .where(eq(folderInvitations.id, existingInvitation.id))
        .returning();
      return apiSuccess({
        invitation: { ...updated, username: invitee.username },
        message: "Invitation updated"
      });
    }

    // Create new invitation
    const [invitation] = await db
      .insert(folderInvitations)
      .values({
        folderId: id,
        invitedUserId: invitee.id,
        role: body.role,
        invitedBy: getEffectiveUserId(sessionUser),
      })
      .returning();

    return apiSuccess({
      invitation: { ...invitation, username: invitee.username },
      message: "Invitation sent"
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const removeSchema = z.object({
  userId: z.string().uuid(),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const body = removeSchema.parse(await request.json());

    const access = await resolveFolderAccess(sessionUser, id);
    if (!access) return apiError("Folder not found", 404);
    if (!access.canManageMembers) return apiError("Only the owner can manage members", 403);

    if (body.userId === access.folder.userId) {
      return apiError("Cannot remove the owner", 400);
    }

    const deleted = await db
      .delete(folderMembers)
      .where(and(eq(folderMembers.folderId, id), eq(folderMembers.userId, body.userId)))
      .returning({ id: folderMembers.id });

    if (deleted.length === 0) return apiError("Member not found", 404);
    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
