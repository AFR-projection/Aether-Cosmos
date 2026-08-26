import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, desc, count, sum, and, isNull, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, files, folders, activityLogs, sessions } from "@/lib/db/schema";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import {
  getClientIp,
  deviceLabelFromUa,
  deviceKindFromUa,
  destroyAllUserSessions,
} from "@/lib/auth/session";
import {
  adminUserUpdateSchema,
  normalizeAdminEmail,
  sessionRevocationReason,
} from "@/lib/admin/user-update";
import { logActivity } from "@/lib/auth/audit";
import { validateCsrf } from "@/lib/security";
import { validatePasswordStrength } from "@/lib/security/password-policy";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { cacheDelPattern } from "@/lib/cache/redis";
import { deleteR2Object } from "@/lib/storage/r2";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireMasterOrApiKey(request, "users");
    const { id } = await params;

    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return apiError("User not found", 404);

    // User's files
    const userFiles = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, id), isNull(files.deletedAt)))
      .orderBy(desc(files.createdAt));

    // User's folders
    const userFolders = await db
      .select()
      .from(folders)
      .where(and(eq(folders.userId, id), isNull(folders.deletedAt)))
      .orderBy(desc(folders.createdAt));

    // User's activity
    const userActivity = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.userId, id))
      .orderBy(desc(activityLogs.createdAt))
      .limit(50);

    // User's active sessions
    const userSessions = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, id), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastActiveAt))
      .limit(20);

    // Storage by file type
    const storageByType = await db
      .select({
        mimeType: files.mimeType,
        count: count(),
        totalSize: sum(files.sizeBytes),
      })
      .from(files)
      .where(and(eq(files.userId, id), isNull(files.deletedAt)))
      .groupBy(files.mimeType)
      .orderBy(desc(sum(files.sizeBytes)));

    return apiSuccess({
      user: { ...user, passwordHash: undefined },
      files: userFiles,
      folders: userFolders,
      activity: userActivity,
      sessions: userSessions.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        deviceLabel: s.deviceLabel || deviceLabelFromUa(s.userAgent),
        deviceKind: deviceKindFromUa(s.userAgent),
        locationLabel: s.locationLabel,
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
      storageByType,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMasterOrApiKey(request, "users");
    const { id } = await params;
    // Every field is bounded and enum-checked here. Copying `await request.json()`
    // straight onto the update let `role: "root"` reach a pgEnum column and a
    // negative or 1e30 quota reach a bigint one.
    const body = adminUserUpdateSchema.parse(await request.json());
    const ip = getClientIp(request);

    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) return apiError("User not found", 404);

    // Prevent suspending a master account
    if (body.status && body.status === "suspended" && existing.role === "master") {
      return apiError("Cannot suspend a master account", 403);
    }

    // Prevent demoting the last master
    if (body.role && body.role !== existing.role && existing.role === "master") {
      const [masterCount] = await db
        .select({ count: count() })
        .from(users)
        .where(eq(users.role, "master"));
      if (masterCount.count <= 1) {
        return apiError("Cannot demote the last master account", 400);
      }
    }

    const updates: Partial<typeof existing> = { updatedAt: new Date() };
    if (body.username) updates.username = body.username;
    if (body.email !== undefined) {
      const normalized = normalizeAdminEmail(body.email);
      if (!normalized.ok) {
        return apiError("Please enter a valid email address.", 400);
      }
      updates.email = normalized.email;
    }
    if (body.status) {
      updates.status = body.status;
      if (body.status === "active") {
        updates.suspendReason = null;
      } else if (body.status === "suspended") {
        // Always record a non-null reason for an admin suspension. A null reason is
        // reserved for pending-email-verification accounts, so an admin-suspended
        // user cannot self-reactivate via the email OTP flow.
        updates.suspendReason =
          body.suspendReason ?? existing.suspendReason ?? "Suspended by administrator";
      }
    }
    if (body.suspendReason !== undefined && !body.status) {
      updates.suspendReason = body.suspendReason;
    }
    if (body.mustChangePassword !== undefined) {
      updates.mustChangePassword = body.mustChangePassword;
    }
    if (body.bandwidthQuotaBytes !== undefined) {
      updates.bandwidthQuotaBytes = body.bandwidthQuotaBytes;
    }
    if (body.quotaBytes !== undefined) updates.quotaBytes = body.quotaBytes;
    if (body.role) updates.role = body.role;
    if (body.password) {
      const passwordCheck = validatePasswordStrength(body.password);
      if (!passwordCheck.valid) {
        return apiError(`Password too weak: ${passwordCheck.errors.join(", ")}`, 400);
      }
      const { hashPassword } = await import("@/lib/auth/password");
      updates.passwordHash = await hashPassword(body.password);
    }

    await db.update(users).set(updates).where(eq(users.id, id));
    await cacheDelPattern("user:*");

    // A reset password the attacker's session survives is not a reset. Sessions are
    // opaque rows with no link to the credential, so they have to be deleted here.
    const revocation = sessionRevocationReason(body);
    if (revocation) await destroyAllUserSessions(id);

    const action =
      body.status === "suspended" && existing.status !== "suspended"
        ? ("suspend_user" as const)
        : ("update_user" as const);

    await logActivity(master, action, {
      resourceType: "user",
      resourceId: id,
      metadata: {
        username: existing.username,
        status: body.status,
        suspendReason: body.suspendReason,
        ...(revocation ? { sessionsRevoked: revocation } : {}),
      },
      ip,
    });

    return apiSuccess({ updated: true, sessionsRevoked: revocation !== null });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMasterOrApiKey(request, "users");
    const { id } = await params;
    // The flag is optional: a DELETE with no body at all is a delete without data
    // removal, not a 500 from destructuring `undefined`.
    const { deleteData } = z
      .object({ deleteData: z.boolean().default(false) })
      .parse(await request.json().catch(() => ({})));
    const ip = getClientIp(request);

    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) return apiError("User not found", 404);
    if (existing.role === "master") return apiError("Cannot delete master account", 403);

    if (deleteData) {
      const userFiles = await db.select().from(files).where(eq(files.userId, id));
      for (const file of userFiles) {
        try {
          await deleteR2Object(file.r2Key);
          if (file.thumbnailKey) await deleteR2Object(file.thumbnailKey);
        } catch {
          // continue cleanup
        }
      }
    }

    await db.delete(users).where(eq(users.id, id));
    await cacheDelPattern("user:*");

    await logActivity(master, "delete_user", {
      resourceType: "user",
      resourceId: id,
      metadata: { deleteData },
      ip,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}