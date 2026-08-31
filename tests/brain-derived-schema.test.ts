import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * PHASE 2 section A — the schema half of the contract.
 *
 * The persistence tests in `src/features/brain/application/commands/derived-link-service.test.ts` prove the
 * application layer keeps its promises. This file proves the database would keep them
 * even if the application forgot: canonical pairs, bounded confidence, one row per
 * pair, no self-edge. Two independent layers, per PRINSIP 6.
 *
 * These are assertions against source rather than a live database because the suite
 * has no DATABASE_URL — the same reason `tests/brain-isolation.test.ts` reads route
 * files. A structural assertion that fails on a bad edit is worth more than a
 * behavioural one that never runs.
 */

const ROOT = join(__dirname, "..");
const MIGRATION = readFileSync(
  join(ROOT, "drizzle", "0020_phase2_derived_relationships.sql"),
  "utf8"
);
const ROLLBACK_FILE = "drizzle/0020_phase2_derived_relationships_rollback.sql";
const ROLLBACK = readFileSync(join(ROOT, ...ROLLBACK_FILE.split("/")), "utf8");
const SCHEMA = readFileSync(join(ROOT, "src", "shared", "infrastructure", "db", "schema.ts"), "utf8");

/** Every non-test TypeScript source under the given roots, path relative to ROOT. */
function sourcesUnder(dirs: string[]): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
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
  for (const dir of dirs) walk(join(ROOT, dir));
  return out;
}

const brainSources = sourcesUnder(["src", "app", "workers"]);

/** The migration's executable statements, with `--` commentary removed. */
const STATEMENTS = MIGRATION.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

/** The `pgTable(...)` body for one Drizzle table, comments and all. */
function tableSource(name: string): string {
  const start = SCHEMA.indexOf(`export const ${name} = pgTable(`);
  expect(start, `${name} is not declared in schema.ts`).toBeGreaterThan(-1);
  const end = SCHEMA.indexOf("\n);", start);
  return SCHEMA.slice(start, end);
}

const derivedTable = tableSource("memoryDerivedLinks");
const linkTable = tableSource("memoryLinks");

describe("A1 — the derived table records provenance, not just a pair", () => {
  const REQUIRED_NOT_NULL = [
    "brain_id",
    "source_memory_id",
    "target_memory_id",
    "origin",
    "status",
    "relation",
    "weight",
    "confidence",
    "reason",
    "computed_by",
    "created_at",
    "updated_at",
  ];

  it("declares every provenance column NOT NULL in the migration", () => {
    const create = STATEMENTS.find((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS "memory_derived_links"')
    );
    expect(create).toBeDefined();

    for (const column of REQUIRED_NOT_NULL) {
      expect(create, `${column} must be NOT NULL`).toMatch(
        new RegExp(`"${column}"[^,]*NOT NULL`)
      );
    }
  });

  it("keeps evidence and the endpoint hashes nullable", () => {
    // An edge can exist before it has been re-hashed; evidence may be absent for a
    // future scorer. Making these NOT NULL would force placeholder rows.
    expect(MIGRATION).toMatch(/"evidence" jsonb,/);
    expect(MIGRATION).toMatch(/"source_hash_a" text,/);
    expect(MIGRATION).toMatch(/"source_hash_b" text,/);
  });

  it("mirrors the same columns in schema.ts", () => {
    for (const column of REQUIRED_NOT_NULL) {
      expect(derivedTable, `${column} missing from schema.ts`).toContain(`"${column}"`);
    }
    expect(derivedTable).toContain('jsonb("evidence")');
  });
});

describe("A2 — the database refuses what the application must not write", () => {
  it("enforces canonical ordering, so A-B and B-A cannot both exist", () => {
    expect(MIGRATION).toMatch(
      /CONSTRAINT "memory_derived_links_canonical" CHECK \("source_memory_id" < "target_memory_id"\)/
    );
    expect(derivedTable).toMatch(
      /check\(\s*"memory_derived_links_canonical",\s*sql`"source_memory_id" < "target_memory_id"`/
    );
  });

  it("rejects a self-edge", () => {
    expect(MIGRATION).toMatch(
      /CONSTRAINT "memory_derived_links_no_self" CHECK \("source_memory_id" <> "target_memory_id"\)/
    );
    expect(derivedTable).toContain('check("memory_derived_links_no_self"');
  });

  it("bounds weight and confidence to 0..1", () => {
    for (const column of ["weight", "confidence"]) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `CONSTRAINT "memory_derived_links_${column}" CHECK \\("${column}" >= 0 AND "${column}" <= 1\\)`
        )
      );
      expect(derivedTable).toMatch(
        new RegExp(`check\\(\\s*"memory_derived_links_${column}",\\s*sql\`"${column}" >= 0 AND`)
      );
    }
  });

  it("allows one row per pair per brain, and no more", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "memory_derived_links_pair_unique" ON "memory_derived_links" USING btree \("brain_id","source_memory_id","target_memory_id"\)/
    );
    // The upsert in reconcileDerivedEdges names this exact triple as its conflict
    // target; if the index changed shape the ON CONFLICT would stop matching.
    expect(derivedTable).toMatch(
      /uniqueIndex\("memory_derived_links_pair_unique"\)\.on\(\s*table\.brainId,\s*table\.sourceMemoryId,\s*table\.targetMemoryId/
    );
  });

  it("cascades away with the brain and with either endpoint", () => {
    for (const column of ["brain_id", "source_memory_id", "target_memory_id"]) {
      expect(MIGRATION).toMatch(
        new RegExp(`FOREIGN KEY \\("${column}"\\) REFERENCES[^;]*ON DELETE cascade`)
      );
    }
  });

  it("indexes the reads the service actually issues", () => {
    // Both directions (undirected lookup scans each) plus the version key that
    // reconciliation deletes by.
    expect(MIGRATION).toContain('"memory_derived_links_source_idx" ON "memory_derived_links" USING btree ("brain_id","source_memory_id","status","weight")');
    expect(MIGRATION).toContain('"memory_derived_links_target_idx" ON "memory_derived_links" USING btree ("brain_id","target_memory_id","status","weight")');
    expect(MIGRATION).toContain('"memory_derived_links_version_idx" ON "memory_derived_links" USING btree ("brain_id","computed_by")');
  });

  it("indexes the tag reverse lookup the candidate probe needs", () => {
    expect(MIGRATION).toContain(
      '"memory_tag_map_tag_idx" ON "memory_tag_map" USING btree ("tag_id","memory_id")'
    );
    expect(tableSource("memoryTagMap")).toMatch(
      /index\("memory_tag_map_tag_idx"\)\.on\(table\.tagId, table\.memoryId\)/
    );
  });
});

describe("A3 — the migration is additive and reversible", () => {
  it("never drops or renames anything", () => {
    const destructive = STATEMENTS.filter((statement) =>
      /\b(DROP|TRUNCATE|RENAME|ALTER COLUMN)\b/i.test(statement)
    );

    expect(destructive).toEqual([]);
  });

  it("never rewrites existing rows", () => {
    const mutating = STATEMENTS.filter((statement) =>
      /^\s*(UPDATE|DELETE|INSERT)\b/i.test(statement)
    );

    // No backfill: existing memory_links stay exactly as the user left them, and
    // derived edges are recomputed by the relate job rather than invented here.
    expect(mutating).toEqual([]);
  });

  it("only alters the table it just created", () => {
    const altered = STATEMENTS.filter((statement) => /^\s*ALTER TABLE/i.test(statement)).map(
      (statement) => statement.match(/ALTER TABLE "([^"]+)"/)?.[1]
    );

    expect([...new Set(altered)]).toEqual(["memory_derived_links"]);
  });

  it("touches memory_links in no statement at all", () => {
    const offenders = STATEMENTS.filter((statement) => /"memory_links"/.test(statement));

    expect(offenders).toEqual([]);
  });

  it("only adds to memory_tag_map, and only an index", () => {
    const touching = STATEMENTS.filter((statement) => /"memory_tag_map"/.test(statement));

    expect(touching).toHaveLength(1);
    expect(touching[0]).toMatch(/^CREATE INDEX IF NOT EXISTS/);
  });

  it("points at a rollback script that undoes exactly what it created", () => {
    const header = MIGRATION.slice(0, MIGRATION.indexOf("CREATE TYPE"));
    expect(header).toMatch(/Rollback:/);
    expect(header).toContain(ROLLBACK_FILE);

    // A runnable rollback rather than a comment describing one: the procedure is only
    // real if `scripts/apply-migration.ts` can execute it on the day it is needed.
    expect(ROLLBACK).toContain(`DROP TABLE IF EXISTS "memory_derived_links"`);
    expect(ROLLBACK).toContain(`DROP TYPE IF EXISTS "memory_relation_origin"`);
    expect(ROLLBACK).toContain(`DROP TYPE IF EXISTS "memory_relation_status"`);
    expect(ROLLBACK).toContain(`DROP INDEX IF EXISTS "memory_tag_map_tag_idx"`);

    // And nothing else: a rollback that drops a pre-existing table is not a rollback.
    const dropped = [...ROLLBACK.matchAll(/DROP\s+(TABLE|INDEX|TYPE)\s+IF EXISTS\s+"([^"]+)"/gi)].map(
      (match) => match[2]
    );
    expect(dropped.sort()).toEqual([
      "memory_derived_links",
      "memory_relation_origin",
      "memory_relation_status",
      "memory_tag_map_tag_idx",
    ]);
  });

  it("creates the enums it depends on", () => {
    expect(MIGRATION).toContain(
      `CREATE TYPE "memory_relation_origin" AS ENUM ('derived', 'inferred')`
    );
    expect(MIGRATION).toContain(
      `CREATE TYPE "memory_relation_status" AS ENUM ('applied', 'suggested')`
    );
  });
});

describe("A4 — explicit links are untouched", () => {
  it("keeps every guard memory_links already had", () => {
    for (const constraint of [
      "memory_links_one_target",
      "memory_links_target_type_matches",
      "memory_links_no_self_link",
    ]) {
      expect(linkTable).toContain(constraint);
    }
  });

  it("adds no derived column to the explicit table", () => {
    for (const column of ["confidence", "computed_by", "source_hash_a", "evidence", "weight"]) {
      expect(linkTable, `memory_links must not gain ${column}`).not.toContain(`"${column}"`);
    }
  });
});

describe("STEP 8 — a guess never reaches an explicit-only surface", () => {
  /**
   * PRINSIP 4. Three surfaces are defined as reporting only what a human or agent
   * actually asserted. The guarantee is "this file does not read the derived table",
   * which is a property of the source, so that is what is asserted.
   */
  const EXPLICIT_ONLY = [
    // A reasoning chain must be defensible hop by hop.
    ["src/features/brain/application/queries/path-service.ts", "brain_path"],
    // An archive carries user-owned data; derived edges rebuild themselves.
    ["src/features/brain/application/commands/export-service.ts", "export"],
    ["src/features/brain/application/commands/import-service.ts", "import"],
  ] as const;

  for (const [path, surface] of EXPLICIT_ONLY) {
    it(`${surface} does not read the derived table`, () => {
      const source = readFileSync(join(ROOT, path), "utf8");

      expect(source).not.toContain("memoryDerivedLinks");
      expect(source).not.toContain("memory_derived_links");
    });
  }

  it("has exactly the readers PHASE 2 declared, and no others", () => {
    // A new reader is a design decision, not an accident: it has to be added here
    // together with a test for whatever provenance it exposes.
    const READERS = [
      "src/features/brain/application/commands/derived-link-service.ts",
      "src/features/brain/application/queries/related-service.ts",
      "src/features/brain/application/queries/context-engine.ts",
      "src/features/brain/application/queries/provenance-service.ts",
      // health-service reads applied derived edges ONLY to ANNOTATE the orphan count
      // (see the "orphan count is explicit-only" test below); it never lets a guess
      // change which memories are orphans.
      "src/features/brain/application/queries/health-service.ts",
      "src/shared/infrastructure/db/schema.ts",
    ];

    const found = brainSources
      .filter((file) => /\bmemoryDerivedLinks\b/.test(file.source))
      .map((file) => file.path)
      .sort();

    expect(found).toEqual([...READERS].sort());
  });

  /**
   * health-service MAY read the derived table, but only to explain the orphan count —
   * never to change it. This is the real invariant PRINSIP 4 protects for that surface:
   * an orphan is still a memory with no *explicit* link, and a derived guess can only add
   * the softer "connected by similarity" annotation on top.
   */
  it("health metrics keeps the orphan count explicit-only, annotating with derived edges", () => {
    const source = readFileSync(join(ROOT, "src", "features", "brain", "application", "queries", "health-service.ts"), "utf8");

    // The orphan set is the degree-0 slice of the EXPLICIT link graph…
    expect(source).toMatch(/orphanIds\s*=\s*activeMemoryIds\.filter\(\(id\)\s*=>\s*degreeOf\(id\)\s*===\s*0\)/);
    // …and the reported metric is exactly that set's size — not a derived-adjusted number.
    expect(source).toMatch(/orphanMemories:\s*orphanIds\.length/);
    // Derived edges are read applied-only (a suggestion is not a connection) and are used
    // only to FILTER the already-computed orphan set into an annotation, never to build it.
    expect(source).toMatch(/memoryDerivedLinks\.status[^)]*"applied"/);
    expect(source).toMatch(/orphanConnectedViaDerived\s*=\s*orphanIds\.filter\(/);
  });
});
