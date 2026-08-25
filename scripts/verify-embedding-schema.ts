import "dotenv/config";
import postgres from "postgres";

/**
 * Read-only schema check for P9 semantic embeddings (migrations 0022 + 0024).
 *
 * Verifies against a live database that pgvector is enabled, that `memories` carries the
 * three embedding columns with a DIMENSION-FLEXIBLE `vector` column (no pinned width, so
 * any OpenRouter model works), that the `brain_embedding_settings` config table exists,
 * and that the old fixed-width HNSW index is gone (flexible dims use an exact scan). Reads
 * `information_schema` / `pg_catalog` only — it never writes, so it is safe against any
 * environment.
 *
 * Usage: npx tsx scripts/verify-embedding-schema.ts
 * Exit code 0 = every check passed, 1 = something is missing (e.g. a migration not applied).
 */

type Check = { name: string; ok: boolean; detail: string };

const EXPECTED_SETTINGS_COLUMNS: Record<string, { type: string; nullable: boolean }> = {
  id: { type: "text", nullable: false },
  provider: { type: "text", nullable: false },
  model: { type: "text", nullable: false },
  api_key_encrypted: { type: "text", nullable: true },
  dimensions: { type: "integer", nullable: false },
  enabled: { type: "boolean", nullable: false },
  created_at: { type: "timestamp with time zone", nullable: false },
  updated_at: { type: "timestamp with time zone", nullable: false },
};

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  const checks: Check[] = [];

  try {
    const [ext] = await client<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`;
    checks.push({
      name: "extension vector",
      ok: ext.exists,
      detail: ext.exists ? "enabled" : "MISSING — CREATE EXTENSION vector (migration 0022)",
    });

    // memories embedding columns. udt_name for a vector column is "vector"; the pinned
    // width lives in atttypmod, read separately below.
    const memCols = await client<
      { column_name: string; data_type: string; udt_name: string; is_nullable: string }[]
    >`
      SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memories'
        AND column_name IN ('embedding', 'embedding_model', 'embedding_updated_at')`;
    const memByName = new Map(memCols.map((c) => [c.column_name, c]));

    const embedding = memByName.get("embedding");
    checks.push({
      name: "column memories.embedding",
      ok: Boolean(embedding) && embedding!.udt_name === "vector",
      detail: embedding ? `${embedding.udt_name} (${embedding.is_nullable === "YES" ? "NULL" : "NOT NULL"})` : "MISSING",
    });

    // A dimension-flexible vector column has atttypmod = -1. A pinned vector(1536) reports
    // dims = 1536 + VARHDRSZ handling, so anything other than -1 means migration 0024 has
    // not reshaped the column and non-1536 models will still be rejected.
    const [dim] = await client<{ dims: number | null }[]>`
      SELECT (atttypmod) AS dims
      FROM pg_attribute
      WHERE attrelid = 'public.memories'::regclass AND attname = 'embedding'`;
    checks.push({
      name: "memories.embedding is dimension-flexible",
      ok: dim?.dims === -1,
      detail:
        dim?.dims === -1
          ? "vector (flexible — any model width)"
          : dim?.dims != null
            ? `PINNED (atttypmod=${dim.dims}) — run migration 0024 to drop the fixed width`
            : "MISSING",
    });

    for (const name of ["embedding_model", "embedding_updated_at"]) {
      const got = memByName.get(name);
      checks.push({
        name: `column memories.${name}`,
        ok: Boolean(got),
        detail: got ? `${got.data_type}` : "MISSING",
      });
    }

    const [table] = await client<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'brain_embedding_settings'
      ) AS exists`;
    checks.push({
      name: "table brain_embedding_settings",
      ok: table.exists,
      detail: table.exists ? "present" : "MISSING — migration 0022 not applied",
    });

    if (table.exists) {
      const cols = await client<
        { column_name: string; data_type: string; is_nullable: string }[]
      >`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'brain_embedding_settings'`;
      const byName = new Map(cols.map((c) => [c.column_name, c]));
      for (const [name, want] of Object.entries(EXPECTED_SETTINGS_COLUMNS)) {
        const got = byName.get(name);
        const nullable = got ? got.is_nullable === "YES" : false;
        const ok = Boolean(got) && got!.data_type === want.type && nullable === want.nullable;
        checks.push({
          name: `settings column ${name}`,
          ok,
          detail: got
            ? `${got.data_type}${nullable ? " NULL" : " NOT NULL"} (want ${want.type}${want.nullable ? " NULL" : " NOT NULL"})`
            : "MISSING",
        });
      }
    }

    const idx = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'memories_embedding_hnsw_idx'`;
    const def = idx[0]?.indexdef ?? "";
    checks.push({
      name: "fixed-width HNSW index removed",
      ok: def === "",
      detail: def
        ? `STILL PRESENT — drop it (migration 0024): ${def}`
        : "absent (expected — flexible dims use an exact <=> scan)",
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
