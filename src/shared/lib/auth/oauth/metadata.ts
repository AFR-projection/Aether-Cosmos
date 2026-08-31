import { appPublicUrl, isInternalHostname } from "@/shared/lib/env/runtime";
import { ALL_OAUTH_SCOPES, oauthBaseUrl } from "@/shared/lib/auth/oauth/constants";
import { APP_NAME } from "@/shared/lib/app-version";

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

/**
 * RFC 9728 protected-resource metadata, served from
 * /.well-known/oauth-protected-resource.
 *
 * Restored after the MCP removal in 6973110 dropped it while leaving both
 * .well-known route handlers importing it — which broke `next build` outright
 * (tsc misses it because TypeScript's `**` globs skip dot-directories, so
 * app/.well-known is never type-checked). `resource` now points at this app's own
 * API root rather than the removed MCP endpoint.
 */
export function buildProtectedResourceMetadata(fallbackOrigin?: string) {
  const base = getOAuthIssuer(fallbackOrigin);
  return {
    resource: `${base}/api`,
    authorization_servers: [base],
    scopes_supported: [...ALL_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The `WWW-Authenticate` challenge for an unauthenticated API call.
 *
 * Takes no origin any more: the MCP removal in 6973110 dropped the
 * `resource_metadata="…"` parameter that was built from it, leaving the argument
 * dead. Nothing in the repo calls this today — the Brain MCP handler builds its
 * own challenge — so it is kept only as the canonical realm string.
 */
export function buildWwwAuthenticateHeader(): string {
  return `Bearer realm="${APP_NAME}"`;
}
