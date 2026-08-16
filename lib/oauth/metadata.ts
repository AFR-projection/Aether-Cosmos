import { appPublicUrl, isInternalHostname } from "@/lib/env/runtime";
import { ALL_OAUTH_SCOPES, oauthBaseUrl } from "@/lib/oauth/constants";

export function getOAuthIssuer(fallbackOrigin?: string): string {
  const env = appPublicUrl();
  if (env) {
    try {
      if (!isInternalHostname(new URL(env).hostname)) return env;
    } catch {
      /* ignore */
    }
  }
  if (fallbackOrigin) {
    try {
      const origin = fallbackOrigin.replace(/\/$/, "");
      if (!isInternalHostname(new URL(origin).hostname)) return origin;
    } catch {
      /* ignore */
    }
  }
  return env || oauthBaseUrl(fallbackOrigin);
}

export function buildAuthorizationServerMetadata(fallbackOrigin?: string) {
  const base = getOAuthIssuer(fallbackOrigin);
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [...ALL_OAUTH_SCOPES],
  };
}

export function buildWwwAuthenticateHeader(fallbackOrigin?: string): string {
  const base = getOAuthIssuer(fallbackOrigin);
  return `Bearer realm="Storage ByAFR"`;
}
