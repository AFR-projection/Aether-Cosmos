import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hstsEnabled } from "@/shared/lib/env/runtime";
import { isProgrammaticBearerRequest } from "@/shared/lib/auth/api-key";

const publicPaths = [
  "/",
  "/login",
  "/register",
  "/verify-email",
  "/maintenance",
  "/auth",
  "/shared",
  "/api/auth/login",
  // Pre-session enrollment is authenticated by the short-lived HMAC-signed
  // password-stage token inside the route, not by a session cookie.
  "/api/auth/step-code/enroll",
  "/api/auth/register",
  "/api/auth/register-email",
  "/api/auth/verify-otp",
  "/api/auth/resend-otp",
  "/api/auth/csrf",
  "/api/auth/maintenance",
  "/api/shared",
  "/oauth/consent",
];

const PUBLIC_API_PREFIXES = [
  "/api/oauth/",
  "/.well-known/",
];

/**
 * Route handlers perform their own auth.
 *
 * The Brain MCP endpoint must own its 401: MCP clients discover the auth scheme
 * from the WWW-Authenticate header on an unauthenticated call, and a CORS
 * preflight carries no Authorization header at all, so a proxy-level 401 would
 * make the endpoint unreachable from any browser-based MCP client.
 */
const HANDLER_AUTH_API_PREFIXES: string[] = ["/api/brain/mcp"];

/** Obvious automated scrapers — never block browsers or health checks on pages. */
const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /scrape/i,
  /python-requests/i, /go-http-client/i, /java\//i, /perl/i,
];

const SENSITIVE_API_PREFIXES = [
  "/api/admin",
  "/api/upload",
  "/api/files",
  "/api/folders",
  "/api/download",
  "/api/auth/sessions",
  "/api/auth/password",
];

function isPublicPath(pathname: string): boolean {
  if (publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  return PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function skipsProxyAuth(pathname: string): boolean {
  return HANDLER_AUTH_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isBot(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return BOT_PATTERNS.some((p) => p.test(userAgent));
}

function isSensitiveApi(pathname: string): boolean {
  return SENSITIVE_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = isPublicPath(pathname);

  if (isPublic || pathname.startsWith("/api/shared/")) {
    const response = NextResponse.next();
    applySecurityHeaders(response, request);
    return response;
  }

  const sessionCookie = request.cookies.get("storage_session");
  const hasApiKey = isProgrammaticBearerRequest(request);
  const ua = request.headers.get("user-agent");

  // Bot protection: sensitive API routes only (not pages, login, or CSRF)
  if (
    pathname.startsWith("/api/") &&
    isSensitiveApi(pathname) &&
    isBot(ua) &&
    !sessionCookie &&
    !hasApiKey
  ) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  if (!sessionCookie && !pathname.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Bearer sk_* / oat_* authenticate at the route layer — no session cookie required.
  if (!sessionCookie && pathname.startsWith("/api/") && !hasApiKey && !skipsProxyAuth(pathname)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const response = NextResponse.next();
  applySecurityHeaders(response, request);
  return response;
}

function applySecurityHeaders(response: NextResponse, request: NextRequest) {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()");
  if (hstsEnabled() || request.headers.get("x-forwarded-proto") === "https") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
  }
  response.headers.set("X-DNS-Prefetch-Control", "on");
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");
  response.headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
}

/**
 * Everything except static assets — and the one route whose body must not be cloned.
 *
 * Next buffers the request body of every path this matcher covers, because a proxy and the
 * route handler both have to be able to read it (`getCloneableBody` in
 * `next/dist/server/body-streams`). The buffer is capped — `experimental.proxyClientMaxBodySize`,
 * 10 MB by default — and going over it does **not** fail the request: it pushes EOF into the
 * copy the route receives and logs a warning. So `POST /api/backup/restore` saw a `.afrbak`
 * that ended at exactly 10 MB, failed its trailer check, and told the user their recovery
 * phrase was wrong. Raising the cap would only move the failure: that buffer is an in-memory
 * `Readable` with no backpressure, so a 40 GB archive would be 40 GB of RAM on a 2 GB VPS.
 *
 * The exclusion is safe because that route never depended on this function: it calls
 * `validateCsrf` and `requireBackupRequester` itself (so it owns its own 403/401), it is not in
 * `SENSITIVE_API_PREFIXES`, and the headers in `next.config.ts` still apply to it. `$` keeps the
 * exclusion to that exact path — `restore/inspect` reads a bounded 80 KiB prefix and stays here.
 *
 * Uploads of user files are unaffected either way: they are presigned straight to R2, so
 * `/api/backup/restore` is the only route in the app that streams a large body through Next.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/backup/restore/?$).*)"],
};
