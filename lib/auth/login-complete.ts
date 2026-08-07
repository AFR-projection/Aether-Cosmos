import { eq, and, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, sessions, type User } from "@/lib/db/schema";
import { createSession, deviceLabelFromUa, isBindableIp } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/audit";
import { resetRateLimit } from "@/lib/security";
import { notifyUser } from "@/lib/email/notify-user";
import { getIpLocation } from "@/lib/access-tracking";
import { publishToAdmins } from "@/lib/realtime/events";

/**
 * Shared tail of a successful login, used by every stage that can be the final
 * one (password-only, after the 2-Step Code, or after TOTP). Keeping it here
 * stops the three exits from drifting apart on session creation, auditing, or
 * new-device notification.
 */

async function notifyNewLogin(userId: string, ip: string, userAgent: string): Promise<void> {
  let location: string | null = null;
  try {
    if (isBindableIp(ip)) {
      const loc = await getIpLocation(ip);
      if (loc) {
        if (loc.city && loc.city !== "Unknown" && loc.country && loc.country !== "Unknown") {
          location = `${loc.city}, ${loc.country}`;
        } else if (loc.country && loc.country !== "Unknown") {
          location = loc.country;
        }
      }
    }
  } catch {
    // geo lookup is best-effort
  }
  await notifyUser(userId, {
    type: "login",
    at: new Date(),
    ip,
    device: deviceLabelFromUa(userAgent),
    location,
  });
}

export interface LoginCompletion {
  user: { id: string; username: string; email: string | null; role: string };
  mustChangePassword: boolean;
  stepCodeMustChange: boolean;
  newDevice: boolean;
}

export async function completeLogin(
  user: User,
  ctx: { ip: string; userAgent: string; lockoutWindowMs: number; layers: string[] }
): Promise<LoginCompletion> {
  const prior = await db
    .select({ ip: sessions.ip, userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())));

  const newDevice =
    prior.length === 0 ||
    !prior.some((s) => s.userAgent === ctx.userAgent) ||
    !prior.some((s) => s.ip === ctx.ip);

  await createSession(user.id, ctx.ip, ctx.userAgent);
  await resetRateLimit(`login:${ctx.ip}`, ctx.lockoutWindowMs);

  // Clear both counters — a full login proves the user holds every factor.
  if ((user.failedLoginAttempts ?? 0) > 0 || (user.stepCodeFailedAttempts ?? 0) > 0) {
    await db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        stepCodeFailedAttempts: 0,
        stepCodeLockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
  }

  await logActivity(user, "login", {
    ip: ctx.ip,
    metadata: {
      userAgent: ctx.userAgent,
      success: true,
      layers: ctx.layers,
      newDevice,
    },
  });

  void publishToAdmins({
    type: "user_presence",
    userId: user.id,
    online: true,
    at: Date.now(),
  });

  if (newDevice) {
    void notifyNewLogin(user.id, ctx.ip, ctx.userAgent);
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
    mustChangePassword: user.mustChangePassword,
    stepCodeMustChange: user.stepCodeMustChange,
    newDevice,
  };
}
