import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyEnv, parseEnvFile } from "@/scripts/load-env";

/**
 * The operational scripts and the worker have to run on the SERVER, where `npm ci
 * --omit=dev` leaves no `dotenv` behind. Reaching the database must therefore not depend
 * on a devDependency — a process that crashes with MODULE_NOT_FOUND before its first line
 * is a deployment trap, and it has cost one backfill run and one worker container that
 * restart-looped through a whole deploy while every other service reported healthy.
 *
 * Two things are pinned here: the reader is dotenv-compatible for the syntax a real
 * `.env` uses (and never overwrites a variable the real environment already set), and no
 * script or worker regresses to importing `dotenv/config`.
 */

const ROOT = join(__dirname, "..");
const SCRIPTS = join(ROOT, "scripts");
const WORKERS = join(ROOT, "workers");

/**
 * A real import of dotenv — not the word inside a comment explaining why the file does not
 * import it. A plain substring check fails on its own explanation, which teaches the next
 * person to delete the comment instead of keeping the guarantee.
 */
const DOTENV_IMPORT =
  /import\s+["']dotenv\/config["']|from\s+["']dotenv(?:\/[\w./-]+)?["']|require\(\s*["']dotenv(?:\/[\w./-]+)?["']/;

describe("parseEnvFile", () => {
  it("reads plain KEY=value pairs and ignores comments and blank lines", () => {
    expect(
      parseEnvFile("# a comment\n\nDATABASE_URL=postgres://user:pw@host/db\n\n  # indented\nPORT=3000\n")
    ).toEqual({ DATABASE_URL: "postgres://user:pw@host/db", PORT: "3000" });
  });

  it("accepts an `export ` prefix, as a sourced .env would carry", () => {
    expect(parseEnvFile("export SESSION_SECRET=abc123")).toEqual({ SESSION_SECRET: "abc123" });
  });

  it("strips quotes, unescaping only inside double quotes", () => {
    expect(parseEnvFile('A="one two"\nB=\'three four\'\nC="line\\nbreak"\nD=\'raw\\nkept\'')).toEqual({
      A: "one two",
      B: "three four",
      C: "line\nbreak",
      D: "raw\\nkept",
    });
  });

  it("drops a trailing comment but keeps a `#` that belongs to the value", () => {
    // A secret is allowed to contain `#`; dotenv only treats ` #` as a comment.
    expect(parseEnvFile("KEY=value # note\nPW=pa#ssword")).toEqual({ KEY: "value", PW: "pa#ssword" });
  });

  it("keeps a URL with a query string and a base64 secret intact", () => {
    const text =
      "DATABASE_URL=postgresql://u:p@host:5432/db?sslmode=require&channel_binding=require\n" +
      "SESSION_SECRET=aGVsbG8rd29ybGQvMTIzNA==\n";
    expect(parseEnvFile(text)).toEqual({
      DATABASE_URL:
        "postgresql://u:p@host:5432/db?sslmode=require&channel_binding=require",
      SESSION_SECRET: "aGVsbG8rd29ybGQvMTIzNA==",
    });
  });

  it("tolerates an empty value and skips a malformed line", () => {
    expect(parseEnvFile("EMPTY=\nnot a pair\nOK=1")).toEqual({ EMPTY: "", OK: "1" });
  });
});

describe("applyEnv", () => {
  it("never overwrites a variable the real environment already provides", () => {
    // systemd / pm2 / docker must win over a stale .env checked out next to the code.
    const env: Record<string, string | undefined> = { DATABASE_URL: "from-systemd" };
    applyEnv({ DATABASE_URL: "from-dotfile", SESSION_SECRET: "from-dotfile" }, env);
    expect(env.DATABASE_URL).toBe("from-systemd");
    expect(env.SESSION_SECRET).toBe("from-dotfile");
  });

  it("leaves an empty existing value alone rather than treating it as unset", () => {
    const env: Record<string, string | undefined> = { PORT: "" };
    applyEnv({ PORT: "3000" }, env);
    expect(env.PORT).toBe("");
  });
});

describe("the dotenv guard itself", () => {
  // The guard below is the whole value of the two suites that follow, so it gets its own
  // fixtures: it has to catch every shape a real import takes, and stay quiet about a
  // comment that merely names the package.
  it("catches every shape of a real dotenv import", () => {
    for (const line of [
      'import "dotenv/config";',
      "import 'dotenv/config'",
      'import { config } from "dotenv";',
      'import dotenv from "dotenv/lib/main.js";',
      'const dotenv = require("dotenv");',
      "require( 'dotenv/config' )",
    ]) {
      expect(line, `guard missed: ${line}`).toMatch(DOTENV_IMPORT);
    }
  });

  it("stays quiet about prose that only names the package", () => {
    for (const line of [
      '// Not "dotenv/config": dotenv is a devDependency and the image omits it.',
      "// Use the real dotenv when it happens to be installed.",
      '* - the file is read from `process.cwd()/.env`, exactly as dotenv does;',
    ]) {
      expect(line, `guard false-positived on: ${line}`).not.toMatch(DOTENV_IMPORT);
    }
  });
});

describe("no operational script depends on a devDependency to boot", () => {
  const scripts = readdirSync(SCRIPTS).filter((name) => /\.ts$/.test(name) && name !== "load-env.ts");

  it("finds the scripts directory it is asserting about", () => {
    expect(scripts.length).toBeGreaterThan(5);
  });

  for (const name of scripts) {
    it(`${name} loads env through ./load-env, not dotenv/config`, () => {
      const source = readFileSync(join(SCRIPTS, name), "utf8");
      expect(source, `${name} imports dotenv, which is a devDependency`).not.toMatch(DOTENV_IMPORT);
      // Only scripts that actually need env are required to import the loader; the ones
      // that do must go through it.
      if (/process\.env\.(DATABASE_URL|SESSION_SECRET)/.test(source)) {
        expect(source, `${name} reads env but never loads it`).toContain('import "./load-env"');
      }
    });
  }
});

describe("the worker does not depend on a devDependency to boot", () => {
  // The worker image is the strictest case: `npm ci --omit=dev` and nothing else, so an
  // import of dotenv is not a warning there, it is a restart loop.
  const workers = readdirSync(WORKERS).filter((name) => /\.ts$/.test(name));

  it("finds the workers directory it is asserting about", () => {
    expect(workers.length).toBeGreaterThan(0);
  });

  for (const name of workers) {
    it(`${name} never imports dotenv directly`, () => {
      const source = readFileSync(join(WORKERS, name), "utf8");
      expect(source, `${name} imports dotenv, which is absent under --omit=dev`).not.toMatch(
        DOTENV_IMPORT
      );
    });
  }

  it("the worker entrypoint loads env through @/shared/lib/env/load-env", () => {
    const source = readFileSync(join(WORKERS, "index.ts"), "utf8");
    expect(source).toContain('import "@/shared/lib/env/load-env"');
  });
});
