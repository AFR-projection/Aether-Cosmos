import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { folderMembers, folderInvitations, users } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getEffectiveUserId, resolveFolderAccess } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";

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

    // Pending invitations are part of the sharing state the owner manages; a plain member
    // has no business seeing who else was asked.
    const invitations = access.canManageMembers
      ? await db
          .select({
            id: folderInvitations.id,
            invitedUserId: folderInvitations.invitedUserId,
            role: folderInvitations.role,
            status: folderInvitations.status,
            createdAt: folderInvitations.createdAt,
            username: users.username,
          })
          .from(folderInvitations)
          .innerJoin(users, eq(folderInvitations.invitedUserId, users.id))
          .where(
            and(eq(folderInvitations.folderId, id), eq(folderInvitations.status, "pending"))
          )
      : [];

    return apiSuccess({
      members,
      invitations,
      ownerId: access.folder.userId,
      canManage: access.canManageMembers,
      // The client needs the caller's own standing to hide actions it must not offer.
      viewer: {
        userId: getEffectiveUserId(sessionUser),
        role: access.role,
        isOwner: access.isOwner,
        isShareRoot: access.isShareRoot,
        shareRootId: access.shareRootId,
        canEdit: access.canEdit,
        canManageMembers: access.canManageMembers,
        canTrashFolder: access.canTrashFolder,
        canPurge: access.canPurge,
        canOwnerOnlyFlags: access.canOwnerOnlyFlags,
        canLeave: access.viaMembership,
      },
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
      // Re-inviting someone who is already in is how the UI used to try to change a role,
      // and it dead-ended in a 400. Point at the action that actually does it.
      return apiError(
        "This user is already a member. Change their role from the member list (PATCH) instead of inviting them again.",
        400
      );
    }

    // One invitation row per (folder, user) — the unique index says so. A `rejected` or
    // `accepted` leftover used to make the INSERT below explode with a 500 and permanently
    // block re-inviting that person, so any existing row is reset to a fresh pending invite.
    const [existingInvitation] = await db
      .select()
      .from(folderInvitations)
      .where(
        and(
          eq(folderInvitations.folderId, id),
          eq(folderInvitations.invitedUserId, invitee.id)
        )
      )
      .limit(1);

    if (existingInvitation) {
      const [updated] = await db
        .update(folderInvitations)
        .set({
          role: body.role,
          status: "pending",
          invitedBy: getEffectiveUserId(sessionUser),
          respondedAt: null,
          createdAt: new Date(),
        })
        .where(eq(folderInvitations.id, existingInvitation.id))
        .returning();
      return apiSuccess({
        invitation: { ...updated, username: invitee.username },
        // `updated` is the machine-readable half of the same fact: the dialog
        // picks its own sentence from it, in the viewer's language, while
        // `message` stays for API clients that only read prose.
        updated: existingInvitation.status === "pending",
        message: existingInvitation.status === "pending" ? "Invitation updated" : "Invitation sent",
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
      updated: false,
      message: "Invitation sent"
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const roleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["view", "edit"]),
});

/**
 * Change an existing member's role. There was no way to do this before: the only path was
 * "invite again", which answered 400 "already a member" — so a mistaken `edit` grant could
 * only be fixed by removing the person and re-inviting them.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const body = roleSchema.parse(await request.json());

    const access = await resolveFolderAccess(sessionUser, id);
    if (!access) return apiError("Folder not found", 404);
    if (!access.canManageMembers) return apiError("Only the owner can manage members", 403);
    if (body.userId === access.folder.userId) {
      return apiError("The owner's role can't be changed", 400);
    }

    const [updated] = await db
      .update(folderMembers)
      .set({ role: body.role })
      .where(and(eq(folderMembers.folderId, id), eq(folderMembers.userId, body.userId)))
      .returning({ id: folderMembers.id, userId: folderMembers.userId, role: folderMembers.role });

    if (!updated) return apiError("Member not found", 404);

    // Keep the invitation row in step, so the members list and the invite history do not
    // disagree about what this person was granted.
    await db
      .update(folderInvitations)
      .set({ role: body.role })
      .where(
        and(eq(folderInvitations.folderId, id), eq(folderInvitations.invitedUserId, body.userId))
      );

    return apiSuccess({ member: updated });
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

    // Leaving a share is the member's own equivalent of "delete this folder": it removes it
    // from THEIR list without touching the owner's data. Managing other people still needs
    // canManageMembers.
    const isSelf = body.userId === getEffectiveUserId(sessionUser);
    if (!isSelf && !access.canManageMembers) {
      return apiError("Only the owner can manage members", 403);
    }

    if (body.userId === access.folder.userId) {
      return apiError("Cannot remove the owner", 400);
    }

    const deleted = await db
      .delete(folderMembers)
      .where(and(eq(folderMembers.folderId, id), eq(folderMembers.userId, body.userId)))
      .returning({ id: folderMembers.id });

    if (deleted.length === 0) return apiError("Member not found", 404);

    // Drop the invitation too: an `accepted` leftover would otherwise sit on the unique
    // index and make a later re-invite fail.
    await db
      .delete(folderInvitations)
      .where(
        and(eq(folderInvitations.folderId, id), eq(folderInvitations.invitedUserId, body.userId))
      );

    return apiSuccess({ deleted: true, left: isSelf });
  } catch (error) {
    return handleApiError(error);
  }
}
