import { NextRequest } from "next/server";
import { eq, desc, count, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users, files, sessions } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { getClientIp, destroyAllUserSessions } from "@/shared/lib/auth/session";
import { hashPassword } from "@/shared/lib/auth/password";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { validatePasswordStrength } from "@/shared/lib/security/password-policy";
import { deleteR2Object } from "@files/infrastructure/storage/r2";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { defaultQuotaBytes, defaultBandwidthQuotaBytes, getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { publishToAdmins } from "@/shared/infrastructure/realtime/events";
import {
  MAX_QUOTA_BYTES,
  USERNAME_MAX,
  USERNAME_MIN,
  adminUserUpdateByIdSchema,
  normalizeAdminEmail,
  sessionRevocationReason,
} from "@admin/domain/services/user-update";

/** A user counts as "online" if a live session was active within this window. */
const ONLINE_WINDOW_MS = 3 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "users");
    const now = Date.now();

    // Explicit safe columns — never ship passwordHash / totpSecret / recovery codes.
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        phone: users.phone,
        role: users.role,
        status: users.status,
        suspendReason: users.suspendReason,
        mustChangePassword: users.mustChangePassword,
        totpEnabled: users.totpEnabled,
        quotaBytes: users.quotaBytes,
        usedBytes: users.usedBytes,
        bandwidthQuotaBytes: users.bandwidthQuotaBytes,
        bandwidthUsedBytes: users.bandwidthUsedBytes,
        lockedUntil: users.lockedUntil,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    // Presence in one grouped pass over non-expired sessions (no N+1).
    const presenceRows = await db
      .select({
        userId: sessions.userId,
        activeSessions: count(),
        lastActiveAt: sql<Date | null>`max(${sessions.lastActiveAt})`,
      })
      .from(sessions)
      .where(gt(sessions.expiresAt, new Date()))
      .groupBy(sessions.userId);

    const presenceByUser = new Map(presenceRows.map((p) => [p.userId, p]));

    const enriched = rows.map((u) => {
      const p = presenceByUser.get(u.id);
      const lastActiveMs = p?.lastActiveAt ? new Date(p.lastActiveAt).getTime() : null;
      const online = lastActiveMs !== null && now - lastActiveMs < ONLINE_WINDOW_MS;
      // Pending email verification = suspended with NO admin reason (that's how
      // register-email parks accounts); an admin suspend always carries a reason.
      const verification: "active" | "unverified" | "suspended" =
        u.status === "active" ? "active" : u.suspendReason ? "suspended" : "unverified";
      return {
        ...u,
        activeSessions: p?.activeSessions ?? 0,
        lastActiveAt: lastActiveMs !== null ? new Date(lastActiveMs).toISOString() : null,
        online,
        verification,
      };
    });

    const stats = {
      total: enriched.length,
      online: enriched.filter((u) => u.online).length,
      active: enriched.filter((u) => u.verification === "active").length,
      unverified: enriched.filter((u) => u.verification === "unverified").length,
      suspended: enriched.filter((u) => u.verification === "suspended").length,
    };

    return apiSuccess({ users: enriched, stats, serverTime: now });
  } catch (error) {
    return handleApiError(error);
  }
}

const createUserSchema = z.object({
  username: z.string().trim().min(USERNAME_MIN).max(USERNAME_MAX),
  email: z.string().email().max(254).optional(),
  password: z.string().min(8).max(200),
  role: z.enum(["user"]).default("user"),
  quotaBytes: z.number().int().positive().max(MAX_QUOTA_BYTES).optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMasterOrApiKey(request, "users");
    const body = createUserSchema.parse(await request.json());
    const ip = getClientIp(request);
    const settings = await getAdminSettings();

    // PASSWORD STRENGTH VALIDATION
    const passwordCheck = validatePasswordStrength(body.password);
    if (!passwordCheck.valid) {
      return apiError(`Password too weak: ${passwordCheck.errors.join(", ")}`, 400);
    }

    const passwordHash = await hashPassword(body.password);
    const quotaBytes = body.quotaBytes ?? defaultQuotaBytes(settings);
    // Egress allowance for a fresh account, from Admin → Settings. 0 means
    // unmetered, which is what every account got before this was configurable.
    const bandwidthQuotaBytes = defaultBandwidthQuotaBytes(settings);

    const [user] = await db
      .insert(users)
      .values({
        username: body.username,
        email: body.email ? body.email.toLowerCase() : null,
        passwordHash,
        role: body.role,
        quotaBytes,
        bandwidthQuotaBytes,
      })
      .returning();

    await logActivity(master, "create_user", {
      resourceType: "user",
      resourceId: user.id,
      metadata: { username: user.username, passwordStrength: passwordCheck.score },
      ip,
    });

    void publishToAdmins({ type: "user_registered", userId: user.id, at: Date.now() });

    return apiSuccess({ user: { ...user, passwordHash: undefined } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMasterOrApiKey(request, "users");
    const body = adminUserUpdateByIdSchema.parse(await request.json());
    const ip = getClientIp(request);

    const [existing] = await db.select().from(users).where(eq(users.id, body.id)).limit(1);
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

    // PASSWORD STRENGTH VALIDATION on update
    if (body.password) {
      const passwordCheck = validatePasswordStrength(body.password);
      if (!passwordCheck.valid) {
        return apiError(`Password too weak: ${passwordCheck.errors.join(", ")}`, 400);
      }
    }

    const updates: Partial<typeof existing> = { updatedAt: new Date() };
    if (body.username) updates.username = body.username;
    if (body.email !== undefined) {
      const normalized = normalizeAdminEmail(body.email);
      if (!normalized.ok) return apiError("Please enter a valid email address.", 400);
      updates.email = normalized.email;
    }
    if (body.status) {
      updates.status = body.status;
      if (body.status === "active") {
        updates.suspendReason = null;
      } else if (body.status === "suspended") {
        updates.suspendReason = body.suspendReason ?? existing.suspendReason ?? "Suspended by administrator";
      }
    }
    if (body.suspendReason !== undefined && body.status !== "active") {
      updates.suspendReason = body.suspendReason;
    }
    if (body.mustChangePassword !== undefined) {
      updates.mustChangePassword = body.mustChangePassword;
    }
    if (body.quotaBytes !== undefined) updates.quotaBytes = body.quotaBytes;
    if (body.bandwidthQuotaBytes !== undefined) updates.bandwidthQuotaBytes = body.bandwidthQuotaBytes;
    if (body.password) updates.passwordHash = await hashPassword(body.password);
    if (body.role) updates.role = body.role;

    await db.update(users).set(updates).where(eq(users.id, body.id));

    // Same reason as the per-user route: the credential and the session rows are
    // independent, so evicting someone means deleting the rows.
    const revocation = sessionRevocationReason(body);
    if (revocation) await destroyAllUserSessions(body.id);

    if (body.status === "suspended") {
      await logActivity(master, "suspend_user", {
        resourceType: "user",
        resourceId: body.id,
        metadata: { reason: updates.suspendReason, sessionsRevoked: revocation },
        ip,
      });
    } else {
      await logActivity(master, "update_user", {
        resourceType: "user",
        resourceId: body.id,
        ...(revocation ? { metadata: { sessionsRevoked: revocation } } : {}),
        ip,
      });
    }

    void publishToAdmins({ type: "user_updated", userId: body.id, at: Date.now() });

    return apiSuccess({ updated: true, sessionsRevoked: revocation !== null });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMasterOrApiKey(request, "users");
    const { id, deleteData } = z
      .object({ id: z.string().uuid(), deleteData: z.boolean().default(false) })
      .parse(await request.json());
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

    await logActivity(master, "delete_user", {
      resourceType: "user",
      resourceId: id,
      metadata: { deleteData },
      ip,
    });

    void publishToAdmins({ type: "user_deleted", userId: id, at: Date.now() });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
