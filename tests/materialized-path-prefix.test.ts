import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { escapeLike, escapeRegex } from "@/shared/lib/utils";

/**
 * A folder tree stored as `materialized_path`, and the two ways a prefix match on
 * it went wrong.
 *
 * Every subtree operation — rename, move, trash, restore, purge, ZIP export, the
 * paste walk, the background purge — selects the rows whose path starts with the
 * folder's own path. That prefix used to be built with `escapeRegex` and matched
 * with `ILIKE`, and both halves were wrong:
 *
 *   - `escapeRegex` escapes regex metacharacters, which leaves `%` and `_` — the
 *     only two LIKE cares about — untouched. A folder literally named `%` produced
 *     the pattern `/%/%`, so trashing it reached every path in the account.
 *   - `ILIKE` case-folds the prefix, so an owner with both `Docs` and `docs` at the
 *     root had one subtree rewritten by the other's rename.
 *
 * Half of this file is behavioural (what the helpers do) and half is structural
 * (that no query site went back to the old spelling), because the guarantee worth
 * pinning covers every prefix query in the tree, not one route's code path.
 */

/** Minimal model of PostgreSQL `LIKE`, whose default escape character is `\`. */
function likeMatches(
  pattern: string,
  value: string,
  { caseInsensitive = false }: { caseInsensitive?: boolean } = {}
): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === "\\") {
      source += escapeRegex(pattern[++i] ?? "\\");
    } else if (character === "%") {
      source += "[\\s\\S]*";
    } else if (character === "_") {
      source += "[\\s\\S]";
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "").test(value);
}

describe("escapeLike neutralises what LIKE treats as a wildcard", () => {
  it("escapes both wildcards and the escape character itself", () => {
    expect(escapeLike("%")).toBe("\\%");
    expect(escapeLike("_")).toBe("\\_");
    expect(escapeLike("\\")).toBe("\\\\");
  });

  it("leaves an ordinary folder name untouched", () => {
    expect(escapeLike("Quarterly Report 2026")).toBe("Quarterly Report 2026");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeLike("100%_of_50%")).toBe("100\\%\\_of\\_50\\%");
  });
});

describe("escapeRegex is not a substitute for it", () => {
  it("leaves both LIKE wildcards exactly as they came in", () => {
    expect(escapeRegex("%")).toBe("%");
    expect(escapeRegex("_")).toBe("_");
  });

  it("stops a folder named % from swallowing its siblings", () => {
    const wildcard = "/%/";
    const sibling = "/Payroll/2026/";

    // The bug: `/%/%` reads as "slash, anything, slash, anything".
    expect(likeMatches(`${escapeRegex(wildcard)}%`, sibling)).toBe(true);
    // The fix: `%` is a literal path segment again.
    expect(likeMatches(`${escapeLike(wildcard)}%`, sibling)).toBe(false);
    // ...and the folder's own subtree still matches, which is the point.
    expect(likeMatches(`${escapeLike(wildcard)}%`, "/%/Deep/")).toBe(true);
  });

  it("stops `_` from matching a same-shaped sibling", () => {
    expect(likeMatches(`${escapeRegex("/_/")}%`, "/a/b/")).toBe(true);
    expect(likeMatches(`${escapeLike("/_/")}%`, "/a/b/")).toBe(false);
  });
});

describe("the prefix is matched case-sensitively", () => {
  it("keeps a case-variant sibling out of the subtree", () => {
    expect(likeMatches("/docs/%", "/Docs/Q1/")).toBe(false);
    // What ILIKE did: `Docs` and `docs` are two folders with two subtrees, and a
    // rename of one rewrote the other's descendants.
    expect(likeMatches("/docs/%", "/Docs/Q1/", { caseInsensitive: true })).toBe(true);
  });
});

const ROOT = join(__dirname, "..");
const PATH_COLUMN = /materiali[sz]ed_?path/i;
const ANY_LIKE = /\bi?like\b/i;
const CASE_FOLDED = /\bilike\b/i;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
/** `escapeLike(...)`, or the same replace inlined where importing it is not worth it. */
const ESCAPES_WILDCARDS = /escapeLike\s*\(|\[\\\\%_\]/;

type SourceFile = { path: string; source: string };

function sourceFiles(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
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

/** Lines that actually run a prefix match against the path column. */
function prefixQueryLines({ source }: SourceFile): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => PATH_COLUMN.test(line) && ANY_LIKE.test(line) && !COMMENT_LINE.test(line));
}

const files = ["app", "src", "workers"].flatMap((dir) => sourceFiles(join(ROOT, dir)));
const prefixQuerySites = files.filter((file) => prefixQueryLines(file).length > 0);

/**
 * Every place that selects a subtree by path prefix, and why it needs to. A new
 * entry is a new place the two bugs above can come back, so it has to be added
 * deliberately rather than discovered by the next person to read a query plan.
 */
const EXPECTED_SITES = new Map<string, string>([
  [
    "app/api/folders/route.ts",
    "Rename, move, trash, restore and purge rewrite or select one folder's subtree.",
  ],
  ["app/api/folders/batch/route.ts", "The same subtree work for a multi-selection."],
  [
    "app/api/files/paste/route.ts",
    "Walks the source subtree to copy or move it, then rewrites descendant paths.",
  ],
  ["app/api/folders/[id]/download/route.ts", "Collects the subtree a ZIP export walks."],
  [
    "src/features/files/infrastructure/storage/deletion-service.ts",
    "Queues a large subtree purge; keeps a local copy of the escape.",
  ],
  [
    "workers/index.ts",
    "Finishes that purge, and inlines the escape rather than importing a UI utility.",
  ],
]);

describe("every materialized_path prefix query escapes LIKE wildcards", () => {
  it("scanned the source tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("knows every site that prefix-matches a path", () => {
    expect(prefixQuerySites.map((file) => file.path).sort()).toEqual(
      [...EXPECTED_SITES.keys()].sort()
    );
  });

  it("escapes the folder path before appending the wildcard", () => {
    for (const file of prefixQuerySites) {
      expect(ESCAPES_WILDCARDS.test(file.source), file.path).toBe(true);
    }
  });

  it("never matches the prefix case-insensitively", () => {
    for (const file of prefixQuerySites) {
      expect(prefixQueryLines(file).filter((line) => CASE_FOLDED.test(line)), file.path).toEqual([]);
    }
  });

  it("never reaches for escapeRegex", () => {
    for (const file of prefixQuerySites) {
      expect(/escapeRegex\s*\(/.test(file.source), file.path).toBe(false);
    }
  });
});

describe("the wildcard is appended after escaping, never escaped along with the value", () => {
  it("hands escapeLike the path only, never a pattern that already holds a %", () => {
    // `escapeLike(`${path}%`)` escapes the trailing wildcard too, and the query then
    // matches only a path that literally ends in "%": a silent no-op instead of a
    // subtree. The wildcard belongs outside the call.
    const wrong = files
      .filter((file) => /escapeLike\(\s*`[^`]*%/.test(file.source))
      .map((file) => file.path);

    expect(wrong).toEqual([]);
  });
});

describe("the share lookup uses a prefix function instead of LIKE", () => {
  it("asks Postgres for starts_with, so no character in a name is special", () => {
    const permissions = files.find((file) => file.path === "src/shared/lib/auth/permissions.ts");

    expect(permissions).toBeDefined();
    // Nearest-ancestor membership walks the same paths, but a folder named `%` or
    // `_` cannot widen the search when there is no pattern language to abuse.
    expect(permissions!.source).toContain("starts_with(");
    expect(prefixQueryLines(permissions!)).toEqual([]);
  });
});
