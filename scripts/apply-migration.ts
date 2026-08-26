import "./load-env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

/**
 * Apply a single SQL migration file directly to the database.
 *
 * Why not `drizzle-kit migrate`? This DB was bootstrapped with `db:push`, so the
 * `__drizzle_migrations` table is empty. `drizzle-kit migrate` would think NOTHING
 * has been applied and try to re-run every migration from 0000 (CREATE TABLE on
 * tables that already exist -> "relation already exists"). So we apply the one
 * migration we actually need, directly. The 0002 SQL is guarded/idempotent, so
 * re-running it is safe.
 *
 * Usage: npx tsx scripts/apply-migration.ts drizzle/0002_rename_email_to_phone.sql
 */
async function main() {
  const relPath = process.argv[2];
  if (!relPath) {
    console.error("Usage: tsx scripts/apply-migration.ts <path-to-sql-file>");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const sqlPath = resolve(process.cwd(), relPath);
  const raw = readFileSync(sqlPath, "utf8");

  // Drizzle separates statements with this marker; strip it and run the whole file.
  const sql = raw.replace(/-->\s*statement-breakpoint/g, "\n");

  console.log(`Applying migration: ${relPath}`);
  const client = postgres(connectionString, { max: 1 });
  try {
    await client.unsafe(sql);
    console.log("✅ Migration applied successfully.");
  } catch (err) {
    console.error("❌ Migration failed:");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
