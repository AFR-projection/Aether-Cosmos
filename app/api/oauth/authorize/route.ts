import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/shared/lib/auth/session";
import { resolvePublicOrigin } from "@/shared/lib/env/runtime";
import { validateOAuthClientRedirect } from "@/shared/lib/auth/oauth/clients";
import { parseScopes } from "@/shared/lib/auth/oauth/constants";
import { oauthError } from "@/shared/lib/auth/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const scope = params.get("scope");
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method") ?? "S256";

  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!clientId || !redirectUri || !codeChallenge) {
    return oauthError("invalid_request", "client_id, redirect_uri, and code_challenge are required");
  }
  if (codeChallengeMethod !== "S256") {
    return oauthError("invalid_request", "Only S256 PKCE is supported");
  }

  const clientCheck = await validateOAuthClientRedirect(clientId, redirectUri);
  if (!clientCheck.ok) {
    return oauthError(clientCheck.error, undefined, 400);
  }

  parseScopes(scope);

  const publicOrigin = resolvePublicOrigin(request);
  const session = await getSessionUser();
  const consentParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scope ?? "read",
    state: state ?? "",
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  });
  if (clientCheck.client.clientName) {
    consentParams.set("client_name", clientCheck.client.clientName);
  }

  if (!session) {
    const loginNext = `/oauth/consent?${consentParams.toString()}`;
    const loginUrl = new URL("/login", publicOrigin);
    loginUrl.searchParams.set("next", loginNext);
    return NextResponse.redirect(loginUrl);
  }

  const consentUrl = new URL("/oauth/consent", publicOrigin);
  consentParams.forEach((v, k) => consentUrl.searchParams.set(k, v));
  return NextResponse.redirect(consentUrl);
}
