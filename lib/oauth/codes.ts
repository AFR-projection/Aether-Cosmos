import { eq, and, isNull, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { oauthAuthorizationCodes } from "@/lib/db/schema";
import {
  AUTH_CODE_TTL_SEC,
  generateOpaqueToken,
  hashSecret,
  OAUTH_CODE_PREFIX,
  verifyPkce,
  type AnyOAuthScope,
  scopesToString,
} from "@/lib/oauth/constants";

export async function createAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: AnyOAuthScope[];
  codeChallenge: string;
  codeChallengeMethod: string;
}): Promise<string> {
  const rawCode = generateOpaqueToken(OAUTH_CODE_PREFIX);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000);

  await db.insert(oauthAuthorizationCodes).values({
    codeHash: hashSecret(rawCode),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scope: scopesToString(input.scopes),
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    expiresAt,
  });

  return rawCode;
}

/**
 * Redeem an authorization code. Exactly once, even under concurrency.
 *
 * The claim is a single conditional UPDATE: `usedAt IS NULL` is part of the
 * write, so Postgres row-locks the candidate and the loser of a race gets zero
 * rows back. A SELECT-then-UPDATE here let two simultaneous token requests both
 * observe an unused code and both mint an access token from it — an intercepted
 * code could be replayed alongside the legitimate exchange.
 *
 * The code is burned BEFORE PKCE is checked, deliberately: a failed verifier
 * means the redeemer could not prove it started the flow, and per RFC 6819 §4.4.1
 * the safe response is to invalidate the code rather than leave it usable.
 */
export async function consumeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const codeHash = hashSecret(input.code);
  const [row] = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        eq(oauthAuthorizationCodes.clientId, input.clientId),
        eq(oauthAuthorizationCodes.redirectUri, input.redirectUri),
        isNull(oauthAuthorizationCodes.usedAt),
        gt(oauthAuthorizationCodes.expiresAt, new Date())
      )
    )
    .returning();

  if (!row) return null;

  if (!verifyPkce(input.codeVerifier, row.codeChallenge, row.codeChallengeMethod)) {
    return null;
  }

  return row;
}

export async function findAuthorizationCodeByRaw(code: string) {
  const codeHash = hashSecret(code);
  const [row] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1);
  return row ?? null;
}
