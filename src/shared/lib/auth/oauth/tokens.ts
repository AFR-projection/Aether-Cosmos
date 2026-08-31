import { eq, and, isNull, gt, desc } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { oauthAccessTokens, oauthClients, users } from "@/shared/infrastructure/db/schema";
import {
  ACCESS_TOKEN_TTL_SEC,
  generateOpaqueToken,
  hashSecret,
  OAUTH_ACCESS_PREFIX,
  OAUTH_REFRESH_PREFIX,
  REFRESH_TOKEN_TTL_SEC,
  parseScopes,
  type OAuthScope,
} from "@/shared/lib/auth/oauth/constants";
import { keyHasScope } from "@/shared/lib/auth/api-key";
import type { SessionUserFromApiKey } from "@/shared/lib/auth/api-key";

export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

export async function issueTokens(input: {
  clientId: string;
  userId: string;
  scope: string;
}): Promise<OAuthTokenResponse> {
  const accessToken = generateOpaqueToken(OAUTH_ACCESS_PREFIX);
  const refreshToken = generateOpaqueToken(OAUTH_REFRESH_PREFIX);
  const now = Date.now();
  const expiresAt = new Date(now + ACCESS_TOKEN_TTL_SEC * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_SEC * 1000);

  await db.insert(oauthAccessTokens).values({
    tokenHash: hashSecret(accessToken),
    refreshTokenHash: hashSecret(refreshToken),
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    expiresAt,
    refreshExpiresAt,
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

/**
 * Rotate a refresh token. The old row is revoked by the SAME statement that
 * selects it, so two concurrent refreshes cannot both succeed: the loser sees
 * zero rows and gets `null`.
 *
 * With a SELECT-then-UPDATE, a stolen refresh token could be redeemed in
 * parallel with the real client's rotation and both would receive a live access
 * token — the exact replay window RFC 6749 §10.4 asks implementations to close.
 */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<OAuthTokenResponse | null> {
  const refreshHash = hashSecret(input.refreshToken);
  const [row] = await db
    .update(oauthAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthAccessTokens.refreshTokenHash, refreshHash),
        eq(oauthAccessTokens.clientId, input.clientId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.refreshExpiresAt, new Date())
      )
    )
    .returning();

  if (!row) return null;

  return issueTokens({
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
  });
}

export async function authenticateOAuthAccessToken(
  rawToken: string,
  requiredScopes: string[] = []
): Promise<SessionUserFromApiKey | null> {
  if (!rawToken.startsWith(OAUTH_ACCESS_PREFIX)) return null;

  const tokenHash = hashSecret(rawToken);
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!row) return null;

  const scopes = parseScopes(row.scope) as string[];
  for (const required of requiredScopes) {
    if (!keyHasScope(scopes, required)) return null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || user.status === "suspended") return null;

  const tier = user.role === "master" ? "master" : "standard";

  return {
    ...user,
    effectiveUserId: user.id,
    isImpersonating: false,
    sessionId: `oauth:${row.id}`,
    authMethod: "api_key",
    apiKeyId: `oauth:${row.clientId}`,
    apiKeyScopes: scopes,
    apiKeyTier: tier,
  };
}

export function oauthScopesInclude(scopeString: string, required: OAuthScope): boolean {
  return keyHasScope(parseScopes(scopeString), required);
}

export type ConnectedApp = {
  clientId: string;
  clientName: string | null;
  scopes: string[];
  activeTokens: number;
  firstConnectedAt: string;
  lastConnectedAt: string;
  expiresAt: string;
};

/**
 * Apps the user has authorized over OAuth — one row per client, aggregated from
 * that user's non-revoked, non-expired access tokens. This powers the
 * "Connected apps" list + Revoke on the Connection page.
 */
export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const now = new Date();
  const rows = await db
    .select({
      clientId: oauthAccessTokens.clientId,
      scope: oauthAccessTokens.scope,
      createdAt: oauthAccessTokens.createdAt,
      expiresAt: oauthAccessTokens.expiresAt,
      clientName: oauthClients.clientName,
    })
    .from(oauthAccessTokens)
    .leftJoin(oauthClients, eq(oauthClients.clientId, oauthAccessTokens.clientId))
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, now)
      )
    )
    .orderBy(desc(oauthAccessTokens.createdAt));

  const byClient = new Map<string, ConnectedApp>();
  for (const row of rows) {
    const existing = byClient.get(row.clientId);
    const scopes = parseScopes(row.scope) as string[];
    const created = row.createdAt.toISOString();
    const expires = row.expiresAt.toISOString();
    if (!existing) {
      byClient.set(row.clientId, {
        clientId: row.clientId,
        clientName: row.clientName ?? null,
        scopes,
        activeTokens: 1,
        firstConnectedAt: created,
        lastConnectedAt: created,
        expiresAt: expires,
      });
    } else {
      existing.activeTokens += 1;
      // rows are newest-first, so first seen = lastConnectedAt; keep earliest as first
      existing.firstConnectedAt = created;
      existing.scopes = Array.from(new Set([...existing.scopes, ...scopes]));
      if (expires > existing.expiresAt) existing.expiresAt = expires;
    }
  }

  return [...byClient.values()];
}

/**
 * Revoke every active token this user holds for a given client. Returns the
 * number of tokens revoked (0 if the user had no live tokens for that client).
 */
export async function revokeConnectedApp(userId: string, clientId: string): Promise<number> {
  const revoked = await db
    .update(oauthAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.clientId, clientId),
        isNull(oauthAccessTokens.revokedAt)
      )
    )
    .returning({ id: oauthAccessTokens.id });
  return revoked.length;
}
