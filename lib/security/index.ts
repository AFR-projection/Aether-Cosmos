import { redisIncr, redisGetInt, redisDel } from "@/lib/cache/redis";
import {
  checkIpRateLimit as memCheckIp,
  peekIpRateLimit as memPeekIp,
  resetIpRateLimit as memResetIp,
} from "./rate-limiter";

function loginMemIp(key: string): string {
  return key.replace(/^login:/, "");
}

function redisWindowKey(key: string, windowMs: number): string {
  return `ratelimit:${key}:${Math.floor(Date.now() / windowMs)}`;
}

/** Increment + check (used when recording a failure). */
export async function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number }> {
  const count = await redisIncr(redisWindowKey(key, windowMs), windowMs);

  if (count === null) {
    return memCheckIp(loginMemIp(key), maxAttempts, windowMs);
  }

  return {
    allowed: count <= maxAttempts,
    remaining: Math.max(0, maxAttempts - count),
  };
}

/** Read-only check — does not increment. */
export async function peekRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; count: number }> {
  const count = await redisGetInt(redisWindowKey(key, windowMs));

  if (count === null) {
    const n = memPeekIp(loginMemIp(key), windowMs);
    return {
      allowed: n < maxAttempts,
      remaining: Math.max(0, maxAttempts - n),
      count: n,
    };
  }

  return {
    allowed: count < maxAttempts,
    remaining: Math.max(0, maxAttempts - count),
    count,
  };
}

/** Best-effort clear of the current window bucket. */
export async function resetRateLimit(key: string, windowMs: number): Promise<void> {
  await redisDel(redisWindowKey(key, windowMs));
  memResetIp(loginMemIp(key));
}

/**
 * Per-user API rate limit from the admin "Rate Limit" setting.
 *
 * Bulk endpoints get a multiplier rather than a fixed floor: a batch upload
 * legitimately issues far more requests than a page load, but an admin who sets
 * the limit to 20 still expects uploads to be limited proportionally. A fixed
 * floor meant any value below it was silently ignored.
 */
export async function checkUserApiRateLimit(
  userId: string,
  perMinute: number,
  opts?: { bucket?: string; multiplier?: number }
): Promise<{ allowed: boolean; remaining: number }> {
  const bucket = opts?.bucket ?? "api";
  const max = Math.max(1, Math.round(perMinute * (opts?.multiplier ?? 1)));
  return checkRateLimit(`${bucket}:${userId}`, max, 60_000);
}

export function checkIpRateLimit(
  ip: string,
  maxAttempts: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  return memCheckIp(ip, maxAttempts, windowMs);
}

export function resetIpRateLimit(ip: string): void {
  memResetIp(ip);
}

import type { NextRequest } from "next/server";

export async function validateCsrf(request: NextRequest): Promise<boolean> {
  // Skip CSRF for programmatic Bearer credentials (sk_/skm_ API keys and oat_
  // OAuth access tokens). These are never sent automatically by a browser, so
  // they carry no CSRF risk — and requiring a CSRF cookie would break every
  // headless API/MCP client that writes (upload, edit, delete).
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (
      token.startsWith("sk_") ||
      token.startsWith("skm_") ||
      token.startsWith("oat_")
    ) {
      return true;
    }
  }

  const headerToken = request.headers.get("x-csrf-token");
  const cookieToken = request.cookies.get("csrf_token")?.value;

  if (!headerToken || !cookieToken) return false;
  return headerToken === cookieToken;
}

export function generateCsrfToken(): string {
  return crypto.randomUUID();
}

export const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
