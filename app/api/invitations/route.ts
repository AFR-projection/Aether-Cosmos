import { NextRequest } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { folderInvitations, folderMembers, folders, users } from "@/shared/infrastructure/db/schema";
import { requireAuth } from "@/shared/lib/auth/session";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";

// GET: List all pending invitations for current user
export async function GET(_request: NextRequest) {
  try {
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);

    const invitations = await db
      .select({
        id: folderInvitations.id,
        folderId: folderInvitations.folderId,
        folderName: folders.name,
        role: folderInvitations.role,
        invitedByUsername: users.username,
        createdAt: folderInvitations.createdAt,
      })
      .from(folderInvitations)
      .innerJoin(folders, eq(folderInvitations.folderId, folders.id))
      .innerJoin(users, eq(folderInvitations.invitedBy, users.id))
      .where(
        and(
          eq(folderInvitations.invitedUserId, userId),
          eq(folderInvitations.status, "pending"),
          // An invitation to a folder the owner has since trashed is dead weight; accepting
          // it would put an unreachable row in the member's list.
          isNull(folders.deletedAt)
        )
      )
      .orderBy(folderInvitations.createdAt);

    return apiSuccess({ invitations });
  } catch (error) {
    return handleApiError(error);
  }
}

const respondSchema = z.object({
  invitationId: z.string().uuid(),
  action: z.enum(["accept", "reject"]),
});

// POST: Accept or reject an invitation
export async function POST(request: NextRequest) {
  try {
    // This state-changing endpoint was the one share route with no CSRF check, so a
    // cross-site POST could accept an invitation on the victim's behalf.
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const body = respondSchema.parse(await request.json());

    // Get invitation
    const [invitation] = await db
      .select()
      .from(folderInvitations)
      .where(
        and(
          eq(folderInvitations.id, body.invitationId),
          eq(folderInvitations.invitedUserId, userId),
          eq(folderInvitations.status, "pending")
        )
      )
      .limit(1);

    if (!invitation) {
      return apiError("Invitation not found or already responded", 404);
    }

    if (body.action === "accept") {
      const [folder] = await db
        .select({ id: folders.id, userId: folders.userId, deletedAt: folders.deletedAt })
        .from(folders)
        .where(eq(folders.id, invitation.folderId))
        .limit(1);

      if (!folder || folder.deletedAt) {
        await db
          .update(folderInvitations)
          .set({ status: "rejected", respondedAt: new Date() })
          .where(eq(folderInvitations.id, invitation.id));
        return apiError("The owner deleted this folder, so the invitation is no longer valid.", 410);
      }

      if (folder.userId === userId) {
        return apiError("You own this folder — you don't need an invitation.", 400);
      }

      // A membership row may already exist (double-click, or a stale invitation after a
      // manual re-add) and `folder_members_unique` would turn that into a 500 — so the
      // accept is idempotent and just re-asserts the invited role.
      await db
        .insert(folderMembers)
        .values({
          folderId: invitation.folderId,
          userId,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
        })
        .onConflictDoUpdate({
          target: [folderMembers.folderId, folderMembers.userId],
          set: { role: invitation.role, invitedBy: invitation.invitedBy },
        });

      // Update invitation status
      await db
        .update(folderInvitations)
        .set({ status: "accepted", respondedAt: new Date() })
        .where(eq(folderInvitations.id, invitation.id));

      return apiSuccess({ message: "Invitation accepted", folderId: invitation.folderId });
    } else {
      // Update invitation status to rejected
      await db
        .update(folderInvitations)
        .set({ status: "rejected", respondedAt: new Date() })
        .where(eq(folderInvitations.id, invitation.id));

      return apiSuccess({ message: "Invitation rejected" });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
