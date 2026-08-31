import "./load-env";
import postgres from "postgres";

/**
 * Verify migration 0026: `users.step_code_length`.
 *
 * Checks the column exists, is a nullable integer, and reports how many accounts
 * with a 2-Step Code still have no recorded length — those are the ones the login
 * route backfills on their next successful sign-in.
 *
 * Usage: npx tsx scripts/verify-step-code-length.ts
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  try {
    const cols = await client`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'step_code_length'
    `;

    if (cols.length === 0) {
      console.error("❌ users.step_code_length does not exist — migration not applied.");
      process.exitCode = 1;
      return;
    }

    const col = cols[0];
    console.log("column      :", col.column_name);
    console.log("data_type   :", col.data_type);
    console.log("is_nullable :", col.is_nullable);
    console.log("default     :", col.column_default ?? "(none)");

    const ok = col.data_type === "integer" && col.is_nullable === "YES";
    if (!ok) {
      console.error("❌ Unexpected shape — expected a nullable integer.");
      process.exitCode = 1;
      return;
    }

    const [counts] = await client`
      SELECT count(*)::int AS with_code,
             count(step_code_length)::int AS with_length
        FROM users
       WHERE step_code_hash IS NOT NULL
    `;

    console.log("");
    console.log(`accounts with a 2-Step Code : ${counts.with_code}`);
    console.log(`  length already recorded   : ${counts.with_length}`);
    console.log(
      `  pending backfill          : ${counts.with_code - counts.with_length} (fills in at next successful sign-in)`
    );
    console.log("");
    console.log("✅ Migration 0026 verified.");
  } catch (err) {
    console.error("❌ Verification failed:");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
