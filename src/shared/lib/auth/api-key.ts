import { eq, and, desc, count, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/shared/infrastructure/db";
import { apiKeys, users, type User } from "@/shared/infrastructure/db/schema";
import { hashPassword, verifyPassword } from "@/shared/lib/auth/password";
import { AuthError, getSessionUser, requireMaster, type SessionUser } from "@/shared/lib/auth/session";
import { checkRateLimit, peekRateLimit } from "@/shared/lib/security";
import { OAUTH_ACCESS_PREFIX } from "@/shared/lib/auth/oauth/constants";
import { authenticateOAuthAccessToken } from "@/shared/lib/auth/oauth/tokens";
// Only pure scope helpers — @brain/domain/constants.ts imports nothing but the schema,
// so this cannot form a cycle back through the brain services.
import { brainScopeSatisfied } from "@brain/domain/constants";

export type ApiKeyScope = "read" | "upload" | "download" | "delete" | "write" | "full";

export const API_KEY_SCOPES: ApiKeyScope[] = [
  "read",
  "upload",
  "download",
  "delete",
  "write",
  "full",
];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, { label: string; description: string }> = {
  read: {
    label: "Read",
    description: "List files, folders, search, and file metadata",
  },
  upload: {
    label: "Upload",
    description: "Upload files via presign → complete flow",
  },
  download: {
    label: "Download",
    description: "Download individual files and zip archives",
  },
  delete: {
    label: "Delete",
    description: "Soft delete and permanently remove files",
  },
  write: {
    label: "Write",
    description: "Rename, move, favorite, restore, and edit notes",
  },
  full: {
    label: "Full access",
    description: "All storage API permissions (excluding admin routes)",
  },
};

export const API_KEY_PRESETS = {
  ai_agent: {
    name: "AI Agent",
    description: "Best for AI assistants — read, upload, download, and edit notes",
    scopes: ["read", "upload", "download", "write"] as ApiKeyScope[],
    expiresInDays: 90,
  },
  read_only: {
    name: "Read only",
    description: "Browse and search files without making changes",
    scopes: ["read"] as ApiKeyScope[],
    expiresInDays: null as number | null,
  },
  upload_bot: {
    name: "Upload bot",
    description: "Automated uploads with file listing",
    scopes: ["read", "upload"] as ApiKeyScope[],
    expiresInDays: 365,
  },
  full_access: {
    name: "Full access",
    description: "Complete programmatic access (use with caution)",
    scopes: ["full"] as ApiKeyScope[],
    expiresInDays: 90,
  },
} as const;

export type ApiKeyPreset = keyof typeof API_KEY_PRESETS;

export type AdminApiArea = "users" | "settings" | "stats" | "monitoring" | "shares" | "email";

export type MasterApiKeyScope =
  | ApiKeyScope
  | "admin"
  | "admin:users"
  | "admin:settings"
  | "admin:stats"
  | "admin:monitoring"
  | "admin:shares"
  | "admin:email"
  | "supreme";

export const MASTER_API_KEY_SCOPES: MasterApiKeyScope[] = [
  "supreme",
  "admin",
  "admin:users",
  "admin:settings",
  "admin:stats",
  "admin:monitoring",
  "admin:shares",
  "admin:email",
  "full",
  "read",
  "upload",
  "download",
  "delete",
  "write",
];

export const MASTER_SCOPE_LABELS: Record<
  MasterApiKeyScope,
  { label: string; description: string; tier: "supreme" | "admin" | "storage" }
> = {
  supreme: {
    label: "Supreme",
    description: "Unrestricted platform control — storage + all admin APIs",
    tier: "supreme",
  },
  admin: {
    label: "Admin (all)",
    description: "Full admin panel API access",
    tier: "admin",
  },
  "admin:users": {
    label: "Users",
    description: "Create, update, suspend, delete users",
    tier: "admin",
  },
  "admin:settings": {
    label: "Settings",
    description: "Platform configuration and maintenance mode",
    tier: "admin",
  },
  "admin:stats": {
    label: "Stats",
    description: "Dashboard statistics and overview metrics",
    tier: "admin",
  },
  "admin:monitoring": {
    label: "Monitoring",
    description: "System health and performance monitoring",
    tier: "admin",
  },
  "admin:shares": {
    label: "Shares",
    description: "Manage all shared links platform-wide",
    tier: "admin",
  },
  "admin:email": {
    label: "Email",
    description: "Gmail sender management for OTP and notifications",
    tier: "admin",
  },
  full: { ...API_KEY_SCOPE_LABELS.full, tier: "storage" },
  read: { ...API_KEY_SCOPE_LABELS.read, tier: "storage" },
  upload: { ...API_KEY_SCOPE_LABELS.upload, tier: "storage" },
  download: { ...API_KEY_SCOPE_LABELS.download, tier: "storage" },
  delete: { ...API_KEY_SCOPE_LABELS.delete, tier: "storage" },
  write: { ...API_KEY_SCOPE_LABELS.write, tier: "storage" },
};

export const MASTER_API_KEY_PRESETS = {
  supreme_command: {
    name: "Supreme Command",
    description: "Total platform authority — the most powerful key possible",
    scopes: ["supreme"] as MasterApiKeyScope[],
    expiresInDays: 90,
  },
  platform_ai: {
    name: "Platform AI",
    description: "AI agent with full storage + user management + stats",
    scopes: ["full", "admin:users", "admin:stats"] as MasterApiKeyScope[],
    expiresInDays: 90,
  },
  ops_center: {
    name: "Ops Center",
    description: "Monitoring, stats, and system settings",
    scopes: ["read", "admin:monitoring", "admin:stats", "admin:settings"] as MasterApiKeyScope[],
    expiresInDays: 365,
  },
  user_governor: {
    name: "User Governor",
    description: "Full user lifecycle management",
    scopes: ["admin:users", "admin:stats"] as MasterApiKeyScope[],
    expiresInDays: 180,
  },
  automation_god: {
    name: "Automation God Mode",
    description: "Unrestricted automation — expires in 30 days for safety",
    scopes: ["supreme"] as MasterApiKeyScope[],
    expiresInDays: 30,
  },
} as const;

export type MasterApiKeyPreset = keyof typeof MASTER_API_KEY_PRESETS;

export const MAX_API_KEYS_PER_USER = 10;
export const MAX_MASTER_API_KEYS = 25;
const FAILED_AUTH_MAX = 20;
const FAILED_AUTH_WINDOW_MS = 15 * 60_000;
const MASTER_KEY_PREFIX = "skm_";
const USER_KEY_PREFIX = "sk_";

export type SessionUserFromApiKey = User & {
  effectiveUserId: string;
  isImpersonating: boolean;
  sessionId: string;
  authMethod: "api_key";
  apiKeyId: string;
  apiKeyScopes: string[];
  apiKeyTier: "master" | "standard";
};

function generateRawKey(tier: "standard" | "master"): { raw: string; prefix: string } {
  const secret = nanoid(40);
  if (tier === "master") {
    const raw = `${MASTER_KEY_PREFIX}${secret}`;
    return { raw, prefix: raw.slice(0, 13) };
  }
  const raw = `${USER_KEY_PREFIX}${secret}`;
  return { raw, prefix: raw.slice(0, 12) };
}

export function isMasterApiKey(rawKey: string): boolean {
  return rawKey.startsWith(MASTER_KEY_PREFIX);
}

export function isBearerApiKeyRequest(request: Request): boolean {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  return token.startsWith(USER_KEY_PREFIX) || token.startsWith(MASTER_KEY_PREFIX);
}

export function isOAuthBearerRequest(request: Request): boolean {
  const token = extractBearerToken(request);
  return !!token?.startsWith(OAUTH_ACCESS_PREFIX);
}

/** API key or OAuth access token — bypasses session cookie in proxy */
export function isProgrammaticBearerRequest(request: Request): boolean {
  return isBearerApiKeyRequest(request) || isOAuthBearerRequest(request);
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

export function keyHasScope(keyScopes: string[], required: string): boolean {
  if (keyScopes.includes("supreme")) return true;

  // Second Brain scopes are a separate namespace and are NEVER implied by the
  // storage `full` scope: every key already issued with `full` would otherwise
  // silently gain read/write access to the owner's memories. Only an explicit
  // brain.<x> grant (or brain.full) opens those routes.
  if (required.startsWith("brain.")) {
    return brainScopeSatisfied(keyScopes, required);
  }

  if (required.startsWith("admin:") || required === "admin") {
    if (keyScopes.includes("admin")) return true;
    if (required === "admin") {
      return keyScopes.some((s) => s.startsWith("admin:"));
    }
    return keyScopes.includes(required);
  }

  if (keyScopes.includes("full")) return true;
  return keyScopes.includes(required);
}

/** True when this request was authenticated by an API key / OAuth token, not a cookie. */
export function isApiKeySession(user: SessionUser): user is SessionUserFromApiKey {
  return "authMethod" in user && (user as SessionUserFromApiKey).authMethod === "api_key";
}

export function keyHasAdminArea(keyScopes: string[], area: AdminApiArea): boolean {
  return keyHasScope(keyScopes, `admin:${area}`);
}

export function keyHasAnyScope(keyScopes: string[], required: string[]): boolean {
  return required.some((scope) => keyHasScope(keyScopes, scope));
}

export function normalizeApiKeyScopes(scopes: string[]): ApiKeyScope[] {
  return scopes.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as string[]).includes(s));
}

export function normalizeMasterApiKeyScopes(scopes: string[]): MasterApiKeyScope[] {
  return scopes.filter((s): s is MasterApiKeyScope =>
    (MASTER_API_KEY_SCOPES as string[]).includes(s)
  );
}

export async function countApiKeys(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), like(apiKeys.keyPrefix, `${USER_KEY_PREFIX}%`)));
  return row?.total ?? 0;
}

export async function countMasterApiKeys(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), like(apiKeys.keyPrefix, `${MASTER_KEY_PREFIX}%`)));
  return row?.total ?? 0;
}

export async function createApiKey(
  userId: string,
  name: string,
  scopes: ApiKeyScope[],
  expiresAt?: Date | null
) {
  return insertStandardApiKey(userId, name, scopes, expiresAt);
}

/**
 * Create a standard `sk_` key carrying scopes from a non-storage namespace
 * (currently only the Second Brain's `brain.*`). Kept as its own entry point so
 * callers never have to cast around the `ApiKeyScope` union — the scope strings
 * are validated by the caller's own union instead.
 */
export async function createNamespacedApiKey(
  userId: string,
  name: string,
  scopes: readonly string[],
  expiresAt?: Date | null
) {
  return insertStandardApiKey(userId, name, scopes, expiresAt);
}

async function insertStandardApiKey(
  userId: string,
  name: string,
  scopes: readonly string[],
  expiresAt?: Date | null
) {
  const existing = await countApiKeys(userId);
  if (existing >= MAX_API_KEYS_PER_USER) {
    throw new AuthError(`Maximum ${MAX_API_KEYS_PER_USER} API keys allowed`, 400);
  }

  const { raw, prefix } = generateRawKey("standard");
  const keyHash = await hashPassword(raw);

  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name,
      keyPrefix: prefix,
      keyHash,
      scopes: [...scopes],
      expiresAt: expiresAt ?? null,
    })
    .returning();

  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    rawKey: raw,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    tier: "standard" as const,
  };
}

export async function createMasterApiKey(
  userId: string,
  name: string,
  scopes: MasterApiKeyScope[],
  expiresAt?: Date | null
) {
  const [owner] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!owner || owner.role !== "master") {
    throw new AuthError("Only master accounts can create master API keys", 403);
  }

  const existing = await countMasterApiKeys(userId);
  if (existing >= MAX_MASTER_API_KEYS) {
    throw new AuthError(`Maximum ${MAX_MASTER_API_KEYS} master API keys allowed`, 400);
  }

  const { raw, prefix } = generateRawKey("master");
  const keyHash = await hashPassword(raw);

  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name,
      keyPrefix: prefix,
      keyHash,
      scopes,
      expiresAt: expiresAt ?? null,
    })
    .returning();

  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    rawKey: raw,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    tier: "master" as const,
  };
}

export async function listApiKeys(userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), like(apiKeys.keyPrefix, `${USER_KEY_PREFIX}%`)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function listMasterApiKeys(userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), like(apiKeys.keyPrefix, `${MASTER_KEY_PREFIX}%`)))
    .orderBy(desc(apiKeys.createdAt));
}

export async function deleteApiKey(userId: string, keyId: string): Promise<boolean> {
  const deleted = await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.userId, userId),
        like(apiKeys.keyPrefix, `${USER_KEY_PREFIX}%`)
      )
    )
    .returning({ id: apiKeys.id });
  return deleted.length > 0;
}

export async function deleteMasterApiKey(userId: string, keyId: string): Promise<boolean> {
  const deleted = await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.userId, userId),
        like(apiKeys.keyPrefix, `${MASTER_KEY_PREFIX}%`)
      )
    )
    .returning({ id: apiKeys.id });
  return deleted.length > 0;
}

function keyPrefixFromRaw(rawKey: string): string {
  return isMasterApiKey(rawKey) ? rawKey.slice(0, 13) : rawKey.slice(0, 12);
}

export async function authenticateApiKey(
  rawKey: string,
  requiredScopes: string[] = []
): Promise<SessionUserFromApiKey> {
  if (!rawKey.startsWith(USER_KEY_PREFIX) && !rawKey.startsWith(MASTER_KEY_PREFIX)) {
    throw new AuthError("Unauthorized");
  }

  const prefix = keyPrefixFromRaw(rawKey);
  const failKey = `apikey:fail:${prefix}`;
  const blocked = await peekRateLimit(failKey, FAILED_AUTH_MAX, FAILED_AUTH_WINDOW_MS);
  if (!blocked.allowed) {
    throw new AuthError("Too many failed authentication attempts", 429);
  }

  const [keyRow] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, prefix))
    .limit(1);

  if (!keyRow) {
    void checkRateLimit(failKey, FAILED_AUTH_MAX, FAILED_AUTH_WINDOW_MS);
    throw new AuthError("Unauthorized");
  }

  if (keyRow.expiresAt && keyRow.expiresAt.getTime() < Date.now()) {
    throw new AuthError("API key expired", 401);
  }

  const valid = await verifyPassword(rawKey, keyRow.keyHash);
  if (!valid) {
    void checkRateLimit(failKey, FAILED_AUTH_MAX, FAILED_AUTH_WINDOW_MS);
    throw new AuthError("Unauthorized");
  }

  for (const scope of requiredScopes) {
    if (!keyHasScope(keyRow.scopes, scope)) {
      throw new AuthError(`Missing scope: ${scope}`, 403);
    }
  }

  const [user] = await db.select().from(users).where(eq(users.id, keyRow.userId)).limit(1);
  if (!user || user.status === "suspended") {
    throw new AuthError("Unauthorized");
  }

  const tier = isMasterApiKey(rawKey) ? "master" : "standard";
  if (tier === "master" && user.role !== "master") {
    throw new AuthError("Unauthorized");
  }

  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyRow.id));

  return {
    ...user,
    effectiveUserId: user.id,
    isImpersonating: false,
    sessionId: `api_key:${keyRow.id}`,
    authMethod: "api_key",
    apiKeyId: keyRow.id,
    apiKeyScopes: keyRow.scopes,
    apiKeyTier: tier,
  };
}

export async function requireAuthOrApiKey(
  request: Request,
  requiredScopes: string[] = []
): Promise<SessionUser> {
  if (isBearerApiKeyRequest(request)) {
    const token = extractBearerToken(request);
    if (!token) throw new AuthError("Unauthorized");
    return authenticateApiKey(token, requiredScopes);
  }

  if (isOAuthBearerRequest(request)) {
    const token = extractBearerToken(request);
    if (!token) throw new AuthError("Unauthorized");
    const user = await authenticateOAuthAccessToken(token, requiredScopes);
    if (!user) throw new AuthError("Unauthorized");
    return user;
  }

  const user = await getSessionUser();
  if (!user) throw new AuthError("Unauthorized");
  return user;
}

export async function requireMasterOrApiKey(
  request: Request,
  adminArea: AdminApiArea
): Promise<SessionUser> {
  if (isBearerApiKeyRequest(request)) {
    const token = extractBearerToken(request);
    if (!token) throw new AuthError("Unauthorized");
    if (!isMasterApiKey(token)) {
      throw new AuthError("Master API key required (skm_…)", 403);
    }
    const user = await authenticateApiKey(token, []);
    if (user.role !== "master") throw new AuthError("Forbidden", 403);
    if (!keyHasAdminArea(user.apiKeyScopes, adminArea)) {
      throw new AuthError(`Missing scope: admin:${adminArea}`, 403);
    }
    return user;
  }

  // OAuth access tokens (oat_) — master users may reach admin APIs via OAuth.
  // Defense in depth: the account role is re-read from the DB inside
  // authenticateOAuthAccessToken, so a token that somehow carries an admin scope
  // is still rejected unless the underlying user is actually a master.
  if (isOAuthBearerRequest(request)) {
    const token = extractBearerToken(request);
    if (!token) throw new AuthError("Unauthorized");
    const user = await authenticateOAuthAccessToken(token, []);
    if (!user) throw new AuthError("Unauthorized");
    if (user.role !== "master") throw new AuthError("Forbidden", 403);
    if (!keyHasAdminArea(user.apiKeyScopes, adminArea)) {
      throw new AuthError(`Missing scope: admin:${adminArea}`, 403);
    }
    return user;
  }

  return requireMaster();
}
