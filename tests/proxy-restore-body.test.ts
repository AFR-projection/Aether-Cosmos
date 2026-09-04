import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

/**
 * The proxy must not stand between `POST /api/backup/restore` and its upload.
 *
 * Next clones the request body of every path `proxy.ts`'s matcher covers, so that the proxy and
 * the route handler can each read it, and caps the clone at `experimental.proxyClientMaxBodySize`
 * — 10 MB when nothing configures it. Over the cap the request does not fail:
 * `getCloneableBody` pushes EOF into the copy the route receives and logs a warning to stdout.
 * So the restore route read a `.afrbak` that ended at exactly 10 MB, failed the trailer check
 * every archive ends with, and answered `AFRBAK_UNREADABLE` — "the recovery phrase is wrong, or
 * the file is corrupt". Both halves of that sentence were false, which is what made it expensive:
 * the file was intact and the phrase was right, and `restore/inspect` proved it by opening the
 * same archive seconds earlier from an 80 KiB prefix.
 *
 * Raising the cap is not the fix and must not become one. That buffer is an in-memory `Readable`
 * fed by `.push()` with no backpressure, so a 40 GB archive would be 40 GB of resident memory on
 * a 2 GB VPS. The fix is for the body to never be cloned: the route authenticates itself, so it
 * can sit outside the matcher and stream its upload 4 MiB at a time as it was written to.
 *
 * This suite pins that exclusion using Next's own matcher compiler rather than a regex of our
 * own, because the property under test is what Next does with the string — a `$` that stops
 * `restore/inspect` from being excluded too is not visible by reading the pattern.
 */

const ROOT = join(__dirname, "..");

/** Resolved against the repo root, so Next's internals load exactly as the server loads them. */
const nextRequire = createRequire(join(ROOT, "package.json"));

interface CompiledMatcher {
  regexp: string;
}

const { getMiddlewareMatchers } = nextRequire(
  "next/dist/build/analysis/get-page-static-info"
) as {
  getMiddlewareMatchers: (source: string[], config: unknown) => CompiledMatcher[];
};

const { getMiddlewareRouteMatcher } = nextRequire(
  "next/dist/shared/lib/router/utils/middleware-route-matcher"
) as {
  getMiddlewareRouteMatcher: (
    matchers: CompiledMatcher[]
  ) => (pathname: string, request: unknown, query: unknown) => unknown;
};

/**
 * A file's code, with its comments removed.
 *
 * Every assertion below is about what the source *does*, and each of these files discusses in
 * prose exactly the thing it must not do — `restore/route.ts` names `request.formData()` in the
 * paragraph explaining why it does not call it.
 */
function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The matcher as text, from the file the server reads.
 *
 * Not `import { config } from "../proxy"`: that module pulls in `api-key.ts` and therefore the
 * database client, and these tests run without one.
 */
function matcherSources(): string[] {
  const block = /matcher:\s*\[([^\]]*)\]/.exec(source("proxy.ts"));
  if (block === null) throw new Error("proxy.ts has no `matcher: [...]` to read");
  const entries = [...block[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  if (entries.length === 0) throw new Error("proxy.ts's matcher is empty");
  return entries;
}

const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(matcherSources(), nextConfig));

/** Whether the proxy — and so the body clone — runs for a pathname. */
function proxied(pathname: string): boolean {
  return Boolean(matches(pathname, { nextUrl: pathname, url: pathname, headers: {} }, {}));
}

describe("the upload path is outside the proxy", () => {
  it("does not proxy the route the archive is uploaded to", () => {
    expect(proxied("/api/backup/restore")).toBe(false);
    // Next redirects the trailing-slash form, but a 308 preserves the method: excluded too, so
    // the redirected POST cannot arrive on a path that clones its body.
    expect(proxied("/api/backup/restore/")).toBe(false);
  });

  it("excludes the exact URL the client posts the file to", () => {
    // Ties the exclusion to the upload rather than to a string: renaming the route breaks this.
    const opened = /xhr\.open\("POST",\s*"([^"]+)"\)/.exec(source("app/backup/_client.ts"));
    expect(opened).not.toBeNull();
    expect(proxied(opened![1]!)).toBe(false);
  });

  it("still proxies every other backup route", () => {
    // `restore/inspect` reads a bounded prefix — at most ~2 MiB — so the clone cannot truncate
    // it, and it keeps the proxy's auth. The `$` in the matcher is what separates the two.
    expect(proxied("/api/backup/restore/inspect")).toBe(true);
    expect(proxied("/api/backup/takeout/prepare")).toBe(true);
    expect(proxied("/api/backup/identity")).toBe(true);
  });

  it("leaves the rest of the app proxied", () => {
    for (const path of ["/backup", "/login", "/api/files", "/api/auth/csrf", "/admin/users"]) {
      expect(proxied(path)).toBe(true);
    }
  });

  it("keeps the static exclusions it already had", () => {
    expect(proxied("/_next/static/chunks/main.js")).toBe(false);
    expect(proxied("/_next/image")).toBe(false);
    expect(proxied("/favicon.ico")).toBe(false);
  });
});

describe("the route the exclusion protects still streams", () => {
  const code = source("app/api/backup/restore/route.ts");

  it("reads the upload as a stream", () => {
    expect(code).toMatch(/Readable\.fromWeb\(request\.body/);
  });

  it("never buffers it whole", () => {
    // The exclusion stops Next from buffering the archive; these would put it back, in this
    // process's heap instead of the proxy's.
    for (const buffering of ["request.formData(", "request.arrayBuffer(", "request.text("]) {
      expect(code).not.toContain(buffering);
    }
  });
});
