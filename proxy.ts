import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hstsEnabled } from "@/lib/env/runtime";
import { isProgrammaticBearerRequest } from "@/lib/auth/api-key";

const publicPaths = [
  "/",
  "/login",
  "/register",
  "/verify-email",
  "/maintenance",
  "/auth",
  "/shared",
  "/api/auth/login",
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

/** Route handlers perform their own auth (e.g. MCP OAuth WWW-Authenticate) */
const HANDLER_AUTH_API_PREFIXES = ["/api/mcp"];

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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
