import "dotenv/config";
import postgres from "postgres";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../lib/db/schema";

/**
 * Read-only health audit of the live database.
 *
 * Answers "does the database match the code, and is there anything in it that no
 * longer belongs" without changing a single row. Every query below reads
 * information_schema, pg_catalog or pg_stat_* only; there is no DDL and no DML in
 * this file, so it is safe to run against production at any time.
 *
 * It reports rather than fixes: dropping a table or an index on a live database is a
 * decision for a human, and the output is meant to be the input to that decision.
 *
 * Usage: npx tsx scripts/audit-db.ts
 */

type Row = Record<string, unknown>;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set (check your .env)");
  process.exit(1);
}
const sql = postgres(connectionString, { max: 1 });

const findings: Array<{ level: "CRITICAL" | "WARN" | "INFO"; text: string }> = [];
const note = (level: "CRITICAL" | "WARN" | "INFO", text: string) =>
  findings.push({ level, text });

function heading(title: string) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

/** Every pgTable exported from lib/db/schema.ts, keyed by its SQL name. */
function schemaTables(): Map<string, ReturnType<typeof getTableConfig>> {
  const out = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    try {
      const config = getTableConfig(value as PgTable);
      if (config.name) out.set(config.name, config);
    } catch {
      // Not a pgTable (enum, relation, type helper) — skip.
    }
  }
  return out;
}

async function tableInventory(expected: Map<string, unknown>) {
  heading("1. TABLES — what the database has vs what the code declares");

  const live = (await sql`
    SELECT c.relname AS name,
           pg_total_relation_size(c.oid) AS bytes,
           COALESCE(s.n_live_tup, 0) AS live_rows,
           COALESCE(s.n_dead_tup, 0) AS dead_rows,
           s.last_autovacuum,
           s.last_autoanalyze
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `) as unknown as Row[];

  const liveNames = new Set(live.map((row) => String(row.name)));
  const missing = [...expected.keys()].filter((name) => !liveNames.has(name));
  const orphans = [...liveNames].filter(
    (name) => !expected.has(name) && name !== "__drizzle_migrations"
  );

  console.log(`live tables: ${live.length}, declared in schema.ts: ${expected.size}`);
  for (const row of live) {
    const kb = Math.round(Number(row.bytes) / 1024);
    const flag = expected.has(String(row.name)) ? " " : "?";
    console.log(
      `  ${flag} ${String(row.name).padEnd(34)} ${String(row.live_rows).padStart(7)} rows` +
        ` ${String(kb).padStart(7)} KB` +
        (Number(row.dead_rows) > 0 ? `  dead=${row.dead_rows}` : "")
    );
  }

  if (missing.length) {
    note("CRITICAL", `declared in schema.ts but absent from the database: ${missing.join(", ")}`);
  }
  if (orphans.length) {
    note("WARN", `present in the database but not declared in schema.ts: ${orphans.join(", ")}`);
  }
  if (!missing.length && !orphans.length) {
    console.log("\n  OK — every declared table exists, and nothing extra is present.");
  }
  return liveNames;
}

/** Compare type spellings across Drizzle and pg_catalog without false alarms. */
function normalizeType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/character varying/g, "varchar")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .replace(/"/g, "")
    .replace(/\[\]$/, "[]")
    .trim();
}

async function columnDrift(expected: Map<string, ReturnType<typeof getTableConfig>>, liveNames: Set<string>) {
  heading("2. COLUMNS — drift between schema.ts and the live table");

  const cols = (await sql`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `) as unknown as Row[];

  const byTable = new Map<string, Map<string, { type: string; notNull: boolean }>>();
  for (const row of cols) {
    const table = String(row.table_name);
    if (!byTable.has(table)) byTable.set(table, new Map());
    byTable.get(table)!.set(String(row.column_name), {
      type: normalizeType(String(row.data_type)),
      notNull: Boolean(row.not_null),
    });
  }

  let problems = 0;
  for (const [name, config] of expected) {
    if (!liveNames.has(name)) continue;
    const liveCols = byTable.get(name)!;
    for (const column of config.columns) {
      const liveCol = liveCols.get(column.name);
      if (!liveCol) {
        note("CRITICAL", `${name}.${column.name} is declared in schema.ts but missing in the database`);
        problems += 1;
        continue;
      }
      const wantType = normalizeType(column.getSQLType());
      if (liveCol.type !== wantType) {
        note("WARN", `${name}.${column.name}: database has ${liveCol.type}, schema.ts says ${wantType}`);
        problems += 1;
      }
      if (liveCol.notNull !== column.notNull) {
        note(
          "WARN",
          `${name}.${column.name}: database ${liveCol.notNull ? "NOT NULL" : "nullable"},` +
            ` schema.ts ${column.notNull ? "NOT NULL" : "nullable"}`
        );
        problems += 1;
      }
    }
    const declared = new Set(config.columns.map((column) => column.name));
    for (const liveName of liveCols.keys()) {
      if (!declared.has(liveName)) {
        note("WARN", `${name}.${liveName} exists in the database but not in schema.ts (dead column?)`);
        problems += 1;
      }
    }
  }

  console.log(problems === 0 ? "  OK — no column drift." : `  ${problems} column issue(s), listed in the summary.`);
}

async function indexAudit() {
  heading("3. INDEXES — unused, redundant, invalid");

  const idx = (await sql`
    SELECT i.relname AS index_name,
           t.relname AS table_name,
           COALESCE(s.idx_scan, 0) AS scans,
           pg_relation_size(i.oid) AS bytes,
           x.indisunique AS is_unique,
           x.indisprimary AS is_primary,
           x.indisvalid AS is_valid,
           pg_get_indexdef(i.oid) AS definition
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
    WHERE n.nspname = 'public'
    ORDER BY t.relname, i.relname
  `) as unknown as Row[];

  const invalid = idx.filter((row) => !row.is_valid);
  for (const row of invalid) {
    note("CRITICAL", `index ${row.index_name} on ${row.table_name} is INVALID (failed build) — drop and recreate`);
  }

  // Redundant = one index's column list is a prefix of another's on the same table.
  const cols = (row: Row) =>
    String(row.definition).match(/\(([^)]*)\)\s*$/)?.[1]?.split(",").map((part) => part.trim()) ?? [];
  const redundant: string[] = [];
  for (const a of idx) {
    for (const b of idx) {
      if (a.index_name === b.index_name || a.table_name !== b.table_name) continue;
      const ca = cols(a);
      const cb = cols(b);
      if (ca.length >= cb.length || cb.length === 0) continue;
      const isPrefix = ca.every((col, i) => col === cb[i]);
      // A unique index is never redundant: it carries a constraint, not just a lookup.
      if (isPrefix && !a.is_unique && !a.is_primary) {
        redundant.push(`${a.index_name} is a prefix of ${b.index_name} on ${a.table_name}`);
      }
    }
  }
  for (const line of new Set(redundant)) note("WARN", `redundant index: ${line}`);

  const unused = idx.filter(
    (row) => Number(row.scans) === 0 && !row.is_primary && !row.is_unique && Number(row.bytes) > 16_384
  );
  if (unused.length) {
    console.log("\n  never-scanned non-unique indexes (since the last stats reset):");
    for (const row of unused) {
      console.log(`    ${String(row.index_name).padEnd(44)} ${Math.round(Number(row.bytes) / 1024)} KB`);
    }
    note("INFO", `${unused.length} index(es) have never been scanned — see section 3 before dropping any`);
  }
  console.log(`\n  ${idx.length} indexes total, ${invalid.length} invalid, ${new Set(redundant).size} redundant.`);
}

async function foreignKeyAudit() {
  heading("4. FOREIGN KEYS — unindexed children and delete rules");

  const fks = (await sql`
    SELECT con.conname AS name,
           child.relname AS child_table,
           parent.relname AS parent_table,
           con.confdeltype AS delete_rule,
           (SELECT array_agg(att.attname ORDER BY ord.n)
              FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.attnum
           ) AS child_columns
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
    ORDER BY child.relname, con.conname
  `) as unknown as Row[];

  const idxDefs = (await sql`
    SELECT t.relname AS table_name, pg_get_indexdef(i.oid) AS definition
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
  `) as unknown as Row[];

  const RULES: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  let unindexed = 0;
  for (const fk of fks) {
    const childCols = (fk.child_columns as string[]) ?? [];
    const leading = childCols[0];
    const covered = idxDefs.some(
      (row) =>
        row.table_name === fk.child_table &&
        String(row.definition).match(/\(([^)]*)\)\s*$/)?.[1]?.split(",")[0]?.trim().replace(/"/g, "") === leading
    );
    if (!covered) {
      unindexed += 1;
      note(
        "WARN",
        `FK ${fk.child_table}.${childCols.join(",")} -> ${fk.parent_table} has no index on the child column` +
          ` (every parent DELETE scans ${fk.child_table})`
      );
    }
  }
  const noAction = fks.filter((fk) => RULES[String(fk.delete_rule)] === "NO ACTION");
  console.log(
    `  ${fks.length} foreign keys: ${fks.filter((f) => f.delete_rule === "c").length} CASCADE,` +
      ` ${fks.filter((f) => f.delete_rule === "n").length} SET NULL, ${noAction.length} NO ACTION,` +
      ` ${unindexed} without a child index.`
  );
  for (const fk of noAction) {
    console.log(`    NO ACTION: ${fk.child_table}.${(fk.child_columns as string[]).join(",")} -> ${fk.parent_table}`);
  }
}

async function enumAudit() {
  heading("5. ENUMS — declared vs live");

  const live = (await sql`
    SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname
  `) as unknown as Row[];

  const declared = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    const candidate = value as { enumName?: string; enumValues?: string[] };
    if (candidate?.enumName && Array.isArray(candidate.enumValues)) {
      declared.set(candidate.enumName, candidate.enumValues);
    }
  }

  for (const row of live) {
    const name = String(row.name);
    const liveLabels = (row.labels as string[]) ?? [];
    const want = declared.get(name);
    if (!want) {
      note("WARN", `enum ${name} exists in the database but is not declared in schema.ts`);
      continue;
    }
    const missing = want.filter((label) => !liveLabels.includes(label));
    const extra = liveLabels.filter((label) => !want.includes(label));
    if (missing.length) {
      note("CRITICAL", `enum ${name} is missing label(s) the code uses: ${missing.join(", ")}`);
    }
    if (extra.length) {
      note("INFO", `enum ${name} has label(s) the code no longer uses: ${extra.join(", ")}`);
    }
  }
  for (const name of declared.keys()) {
    if (!live.some((row) => String(row.name) === name)) {
      note("CRITICAL", `enum ${name} is declared in schema.ts but absent from the database`);
    }
  }
  console.log(`  ${live.length} enums live, ${declared.size} declared in schema.ts.`);
}

async function hygiene() {
  heading("6. HOUSEKEEPING — stale rows, vacuum state, extensions");

  const withColumn = async (column: string) =>
    (await sql`
      SELECT c.relname AS name
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = ${column} AND a.attnum > 0
      ORDER BY c.relname
    `) as unknown as Row[];

  for (const row of await withColumn("expires_at")) {
    const table = String(row.name);
    const [count] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${table}" WHERE expires_at < now()`
    )) as unknown as Row[];
    if (Number(count.n) > 0) {
      console.log(`  ${table}: ${count.n} expired row(s) still stored`);
      note("INFO", `${table} holds ${count.n} row(s) past expires_at — candidates for a cleanup job`);
    }
  }

  for (const row of await withColumn("deleted_at")) {
    const table = String(row.name);
    const [count] = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM "${table}" WHERE deleted_at IS NOT NULL`
    )) as unknown as Row[];
    if (Number(count.n) > 0) console.log(`  ${table}: ${count.n} soft-deleted row(s) retained`);
  }

  const vacuum = (await sql`
    SELECT relname AS name, n_live_tup AS live, n_dead_tup AS dead, last_vacuum, last_autovacuum, last_analyze
    FROM pg_stat_user_tables
    WHERE n_dead_tup > 100 AND n_dead_tup > n_live_tup * 0.2
    ORDER BY n_dead_tup DESC
  `) as unknown as Row[];
  for (const row of vacuum) {
    note("INFO", `${row.name} has ${row.dead} dead tuples vs ${row.live} live — VACUUM (ANALYZE) would reclaim it`);
  }

  const ext = (await sql`SELECT extname FROM pg_extension ORDER BY extname`) as unknown as Row[];
  console.log(`  extensions: ${ext.map((row) => row.extname).join(", ")}`);

  const [migrations] = (await sql`
    SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'
  `) as unknown as Row[];
  console.log(`  drizzle migration ledger present: ${Number(migrations.n) > 0 ? "yes" : "no"}`);
}

async function main() {
  const expected = schemaTables();
  try {
    const liveNames = await tableInventory(expected);
    await columnDrift(expected, liveNames);
    await indexAudit();
    await foreignKeyAudit();
    await enumAudit();
    await hygiene();

    heading("SUMMARY");
    const order = { CRITICAL: 0, WARN: 1, INFO: 2 } as const;
    findings.sort((a, b) => order[a.level] - order[b.level]);
    if (findings.length === 0) {
      console.log("  No findings. The database matches the code and holds nothing stale.");
    } else {
      for (const finding of findings) console.log(`  ${finding.level.padEnd(8)} ${finding.text}`);
      const critical = findings.filter((finding) => finding.level === "CRITICAL").length;
      console.log(
        `\n  ${critical} critical, ${findings.filter((f) => f.level === "WARN").length} warning,` +
          ` ${findings.filter((f) => f.level === "INFO").length} informational.`
      );
    }
    console.log("\n  This script changed nothing. Every statement above was a read.");
  } finally {
    await sql.end();
  }
}

main();







