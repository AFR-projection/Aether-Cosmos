import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "@/shared/lib/app-version";
import { MIN_APP_VERSION, SCHEMA_VERSION } from "@backup/domain/version";
import { AFR_FORMAT_VERSION } from "@backup/account/domain/format";

/**
 * The version markers an artifact carries, pinned to the repository they describe.
 *
 * `SCHEMA_VERSION` is a hand-written constant because this instance was bootstrapped
 * with `db:push` and `__drizzle_migrations` is empty — there is no table that knows
 * the migration head. A constant nobody checks is worse than no constant at all: it is
 * stamped into every archive's summary and shown by the restore preview, so a stale
 * "0026" in a file written after 0027 landed is a lie told to whoever is deciding
 * whether to restore it.
 *
 * This file is the check. Add a migration without bumping the constant and it fails.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.2.
 */

const MIGRATION_DIR = join(process.cwd(), "drizzle");

/** `0027_backup.sql` → 27. Rollbacks are not migrations and do not count. */
const migrations = readdirSync(MIGRATION_DIR)
  .filter((name) => name.endsWith(".sql") && !name.endsWith("_rollback.sql"))
  .map((name) => ({ name, index: Number(/^(\d{4})_/.exec(name)?.[1] ?? Number.NaN) }));

const head = Math.max(...migrations.map((m) => m.index));

describe("the schema version is the migration head", () => {
  it("found the migrations at all", () => {
    // Guards every assertion below: a rename of the folder would otherwise make them
    // pass by comparing against an empty list.
    expect(migrations.length).toBeGreaterThan(20);
    expect(migrations.every((m) => Number.isInteger(m.index))).toBe(true);
    expect(migrations.map((m) => m.name)).toContain("0000_initial.sql");
  });

  it("equals the highest numbered file in drizzle/", () => {
    expect(SCHEMA_VERSION).toBe(String(head).padStart(4, "0"));
  });

  it("is four zero-padded digits, because the comparison is a string", () => {
    // The preview reads it back as text: "27" and "0027" describe the same database and
    // would read as two different schemas to anyone comparing them.
    expect(SCHEMA_VERSION).toMatch(/^\d{4}$/);
    expect(SCHEMA_VERSION).toBe(SCHEMA_VERSION.trim());
    expect(Number(SCHEMA_VERSION)).toBe(head);
  });

  it("names a file that exists", () => {
    expect(migrations.filter((m) => m.index === Number(SCHEMA_VERSION)).length).toBeGreaterThan(
      0
    );
  });

  it("leaves no gap in the numbering", () => {
    const indexes = new Set(migrations.map((m) => m.index));

    // A missing number means a migration file was deleted rather than superseded, and
    // the head is then no longer a description of the schema.
    expect([...Array(head + 1).keys()].filter((i) => !indexes.has(i))).toEqual([]);
  });

  it("ships a rollback for the head and everything since 0020", () => {
    const files = new Set(readdirSync(MIGRATION_DIR));
    const missing = migrations
      .filter((m) => m.index >= 20)
      .filter((m) => !files.has(m.name.replace(/\.sql$/, "_rollback.sql")))
      .map((m) => m.name);

    // The convention since 0020: a migration that cannot be undone is a migration
    // nobody will dare apply to a 2 GB VPS at 03:00.
    expect(missing).toEqual([]);
  });
});

describe("the app version an artifact demands", () => {
  const triple = (version: string): number[] => version.split(".").map(Number);

  it("is a plain semver triple", () => {
    expect(MIN_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is no newer than the app that writes the artifact", () => {
    // An artifact this build produces has to be readable by this build. The inequality
    // is the direction that matters: `MIN_APP_VERSION` is bumped when the *format*
    // changes, so it trails the app version and never leads it.
    const [minMajor, minMinor, minPatch] = triple(MIN_APP_VERSION);
    const [major, minor, patch] = triple(APP_VERSION);

    expect(minMajor).toBeLessThanOrEqual(major);
    if (minMajor === major) expect(minMinor).toBeLessThanOrEqual(minor);
    if (minMajor === major && minMinor === minor) expect(minPatch).toBeLessThanOrEqual(patch);
  });

  it("agrees with package.json about what this app is", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { version: string };

    expect(APP_VERSION).toBe(manifest.version);
  });
});

describe("the container format version", () => {
  it("is 1, and is not the schema version", () => {
    // Two independent numbers in every header: the format of the envelope, and the
    // shape of the rows inside it. Conflating them is how a restore reads a v2
    // envelope with v1 rules.
    expect(AFR_FORMAT_VERSION).toBe(1);
    expect(String(AFR_FORMAT_VERSION)).not.toBe(SCHEMA_VERSION);
  });
});
