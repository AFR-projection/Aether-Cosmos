/**
 * Runtime environment helpers — cookie security follows actual public URL (HTTPS),
 * not blindly NODE_ENV=production (avoids broken login on HTTP deploys).
 */
export function appPublicUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_PUBLIC_URL ?? "")
    .trim()
    .replace(/\/$/, "");
}

export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "0.0.0.0" || h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

/**
 * Public origin for OAuth redirects & discovery — never 0.0.0.0 (Docker bind address).
 * Priority: env URL → forwarded headers → request origin (if public).
 */
export function resolvePublicOrigin(request?: Request): string {
  const envUrl = appPublicUrl();
  if (envUrl) {
    try {
      if (!isInternalHostname(new URL(envUrl).hostname)) return envUrl;
    } catch {
      /* fall through */
    }
  }

  if (request) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (request.url.startsWith("https") ? "https" : "http");
    const host =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host")?.split(",")[0]?.trim();

    if (host) {
      const hostname = host.split(":")[0];
      if (!isInternalHostname(hostname)) {
        return `${proto}://${host}`.replace(/\/$/, "");
      }
    }

    try {
      const origin = new URL(request.url).origin;
      if (!isInternalHostname(new URL(origin).hostname)) return origin;
    } catch {
      /* fall through */
    }
  }

  if (envUrl) return envUrl;
  // Last resort: nothing in the env, no usable request headers. It must be a
  // host this deployment actually controls, never a leftover domain — this
  // value ends up in the OAuth discovery documents and in authorize redirects,
  // so a stale hostname here hands users off to somewhere else entirely.
  // Same default as `oauthBaseUrl` in lib/oauth/constants.ts.
  return "http://localhost:3000";
}

export function isHttpsPublicUrl(): boolean {
  return appPublicUrl().startsWith("https://");
}

/** Whether session/CSRF cookies should set the Secure flag. */
export function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  return isHttpsPublicUrl();
}

/** Apply HSTS only when the app is served over HTTPS. */
export function hstsEnabled(): boolean {
  if (process.env.HSTS_ENABLED === "false") return false;
  if (process.env.HSTS_ENABLED === "true") return true;
  return isHttpsPublicUrl();
}
