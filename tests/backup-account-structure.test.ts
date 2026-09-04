/**
 * §16.1's structural guarantees: four properties held across the whole source tree.
 *
 * These are not tests of behaviour. Each one is a promise that no *future* file breaks a rule
 * the design depends on, in the manner of `tests/csrf-coverage.test.ts` — the kind of promise a
 * per-function test cannot make, because the way it gets broken is by code that does not exist
 * yet. Four rules:
 *
 *   1. **No secret can reach a log.** A `console.*` or `logActivity` call may not be handed a
 *      DEK, a wrapping key, a recovery phrase, a master key, or archive plaintext.
 *   2. **`ownerId` never comes from the client.** The authenticated caller is the only source of
 *      scope; a route that read an id from a body would put every account's data one parameter
 *      away.
 *   3. **Every path a restore writes goes through the name validator.** `materializedPath` is
 *      assembled from segments `checkEntityName` has already passed.
 *   4. **Removing the account's old rows never precedes the import.** The only statements that
 *      touch pre-existing rows live in the two stage-5 commit modules, which are excluded here
 *      by name so that the exemption has to be deliberate and shows up in a diff.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §16.1.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

interface SourceFile {
  /** Repo-relative, forward slashes, so a failure message is a path you can click. */
  path: string;
  /** Comments removed: every rule below is about code, and the comments discuss the rules. */
  code: string;
}

/** Strips block and line comments without touching a `://` inside a string. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    out.push({
      path: relative(ROOT, full).split(sep).join("/"),
      code: stripComments(readFileSync(full, "utf8")),
    });
  }
  return out;
}

const BACKUP_SOURCES = [
  ...walk(join(ROOT, "src", "features", "backup")),
  ...walk(join(ROOT, "app", "api", "backup")),
  ...walk(join(ROOT, "app", "backup")),
];

const ROUTES = BACKUP_SOURCES.filter((file) => file.path.endsWith("/route.ts"));

/** Every call to `name(` in `code`, as the text between its balanced parentheses. */
function callArguments(code: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  while (true) {
    const at = code.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    let cursor = at + needle.length - 1;
    for (; cursor < code.length; cursor += 1) {
      if (code[cursor] === "(") depth += 1;
      else if (code[cursor] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(at + needle.length, cursor));
    from = cursor + 1;
  }
}

/* ── 1. no secret can reach a log ─────────────────────────────────────────── */

/** Sinks that end up somewhere a human can read: stdout, or `activity_logs`. */
const LOG_SINKS = [
  "console.log",
  "console.info",
  "console.warn",
  "console.error",
  "console.debug",
  "console.trace",
  "logActivity",
];

/**
 * Names that must never be an argument to one of those.
 *
 * Spelled as an explicit list because the alternative — "anything that looks secret" — is a
 * judgement call, and a judgement call in a structural test is a test that gets edited rather
 * than obeyed. Matched on identifier boundaries, so `phraseSalt` and `phraseWords` (a count,
 * and public) are not caught by `phrase`.
 */
const FORBIDDEN_IN_LOGS = [
  "dek",
  "rwk",
  "phrase",
  "masterKey",
  "plaintext",
  "wrappingKey",
  "recoveryKey",
  "secret",
];

/**
 * The one expression that names a forbidden identifier and is nevertheless safe to log.
 *
 * `keyId` is the rotation label §3.3 requires in the audit row — a public name like `k2`, never
 * bytes. Written as the exact accessor rather than as an exemption for the whole file, so
 * logging `keys.masterKey` itself still fails, and so the list of holes is one line long.
 */
const PUBLIC_ACCESSORS = [/\bmasterKey\s*\.\s*keyId\b/g];

/** Removes those, so the ban below can be blunt about everything that is left. */
function withoutPublicAccessors(args: string): string {
  return PUBLIC_ACCESSORS.reduce((text, accessor) => text.replace(accessor, "«public»"), args);
}

describe("no secret can reach a log", () => {
  it("scanned a tree that actually has backup source in it", () => {
    // A walker pointed at the wrong directory passes every rule below by finding nothing.
    expect(BACKUP_SOURCES.length).toBeGreaterThan(30);
    // Exactly the five per-account endpoints of §10 and no more, which is a property
    // `tests/backup-account-guard.test.ts` states as a list and this one states as a count.
    expect(ROUTES.length).toBe(5);
    expect(BACKUP_SOURCES.some((file) => file.path.endsWith("/domain/keys.ts"))).toBe(true);
  });

  it("found the log calls it is checking", () => {
    // Otherwise the rule is vacuous: no sinks found, nothing forbidden, green.
    const calls = BACKUP_SOURCES.flatMap((file) =>
      LOG_SINKS.flatMap((sink) => callArguments(file.code, sink))
    );

    expect(calls.length).toBeGreaterThan(5);
  });

  it("hands no key, phrase or plaintext to console or the audit log", () => {
    const leaks: string[] = [];

    for (const file of BACKUP_SOURCES) {
      for (const sink of LOG_SINKS) {
        for (const args of callArguments(file.code, sink)) {
          const scrubbed = withoutPublicAccessors(args);
          for (const name of FORBIDDEN_IN_LOGS) {
            if (new RegExp(`\\b${name}\\b`).test(scrubbed)) {
              leaks.push(`${file.path}: ${sink}(… ${name} …)`);
            }
          }
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  it("would still catch the key object the one exemption is carved out of", () => {
    // The scrub is a hole in the ban, so it gets its own proof that it is exactly one accessor
    // wide: `keys.masterKey.keyId` passes, and `keys.masterKey` — whose `.key` is 32 secret
    // bytes — does not.
    expect(withoutPublicAccessors("{ keyId: keys.masterKey.keyId }")).not.toMatch(/\bmasterKey\b/);
    expect(withoutPublicAccessors("{ ring: keys.masterKey }")).toMatch(/\bmasterKey\b/);
    expect(withoutPublicAccessors("{ k: keys.masterKey.key }")).toMatch(/\bmasterKey\b/);
  });

  it("keeps the ban narrow enough to be honest about what it allows", () => {
    // The count and the mode that *are* logged share a prefix with the names above, and the ban
    // must not be the reason they are absent — a rule that also forbade the safe spelling would
    // get relaxed the first time somebody needed one. `words` is nine, and `phraseMode` says
    // which scheme sealed keyslot 1; neither is a secret and both must survive the scan.
    const prepare = BACKUP_SOURCES.find((file) =>
      file.path.endsWith("app/api/backup/takeout/prepare/route.ts")
    );
    const download = BACKUP_SOURCES.find((file) =>
      file.path.endsWith("app/api/backup/takeout/[ticket]/route.ts")
    );

    expect(prepare).toBeDefined();
    expect(prepare!.code).toMatch(/words: recovery\.words/);
    expect(download).toBeDefined();
    expect(download!.code).toMatch(/phraseMode: "per_file"/);
  });

  it("logs the rotation label the exemption exists for", () => {
    // If this ever stops being true, `PUBLIC_ACCESSORS` should shrink back to nothing rather
    // than sit there permitting a name no code needs.
    const download = BACKUP_SOURCES.find((file) =>
      file.path.endsWith("app/api/backup/takeout/[ticket]/route.ts")
    );

    expect(download).toBeDefined();
    expect(download!.code).toMatch(/keyId: keys\.masterKey\.keyId/);
  });
});

/* ── 2. ownerId never comes from the client ───────────────────────────────── */

describe("the owner is the authenticated caller, never a request field", () => {
  it("names no ownerId anywhere in a backup route", () => {
    // There is no such parameter, and the way to keep it that way is for the word itself to be
    // absent: a route cannot forget to validate a field it has no name for.
    const offenders = ROUTES.filter((file) => /\bownerId\b|\baccountId\b/.test(file.code));

    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("reads no user id out of a body, a query string, or a header", () => {
    const offenders: string[] = [];

    for (const file of ROUTES) {
      for (const pattern of [
        /searchParams\.get\(\s*["'](?:userId|user_id|ownerId|owner|accountId)["']/,
        /headers\.get\(\s*["'][^"']*(?:user|owner|account)-id["']/i,
        /\b(?:userId|ownerId|targetUserId)\s*[:=]\s*(?!user\.id\b)(?:body|json|parsed|input|raw|params|query)\b/,
      ]) {
        if (pattern.test(file.code)) offenders.push(`${file.path}: ${pattern.source}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("takes every id it sends onward from the session object", () => {
    // The positive half: wherever a route *does* name a `userId`, the value is the session's.
    for (const file of ROUTES) {
      for (const line of file.code.split("\n")) {
        if (!/\buserId\s*:/.test(line)) continue;
        expect(line, `${file.path}: ${line.trim()}`).toMatch(
          /userId\s*:\s*(?:user|actor|who|holder)\.(?:id|userId)\b|userId\s*:\s*string\b|userId\s*:\s*z\./
        );
      }
    }
  });

  it("passes the feature two fields, which is the reason none of this can be forged", () => {
    const guard = BACKUP_SOURCES.find((file) => file.path.endsWith("app/api/backup/_guard.ts"));

    expect(guard).toBeDefined();
    expect(guard!.code).toMatch(/requester:\s*\{\s*id:\s*user\.id,\s*role:\s*user\.role\s*\}/);
  });
});

/* ── 3. every path a restore writes goes through the validator ────────────── */

/** The validator, and the module that owns segment-by-segment parsing of an archive path. */
const VALIDATOR = "checkEntityName";
const PATH_PARSER = "src/features/backup/account/domain/index-entries.ts";

describe("no archive path becomes a row without the name validator", () => {
  it("parses archive paths in one module, and validates every segment there", () => {
    const parser = BACKUP_SOURCES.find((file) => file.path === PATH_PARSER);

    expect(parser, PATH_PARSER).toBeDefined();
    expect(parser!.code).toContain(`import { ${VALIDATOR} }`);
    expect(parser!.code).toMatch(new RegExp(`${VALIDATOR}\\(segment\\)`));
  });

  it("validates the name a collision renames a file to, not only the one in the archive", () => {
    // `report (restored 2).pdf` is a name this app generated, but it is generated *from* an
    // archive's bytes, and a 200-character stem plus a suffix is a name the DB column refuses.
    const importer = BACKUP_SOURCES.find((file) =>
      file.path.endsWith("account/application/import-files.ts")
    );

    expect(importer).toBeDefined();
    expect(importer!.code).toContain(`import { ${VALIDATOR}, ENTITY_NAME_MAX }`);
    expect(importer!.code).toMatch(new RegExp(`${VALIDATOR}\\(candidate\\)`));
  });

  it("writes materializedPath only where the validator has already run", () => {
    // Assembling the column anywhere else means assembling it from something that did not go
    // through §11's segment check — which is how `..` reaches a path in the first place.
    const writers = BACKUP_SOURCES.filter(
      (file) => /materializedPath\s*:\s*[`'"]/.test(file.code) && !file.path.includes("/domain/")
    );

    expect(writers.map((file) => file.path)).toEqual([
      "src/features/backup/account/application/import-files.ts",
    ]);
    for (const writer of writers) {
      expect(writer.code, writer.path).toContain(VALIDATOR);
    }
  });

  it("builds the path from a joiner rather than from string addition", () => {
    const parser = BACKUP_SOURCES.find((file) => file.path === PATH_PARSER);

    // `joinArchivePath` is the one place a `/` is put between two segments, so there is one
    // place to look when asking whether a path can contain an empty or ambiguous segment.
    expect(parser!.code).toMatch(/export function joinArchivePath/);
  });
});

/* ── 4. removing the account's old rows never precedes the import ─────────── */

/**
 * The two stage-5 modules, written out by name.
 *
 * The spec's wording: the exemption "has to be deliberate and shows up in a diff". A test that
 * exempted every file matching `commit-*.ts` would silently exempt a third commit module that
 * nobody reviewed; two literal paths cannot.
 */
const COMMIT_MODULES = [
  "src/features/backup/account/infrastructure/commit-brain.ts",
  "src/features/backup/account/infrastructure/commit-files.ts",
];

/**
 * Files that delete rows without deleting anything the account can see, and why.
 *
 * `ledger.ts` releases `restore_reservations` — a quota row that belongs to the batch, not to
 * the user's data. `restore-sweep-store.ts` collects rows the account never saw: they were born
 * with `deleted_at` set, and every delete it issues is keyed on `restore_batch_id`.
 */
const BOOKKEEPING = [
  "src/features/backup/account/infrastructure/ledger.ts",
  "src/features/backup/account/infrastructure/restore-sweep-store.ts",
];

/** The per-account feature. `src/features/backup/infrastructure/` is the admin one (§1). */
const ACCOUNT_TREE = BACKUP_SOURCES.filter(
  (file) =>
    file.path.startsWith("src/features/backup/account/") ||
    file.path.startsWith("app/api/backup/") ||
    file.path.startsWith("app/backup/")
);

describe("nothing is removed before the import has finished", () => {
  it("still finds both commit modules under the names it exempts", () => {
    // A rename that this list did not follow would turn the exemption into a blanket pass.
    for (const path of [...COMMIT_MODULES, ...BOOKKEEPING]) {
      expect(
        BACKUP_SOURCES.some((file) => file.path === path),
        `${path} was moved or renamed; update this test rather than the glob`
      ).toBe(true);
    }
    expect(ACCOUNT_TREE.length).toBeGreaterThan(30);
  });

  it("issues a hard DELETE in exactly three files, all of them named above", () => {
    // `commit-files.ts` is not among them: Files soft-deletes, so the Recycle Bin can undo a
    // "Ganti total" for the length of the retention window (§7.4). Brain has no bin, so its
    // commit is the one place in the feature a row leaves the database for good.
    const deleters = ACCOUNT_TREE.filter(
      (file) => callArguments(file.code, ".delete").length > 0
    ).map((file) => file.path);

    expect(deleters.sort()).toEqual(
      [
        "src/features/backup/account/infrastructure/commit-brain.ts",
        ...BOOKKEEPING,
      ].sort()
    );
  });

  it("writes no raw DELETE and no raw SET deleted_at anywhere", () => {
    // Both importers use drizzle, and `brain-sink.ts` is the one module that reaches for a raw
    // `UPDATE`. A hand-written statement is where a `WHERE user_id` gets forgotten.
    for (const file of ACCOUNT_TREE) {
      expect(file.code, file.path).not.toMatch(/DELETE\s+FROM/i);
      expect(file.code, file.path).not.toMatch(/SET\s+deleted_at/i);
    }
  });

  it("sets deleted_at through drizzle only inside commit-files", () => {
    const setters = ACCOUNT_TREE.filter((file) =>
      /\.set\(\s*\{[^}]*\bdeletedAt\b/.test(file.code)
    ).map((file) => file.path);

    expect(setters).toEqual(["src/features/backup/account/infrastructure/commit-files.ts"]);
  });

  it("keeps the sink's deleted_at an INSERT value, never an UPDATE", () => {
    // §16.1 warns that a naive `deleted_at = NOW()` grep flags this file. It is the opposite of
    // a delete: the two columns that make a *new* row invisible until stage 5 clears them.
    const sink = ACCOUNT_TREE.find((file) => file.path.endsWith("infrastructure/files-sink.ts"));

    expect(sink).toBeDefined();
    expect(sink!.code).toContain("const staged = () => ({ deletedAt: new Date(), restoreBatchId })");
    for (const line of sink!.code.split("\n")) {
      if (!/\bdeletedAt\b/.test(line)) continue;
      // Either a read filter, or the factory itself. Nothing else may name the column here.
      expect(line, `files-sink.ts: ${line.trim()}`).toMatch(/isNull\(|const staged = \(\) =>/);
    }
  });
});

describe("the deletes that do exist are the ones the design allows", () => {
  /** Source of one file in the account tree, comments already stripped. */
  function code(suffix: string): string {
    const file = ACCOUNT_TREE.find((entry) => entry.path.endsWith(suffix));
    expect(file, suffix).toBeDefined();
    return file!.code;
  }

  it("lets the ledger delete reservations and nothing else", () => {
    const targets = callArguments(code("infrastructure/ledger.ts"), ".delete").map((argument) =>
      argument.trim()
    );

    expect(targets.length).toBeGreaterThan(0);
    expect([...new Set(targets)]).toEqual(["restoreReservations"]);
  });

  it("keys every delete the sweeper issues on one batch", () => {
    const sweeper = code("infrastructure/restore-sweep-store.ts");
    const statements: string[] = [];

    for (let at = sweeper.indexOf(".delete("); at !== -1; at = sweeper.indexOf(".delete(", at + 1)) {
      statements.push(sweeper.slice(at, at + 500));
    }

    expect(statements.length).toBe(3);
    for (const statement of statements) {
      // Without this the sweeper would be a second delete path over the account's own rows.
      expect(statement.includes("restoreBatchId"), statement.slice(0, 60)).toBe(true);
    }
  });

  it("spares the rows the batch just wrote", () => {
    // `restore_batch_id IS NULL` is the entire reason a `replace` cannot delete its own import.
    const commit = code("infrastructure/commit-files.ts");

    expect(commit).toContain("isNull(files.restoreBatchId)");
    expect(commit).toContain("isNull(folders.restoreBatchId)");
  });

  it("calls both commits only after the import body has returned", () => {
    const sessions = code("infrastructure/sessions.ts");

    for (const [imported, committed] of [
      ["body(drizzleFilesSink", "swapFilesBatch({"],
      ["body(drizzleBrainSink", "deleteOldBrainRows({"],
    ]) {
      const importAt = sessions.indexOf(imported);
      const commitAt = sessions.indexOf(committed);

      expect(importAt, imported).toBeGreaterThan(-1);
      expect(commitAt, committed).toBeGreaterThan(-1);
      expect(importAt, `${committed} must follow ${imported}`).toBeLessThan(commitAt);
    }
  });

  it("runs the five stages in the order §7.3 fixes", () => {
    const orchestrator = code("application/import.ts");
    const order = ["assertOwnership(", "ledger.reserve(", "runStaged(", "ledger.settle("];
    const offsets = order.map((step) => orchestrator.indexOf(step));

    expect(offsets.every((offset) => offset > -1), order.join(" → ")).toBe(true);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });
});






