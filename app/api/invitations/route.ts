import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { folderInvitations, folderMembers, folders, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";

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
          eq(folderInvitations.status, "pending")
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
      // Add to folder members
      await db.insert(folderMembers).values({
        folderId: invitation.folderId,
        userId,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
      });

      // Update invitation status
      await db
        .update(folderInvitations)
        .set({ status: "accepted", respondedAt: new Date() })
        .where(eq(folderInvitations.id, invitation.id));

      return apiSuccess({ message: "Invitation accepted" });
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
