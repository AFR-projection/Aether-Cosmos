import { consumeAuthorizationCode } from "@/lib/oauth/codes";
import { getOAuthClient } from "@/lib/oauth/clients";
import { parseOAuthBody, oauthBodyErrorResponse, oauthError, oauthJson } from "@/lib/oauth/http";
import { issueTokens, refreshAccessToken } from "@/lib/oauth/tokens";
import { verifySecret } from "@/lib/oauth/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // The endpoint is unauthenticated, so the body is read through a byte ceiling; a
  // refusal is an OAuth error, not an unhandled throw.
  let body: Record<string, string>;
  try {
    body = await parseOAuthBody(request);
  } catch (e) {
    return oauthBodyErrorResponse(e) ?? oauthError("invalid_request", "Invalid request body", 400);
  }
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const clientId = body.client_id;
    const codeVerifier = body.code_verifier;
    const clientSecret = body.client_secret;

    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return oauthError("invalid_request", "code, redirect_uri, client_id, code_verifier required");
    }

    const client = await getOAuthClient(clientId);
    if (!client) return oauthError("invalid_client", undefined, 401);

    if (client.clientSecretHash) {
      if (!clientSecret || !verifySecret(clientSecret, client.clientSecretHash)) {
        return oauthError("invalid_client", undefined, 401);
      }
    }

    const authCode = await consumeAuthorizationCode({
      code,
      clientId,
      redirectUri,
      codeVerifier,
    });

    if (!authCode) {
      return oauthError("invalid_grant", "Invalid or expired authorization code", 400);
    }

    const tokens = await issueTokens({
      clientId,
      userId: authCode.userId,
      scope: authCode.scope,
    });

    return oauthJson(tokens, 200, { "Cache-Control": "no-store" });
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.refresh_token;
    const clientId = body.client_id;
    const clientSecret = body.client_secret;

    if (!refreshToken || !clientId) {
      return oauthError("invalid_request", "refresh_token and client_id required");
    }

    const client = await getOAuthClient(clientId);
    if (!client) return oauthError("invalid_client", undefined, 401);

    if (client.clientSecretHash) {
      if (!clientSecret || !verifySecret(clientSecret, client.clientSecretHash)) {
        return oauthError("invalid_client", undefined, 401);
      }
    }

    const tokens = await refreshAccessToken({ refreshToken, clientId });
    if (!tokens) {
      return oauthError("invalid_grant", "Invalid refresh token", 400);
    }

    return oauthJson(tokens, 200, { "Cache-Control": "no-store" });
  }

  return oauthError("unsupported_grant_type", `Grant type ${grantType} not supported`);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
