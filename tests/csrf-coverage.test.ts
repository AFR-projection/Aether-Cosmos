import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every cookie-authenticated mutating route must carry a CSRF gate.
 *
 * `/api/auth/impersonate`, `/api/admin/email/senders`, `/api/admin/email/verify`
 * and `/api/admin/monitoring` shipped without one: they authorized with
 * `requireMaster` / `requireMasterOrApiKey`, which reads the session cookie the
 * browser attaches automatically, so a cross-site POST from a page the master
 * happened to visit could start an impersonation session or rotate the Gmail
 * sender credentials. `SameSite=Strict` on the session cookie meant it was not
 * trivially exploitable, but "another control happens to cover this" is not the
 * same as having the control.
 *
 * Structural, not behavioural, on purpose: the guarantee worth pinning is that
 * NO future route forgets the gate, and that only the deliberate exemptions
 * below skip it — each of which has to state why.
 */

const ROOT = join(__dirname, "..");
const MUTATING = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/;

function routeFiles(dir: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith("route.ts")) {
        out.push({
          path: relative(ROOT, full).split(sep).join("/"),
          source: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Routes that legitimately have no CSRF check. A double-submit token requires a
 * cookie the caller can read, which none of these have — they are authenticated
 * by something the browser does NOT attach on its own.
 */
const CSRF_EXEMPT = new Map<string, string>([
  [
    "app/api/auth/login/route.ts",
    "Pre-session: POST is unauthenticated, DELETE only destroys the caller's own session.",
  ],
  [
    "app/api/auth/step-code/enroll/route.ts",
    "Pre-session, authenticated by the HMAC-signed staged token, not by a cookie.",
  ],
  [
    "app/api/brain/mcp/route.ts",
    "Bearer-only MCP transport; no cookie is consulted, and proxy.ts routes its 401 itself.",
  ],
  [
    "app/api/oauth/register/route.ts",
    "RFC 7591 dynamic client registration — unauthenticated by specification.",
  ],
  [
    "app/api/oauth/token/route.ts",
    "RFC 6749 token endpoint: credentials are in the body, cookies are never read.",
  ],
  [
    "app/api/shared/[token]/route.ts",
    "Capability URL — the token in the path IS the credential; there is no ambient session to forge.",
  ],
]);

const routes = routeFiles(join(ROOT, "app", "api"));

describe("CSRF coverage across mutating API routes", () => {
  it("found the route tree", () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it("every mutating route either validates CSRF or is a documented exemption", () => {
    const missing = routes
      .filter(({ source }) => MUTATING.test(source))
      .filter(({ path, source }) => !source.includes("validateCsrf") && !CSRF_EXEMPT.has(path))
      .map(({ path }) => path);

    expect(missing).toEqual([]);
  });

  it("gates CSRF before any authorization or body work in the routes that regressed", () => {
    const regressed = [
      "app/api/auth/impersonate/route.ts",
      "app/api/admin/email/senders/route.ts",
      "app/api/admin/email/verify/route.ts",
      "app/api/admin/monitoring/route.ts",
    ];

    for (const path of regressed) {
      const route = routes.find((r) => r.path === path);
      expect(route, path).toBeDefined();
      const source = route!.source;

      // One gate per mutating handler, and it must come first inside the try.
      const handlers = source.match(MUTATING) ? source.split(/export\s+async\s+function\s+/) : [];
      for (const chunk of handlers) {
        if (!/^(POST|PUT|PATCH|DELETE)\s*\(/.test(chunk)) continue;
        expect(chunk, `${path} ${chunk.slice(0, 12)}`).toContain("validateCsrf");
        const csrfAt = chunk.indexOf("validateCsrf");
        const authAt = chunk.search(/require(Master|Auth|MasterOrApiKey)/);
        const bodyAt = chunk.indexOf("request.json()");
        if (authAt >= 0) expect(csrfAt, `${path}: CSRF must precede auth`).toBeLessThan(authAt);
        if (bodyAt >= 0) expect(csrfAt, `${path}: CSRF must precede body parse`).toBeLessThan(bodyAt);
      }
    }
  });

  it("keeps the exemption list honest — no stale entries", () => {
    for (const path of CSRF_EXEMPT.keys()) {
      const route = routes.find((r) => r.path === path);
      expect(route, `${path} is exempted but no longer exists`).toBeDefined();
      expect(MUTATING.test(route!.source), `${path} no longer mutates`).toBe(true);
    }
  });
});
