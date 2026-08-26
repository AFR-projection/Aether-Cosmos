import "./load-env";
import postgres from "postgres";

/**
 * Read-only schema check for PHASE 2 (migration 0020).
 *
 * Verifies against a live database that `memory_derived_links` exists with the
 * columns, constraints and indexes the derived-link services rely on, plus the
 * `memory_tag_map` reverse-lookup index the candidate probe needs. Reads
 * `information_schema` / `pg_catalog` only — it never writes, so it is safe to point
 * at any environment.
 *
 * Usage: npx tsx scripts/verify-derived-schema.ts
 * Exit code 0 = every check passed, 1 = something is missing.
 */

type Check = { name: string; ok: boolean; detail: string };

const EXPECTED_COLUMNS: Record<string, { type: string; nullable: boolean }> = {
  id: { type: "uuid", nullable: false },
  brain_id: { type: "uuid", nullable: false },
  source_memory_id: { type: "uuid", nullable: false },
  target_memory_id: { type: "uuid", nullable: false },
  origin: { type: "memory_relation_origin", nullable: false },
  status: { type: "memory_relation_status", nullable: false },
  relation: { type: "text", nullable: false },
  // `real()` in the Drizzle schema and `real` in 0020 — float4, which
  // information_schema reports as "real". Expecting "double precision" here would fail
  // against a correctly migrated database.
  weight: { type: "real", nullable: false },
  confidence: { type: "real", nullable: false },
  evidence: { type: "jsonb", nullable: true },
  reason: { type: "text", nullable: false },
  computed_by: { type: "text", nullable: false },
  source_hash_a: { type: "text", nullable: true },
  source_hash_b: { type: "text", nullable: true },
  created_at: { type: "timestamp with time zone", nullable: false },
  updated_at: { type: "timestamp with time zone", nullable: false },
};

const EXPECTED_CONSTRAINTS = [
  "memory_derived_links_canonical",
  "memory_derived_links_no_self",
  "memory_derived_links_weight",
  "memory_derived_links_confidence",
];

const EXPECTED_INDEXES = [
  "memory_derived_links_pair_unique",
  "memory_derived_links_source_idx",
  "memory_derived_links_target_idx",
  "memory_derived_links_version_idx",
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  const checks: Check[] = [];

  try {
    const [table] = await client<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'memory_derived_links'
      ) AS exists`;
    checks.push({
      name: "table memory_derived_links",
      ok: table.exists,
      detail: table.exists ? "present" : "MISSING — migration 0020 not applied",
    });

    if (table.exists) {
      const columns = await client<
        { column_name: string; data_type: string; udt_name: string; is_nullable: string }[]
      >`
        SELECT column_name, data_type, udt_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'memory_derived_links'`;

      const byName = new Map(columns.map((c) => [c.column_name, c]));
      for (const [name, want] of Object.entries(EXPECTED_COLUMNS)) {
        const got = byName.get(name);
        const type = got ? (got.data_type === "USER-DEFINED" ? got.udt_name : got.data_type) : "";
        const nullable = got ? got.is_nullable === "YES" : false;
        const ok = Boolean(got) && type === want.type && nullable === want.nullable;
        checks.push({
          name: `column ${name}`,
          ok,
          detail: got
            ? `${type}${nullable ? " NULL" : " NOT NULL"} (want ${want.type}${want.nullable ? " NULL" : " NOT NULL"})`
            : "MISSING",
        });
      }

      const extra = columns.filter((c) => !(c.column_name in EXPECTED_COLUMNS));
      checks.push({
        name: "no unexpected columns",
        ok: extra.length === 0,
        detail: extra.length === 0 ? "none" : extra.map((c) => c.column_name).join(", "),
      });

      const constraints = await client<{ conname: string; contype: string }[]>`
        SELECT conname, contype FROM pg_constraint
        WHERE conrelid = 'public.memory_derived_links'::regclass`;
      const names = new Set(constraints.map((c) => c.conname));
      for (const want of EXPECTED_CONSTRAINTS) {
        checks.push({ name: `constraint ${want}`, ok: names.has(want), detail: names.has(want) ? "present" : "MISSING" });
      }
      checks.push({
        name: "cascade from brain and both endpoints",
        ok: constraints.filter((c) => c.contype === "f").length >= 3,
        detail: `${constraints.filter((c) => c.contype === "f").length} foreign keys`,
      });

      const indexes = await client<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'memory_derived_links'`;
      const idx = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
      for (const want of EXPECTED_INDEXES) {
        checks.push({ name: `index ${want}`, ok: idx.has(want), detail: idx.get(want) ?? "MISSING" });
      }
      const pairIdx = idx.get("memory_derived_links_pair_unique") ?? "";
      checks.push({
        name: "pair index is UNIQUE and brain-scoped",
        ok: pairIdx.includes("UNIQUE") && pairIdx.includes("brain_id"),
        detail: pairIdx || "MISSING",
      });
    }

    const tagIdx = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'memory_tag_map_tag_idx'`;
    checks.push({
      name: "index memory_tag_map_tag_idx",
      ok: tagIdx.length > 0 && tagIdx[0].indexdef.includes("tag_id"),
      detail: tagIdx[0]?.indexdef ?? "MISSING",
    });

    const enums = await client<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('memory_relation_origin', 'memory_relation_status')
      GROUP BY t.typname`;
    for (const want of ["memory_relation_origin", "memory_relation_status"]) {
      const got = enums.find((e) => e.typname === want);
      checks.push({ name: `enum ${want}`, ok: Boolean(got), detail: got ? got.labels.join("|") : "MISSING" });
    }

    // The explicit table must be untouched by PHASE 2.
    const linkCols = await client<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memory_links'`;
    const polluted = linkCols
      .map((c) => c.column_name)
      .filter((c) => /origin|confidence|computed_by|evidence|derived/.test(c));
    checks.push({
      name: "memory_links carries no derived columns",
      ok: polluted.length === 0,
      detail: polluted.length === 0 ? "clean" : polluted.join(", "),
    });
  } finally {
    await client.end();
  }

  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main();
