import { createHash } from "crypto";
import { cookies, headers } from "next/headers";
import { eq, and, gt, desc, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions, users, type User } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { getAdminSettings, sessionIdleTimeoutMs, sessionIpBindingEnabled } from "@/lib/admin-settings";
import { logActivity } from "@/lib/auth/audit";
import { cookieSecure } from "@/lib/env/runtime";
import { getIpLocation, parseUserAgent } from "@/lib/access-tracking";

const SESSION_COOKIE = "storage_session";
const ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Idle cut-off and IP binding both live in Admin → Settings now.
 *
 * Idle expiry stays deliberately opt-in (0 = off). It used to default to 30
 * minutes, which silently overrode the admin's "Session Duration" setting — a
 * session configured for a week still died after half an hour of inactivity, so
 * the setting did nothing. Absolute expiry (sessionDurationHours) is the
 * authority; the idle timeout is an explicit extra tightening on top of it.
 *
 * They were `SESSION_INACTIVITY_MS` and `SESSION_IP_BIND`, which meant changing
 * either one needed a redeploy. The helpers in lib/admin-settings.ts keep the
 * same three-state semantics for IP binding (on / off / auto = production only).
 */

/** True if IP is suitable for production IP binding. */
export function isBindableIp(ip: string | null | undefined): boolean {
  if (!ip || ip === "unknown") return false;
  const normalized = ip.trim().toLowerCase();
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "0.0.0.0"
  ) {
    return false;
  }
  // IPv4 private / link-local
  if (/^10\./.test(normalized)) return false;
  if (/^192\.168\./.test(normalized)) return false;
  if (/^169\.254\./.test(normalized)) return false;
  const m172 = normalized.match(/^172\.(\d+)\./);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) return false;
  }
  // IPv6 unique local / link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80")) {
    return false;
  }
  return true;
}

function firstPublicForwardedIp(xff: string | null): string | null {
  if (!xff) return null;
  for (const part of xff.split(",")) {
    const candidate = part.trim();
    if (candidate && isBindableIp(candidate)) return candidate;
    if (candidate && candidate !== "unknown") return candidate;
  }
  return xff.split(",")[0]?.trim() || null;
}

/** Resolve client IP: cf-connecting-ip → first public XFF hop → x-real-ip → unknown */
export function resolveClientIp(opts: {
  cfConnectingIp?: string | null;
  xForwardedFor?: string | null;
  xRealIp?: string | null;
}): string {
  const cf = opts.cfConnectingIp?.trim();
  if (cf) return cf;

  const forwarded = firstPublicForwardedIp(opts.xForwardedFor ?? null);
  if (forwarded) return forwarded;

  const real = opts.xRealIp?.trim();
  if (real) return real;

  return "unknown";
}

export function getClientIp(request: Request): string {
  return resolveClientIp({
    cfConnectingIp: request.headers.get("cf-connecting-ip"),
    xForwardedFor: request.headers.get("x-forwarded-for"),
    xRealIp: request.headers.get("x-real-ip"),
  });
}

export async function getClientIpFromHeaders(): Promise<string> {
  const h = await headers();
  return resolveClientIp({
    cfConnectingIp: h.get("cf-connecting-ip"),
    xForwardedFor: h.get("x-forwarded-for"),
    xRealIp: h.get("x-real-ip"),
  });
}

/** Human-readable device label, e.g. "Chrome on Windows 11". */
export function deviceLabelFromUa(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const { browser, os, device } = parseUserAgent(userAgent);
  if (browser === "Unknown" && os === "Unknown") {
    if (device === "Mobile") return "Mobile browser";
    if (device === "Tablet") return "Tablet browser";
    return "Unknown device";
  }
  if (browser === "Unknown") return os;
  if (os === "Unknown") return browser;
  return `${browser} on ${os}`;
}

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export function deviceKindFromUa(userAgent: string | null | undefined): DeviceKind {
  if (!userAgent) return "unknown";
  const { device } = parseUserAgent(userAgent);
  if (device === "Mobile") return "mobile";
  if (device === "Tablet") return "tablet";
  if (device === "Desktop") return "desktop";
  return "unknown";
}

/** Stable soft fingerprint from UA (not for auth — only for "same browser" hints). */
export function softUaFingerprint(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return createHash("sha256").update(userAgent).digest("hex").slice(0, 16);
}

function formatLocationLabel(parts: {
  city?: string | null;
  region?: string | null;
  country?: string | null;
}): string | null {
  const city = parts.city?.trim();
  const region = parts.region?.trim();
  const country = parts.country?.trim();
  if (city && country && city !== "Unknown" && country !== "Unknown") {
    return region && region !== city ? `${city}, ${region}, ${country}` : `${city}, ${country}`;
  }
  if (country && country !== "Unknown") return country;
  if (city && city !== "Unknown") return city;
  return null;
}

/**
 * Fire-and-forget IP geolocation enrich for a session row.
 * Never blocks login; failures are silent.
 */
export function enrichSessionLocation(sessionId: string, ip: string | null | undefined): void {
  if (!ip || !isBindableIp(ip)) return;
  void (async () => {
    try {
      const loc = await getIpLocation(ip);
      if (!loc) return;
      const locationLabel = formatLocationLabel(loc);
      await db
        .update(sessions)
        .set({
          locationLabel,
          locationCity: loc.city !== "Unknown" ? loc.city : null,
          locationCountry: loc.country !== "Unknown" ? loc.country : null,
          locationRegion: loc.region || null,
        })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      console.warn(`[session] location enrich failed for ${sessionId}:`, err);
    }
  })();
}

export type SessionUser = User & {
  effectiveUserId: string;
  isImpersonating: boolean;
  sessionId: string;
};

export class AuthError extends Error {
  status: number;
  code?: string;
  previousIp?: string;
  currentIp?: string;

  constructor(
    message: string,
    status = 401,
    code?: string,
    extras?: { previousIp?: string; currentIp?: string }
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.previousIp = extras?.previousIp;
    this.currentIp = extras?.currentIp;
  }
}

export async function createSession(
  userId: string,
  ip?: string,
  userAgent?: string,
  impersonatingUserId?: string
): Promise<string> {
  const settings = await getAdminSettings();
  const maxSessions = settings.maxSessionsPerUser || 10;
  const durationMs = Math.max(1, settings.sessionDurationHours || 168) * 60 * 60 * 1000;

  const existing = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.lastActiveAt));

  // Enforce max concurrent sessions — drop oldest by lastActiveAt
  if (existing.length >= maxSessions) {
    const toDrop = existing.slice(maxSessions - 1);
    for (const s of toDrop) {
      await db.delete(sessions).where(eq(sessions.id, s.id));
    }
  }

  const sessionId = nanoid(32);
  const expiresAt = new Date(Date.now() + durationMs);
  const now = new Date();

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    deviceLabel: deviceLabelFromUa(userAgent),
    lastActiveAt: now,
    impersonatingUserId: impersonatingUserId ?? null,
  });

  enrichSessionLocation(sessionId, ip);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });

  return sessionId;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    cookieStore.delete(SESSION_COOKIE);
  }
}

export async function destroyAllUserSessions(
  userId: string,
  exceptSessionId?: string
): Promise<void> {
  if (exceptSessionId) {
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)));
    return;
  }
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function rotateSession(
  currentSessionId: string,
  userId: string,
  ip?: string,
  userAgent?: string,
  impersonatingUserId?: string | null,
  preserve?: {
    deviceLabel?: string | null;
    locationLabel?: string | null;
    locationCity?: string | null;
    locationCountry?: string | null;
    locationRegion?: string | null;
  }
): Promise<string> {
  const settings = await getAdminSettings();
  const durationMs = Math.max(1, settings.sessionDurationHours || 168) * 60 * 60 * 1000;
  const newSessionId = nanoid(32);
  const expiresAt = new Date(Date.now() + durationMs);
  const now = new Date();

  await db.delete(sessions).where(eq(sessions.id, currentSessionId));

  await db.insert(sessions).values({
    id: newSessionId,
    userId,
    expiresAt,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    deviceLabel: preserve?.deviceLabel ?? deviceLabelFromUa(userAgent),
    locationLabel: preserve?.locationLabel ?? null,
    locationCity: preserve?.locationCity ?? null,
    locationCountry: preserve?.locationCountry ?? null,
    locationRegion: preserve?.locationRegion ?? null,
    lastActiveAt: now,
    impersonatingUserId: impersonatingUserId ?? null,
  });

  // Re-enrich if we still have no location (e.g. first lookup failed earlier)
  if (!preserve?.locationLabel) {
    enrichSessionLocation(newSessionId, ip);
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, newSessionId, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });

  return newSessionId;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!session) return null;

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || user.status === "suspended") return null;

  // Maintenance: non-master blocked (masters still work)
  // The same settings row also carries the idle cut-off and the IP-binding mode,
  // so it is fetched once here and reused below rather than read three times.
  const settings = await getAdminSettings().catch(() => null);
  if (settings?.maintenanceMode && user.role !== "master") {
    return null;
  }

  const currentIp = await getClientIpFromHeaders();

  // Optional idle cut-off on top of the absolute expiry checked in the query above.
  const idleLimit = sessionIdleTimeoutMs(settings ?? undefined);
  const lastActive = session.lastActiveAt
    ? new Date(session.lastActiveAt).getTime()
    : new Date(session.createdAt).getTime();
  if (idleLimit !== null && Date.now() - lastActive > idleLimit) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    const cookieStore2 = await cookies();
    cookieStore2.delete(SESSION_COOKIE);
    throw new AuthError(
      "Your session has expired due to inactivity. Please sign in again.",
      401,
      "SESSION_INACTIVE"
    );
  }

  // IP bind (Admin → Settings; "auto" means production only); skip unknown/private
  if (
    sessionIpBindingEnabled(settings ?? undefined) &&
    isBindableIp(session.ip) &&
    isBindableIp(currentIp) &&
    session.ip !== currentIp
  ) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    const cookieStore2 = await cookies();
    cookieStore2.delete(SESSION_COOKIE);

    await logActivity(user, "session_revoked", {
      ip: currentIp,
      metadata: {
        reason: "ip_change",
        previousIp: session.ip,
        currentIp,
        sessionId,
      },
    });

    throw new AuthError(
      "Your session was revoked because your IP address changed.",
      401,
      "SESSION_IP_CHANGED",
      { previousIp: session.ip ?? undefined, currentIp }
    );
  }

  let activeSessionId = session.id;

  // Opaque session ID rotation after 24h — preserve device/location metadata
  const sessionAge = Date.now() - new Date(session.createdAt).getTime();
  if (sessionAge > ROTATION_INTERVAL_MS) {
    activeSessionId = await rotateSession(
      sessionId,
      user.id,
      currentIp !== "unknown" ? currentIp : session.ip ?? undefined,
      session.userAgent ?? undefined,
      session.impersonatingUserId,
      {
        deviceLabel: session.deviceLabel,
        locationLabel: session.locationLabel,
        locationCity: session.locationCity,
        locationCountry: session.locationCountry,
        locationRegion: session.locationRegion,
      }
    );
  } else {
    // Touch lastActiveAt (throttle ~1/min)
    if (Date.now() - lastActive > 60_000) {
      await db
        .update(sessions)
        .set({ lastActiveAt: new Date() })
        .where(eq(sessions.id, activeSessionId));
    }
  }

  const effectiveUserId = session.impersonatingUserId ?? user.id;

  return {
    ...user,
    effectiveUserId,
    isImpersonating: !!session.impersonatingUserId,
    sessionId: activeSessionId,
  };
}

export async function requireAuth(): Promise<SessionUser> {
  try {
    const user = await getSessionUser();
    if (!user) {
      const settings = await getAdminSettings().catch(() => null);
      if (settings?.maintenanceMode) {
        throw new AuthError(settings.maintenanceMessage || "Maintenance mode", 503, "MAINTENANCE");
      }
      throw new AuthError("Unauthorized");
    }
    return user;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw error;
  }
}

export async function requireMaster(): Promise<SessionUser> {
  const user = await requireAuth();
  if (user.role !== "master") {
    throw new AuthError("Forbidden", 403);
  }
  return user;
}

// Keep sync snapshot warm
getAdminSettings().catch(() => {});
