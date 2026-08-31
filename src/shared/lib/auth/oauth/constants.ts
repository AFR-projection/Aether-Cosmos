import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { nanoid } from "nanoid";

export const OAUTH_ACCESS_PREFIX = "oat_";
export const OAUTH_REFRESH_PREFIX = "ort_";
export const OAUTH_CODE_PREFIX = "oac_";

export const OAUTH_SCOPES = ["read", "upload", "download", "delete", "write", "full"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * Elevated scopes that only a master account may ever be granted over OAuth.
 * These are clamped away server-side for non-master users (see clampScopesToRole),
 * so a malicious client requesting them against a normal user's login gets nothing.
 */
export const OAUTH_MASTER_SCOPES = [
  "supreme",
  "admin",
  "admin:users",
  "admin:settings",
  "admin:stats",
  "admin:monitoring",
  "admin:shares",
  "admin:email",
] as const;
export type OAuthMasterScope = (typeof OAUTH_MASTER_SCOPES)[number];

export type AnyOAuthScope = OAuthScope | OAuthMasterScope;

/** Every scope name that is valid over OAuth (storage + master). */
export const ALL_OAUTH_SCOPES: readonly string[] = [...OAUTH_SCOPES, ...OAUTH_MASTER_SCOPES];

export function isMasterOnlyScope(scope: string): boolean {
  return (OAUTH_MASTER_SCOPES as readonly string[]).includes(scope);
}

export const ACCESS_TOKEN_TTL_SEC = 3600;
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;
export const AUTH_CODE_TTL_SEC = 600;

/** Loopback hosts — allowed over http per RFC 8252 (native/desktop clients). */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/**
 * URL schemes that must never be accepted as an OAuth redirect target — they are
 * script/exfiltration vectors, not real client callbacks.
 */
const BLOCKED_REDIRECT_SCHEMES = ["javascript:", "data:", "file:", "vbscript:", "blob:"];

export function oauthBaseUrl(fallbackOrigin?: string): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_PUBLIC_URL ?? "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (fallbackOrigin) return fallbackOrigin.replace(/\/$/, "");
  return "http://localhost:3000";
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifySecret(value: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(value));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateClientId(): string {
  return crypto.randomUUID();
}

export function generateClientSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function generateOpaqueToken(prefix: string): string {
  return `${prefix}${nanoid(48)}`;
}

export function parseScopes(scope?: string | null): AnyOAuthScope[] {
  if (!scope?.trim()) return ["read"];
  const parts = scope.split(/\s+/).filter(Boolean);
  const valid = parts.filter((s): s is AnyOAuthScope => ALL_OAUTH_SCOPES.includes(s));
  return valid.length ? valid : ["read"];
}

export function scopesToString(scopes: AnyOAuthScope[]): string {
  return [...new Set(scopes)].join(" ");
}

/**
 * SECURITY BOUNDARY — clamp requested scopes to what the account's role may hold.
 * Master-only scopes (admin:*, admin, supreme) are stripped for any non-master
 * user, no matter what the OAuth client asked for or what the user clicked.
 * "read" is always kept as a baseline so a token is never empty.
 */
export function clampScopesToRole(
  scopes: AnyOAuthScope[],
  role: string
): AnyOAuthScope[] {
  const isMaster = role === "master";
  const allowed = scopes.filter((s) => (isMaster ? true : !isMasterOnlyScope(s)));
  const deduped = Array.from(new Set<AnyOAuthScope>(["read", ...allowed]));
  return deduped;
}

/**
 * Standard OAuth redirect policy — platform-agnostic. Accepts any callback a
 * spec-compliant OAuth client would use, and rejects known exfiltration vectors.
 *
 * Allowed:
 *  - Any HTTPS URL (ChatGPT, Claude, hosted web connectors)
 *  - http:// only for loopback hosts, any port (RFC 8252 native apps)
 *  - Custom application schemes, e.g. cursor://, vscode://, com.example.app:/oauth
 * Rejected:
 *  - javascript:/data:/file:/vbscript:/blob: and other script vectors
 *  - Plain http:// to non-loopback hosts (token interception risk)
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (!uri) return false;

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  const scheme = url.protocol.toLowerCase();
  if (BLOCKED_REDIRECT_SCHEMES.includes(scheme)) return false;

  // Hosted web callbacks must be HTTPS.
  if (scheme === "https:") return true;

  // Loopback may use http on any port (desktop/native clients).
  if (scheme === "http:") {
    return LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());
  }

  // Custom application schemes (cursor://, vscode://, com.example:/cb, …).
  // A private-use scheme is anything that isn't a normal web/dangerous scheme;
  // requiring a scheme-specific part rules out bare "foo:".
  if (scheme !== "http:" && scheme !== "https:") {
    return uri.length > scheme.length + 1;
  }

  return false;
}

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string
): boolean {
  if (method !== "S256") return false;
  const digest = createHash("sha256").update(codeVerifier).digest("base64url");
  return digest === codeChallenge;
}
