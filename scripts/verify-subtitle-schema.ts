import "./load-env";
import postgres from "postgres";

/**
 * Read-only check that migration 0029 landed, in the style of `verify-embedding-schema`.
 *
 * Safe to run against production: it only reads catalog tables and counts rows. Every assertion is
 * something the feature depends on at runtime rather than a restatement of the migration file —
 * a missing unique index, for instance, would not fail any query, it would quietly let a second
 * "Indonesian" track appear in the menu.
 */

type Check = { label: string; ok: boolean; detail: string };

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  const checks: Check[] = [];

  try {
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('subtitle_settings', 'subtitle_tracks', 'subtitle_cues')`;
    for (const name of ["subtitle_settings", "subtitle_tracks", "subtitle_cues"]) {
      checks.push({
        label: `table ${name}`,
        ok: tables.some((row) => row.table_name === name),
        detail: tables.some((row) => row.table_name === name) ? "present" : "MISSING",
      });
    }

    const enums = await client<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typname IN ('subtitle_origin', 'subtitle_status')
       GROUP BY t.typname`;
    const expectedEnums: Record<string, string[]> = {
      subtitle_origin: ["asr", "translated", "uploaded"],
      subtitle_status: ["queued", "processing", "ready", "failed"],
    };
    for (const [name, expected] of Object.entries(expectedEnums)) {
      const found = enums.find((row) => row.typname === name);
      const ok = found !== undefined && expected.every((label) => found.labels.includes(label));
      checks.push({
        label: `enum ${name}`,
        ok,
        detail: found ? found.labels.join(", ") : "MISSING",
      });
    }

    const columns = await client<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
         AND column_name LIKE 'subtitle_%'
       ORDER BY column_name`;
    for (const name of ["subtitle_period_start", "subtitle_quota_seconds", "subtitle_used_seconds"]) {
      const found = columns.find((row) => row.column_name === name);
      checks.push({
        label: `users.${name}`,
        ok: found !== undefined,
        detail: found ? `${found.data_type}, nullable=${found.is_nullable}` : "MISSING",
      });
    }

    /**
     * The index that makes "generate Indonesian again" replace a row instead of adding a second
     * entry to the CC menu. Its absence is invisible until a user regenerates.
     */
    const indexes = await client<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('subtitle_tracks', 'subtitle_cues')`;
    for (const name of [
      "subtitle_tracks_unique",
      "subtitle_tracks_status_idx",
      "subtitle_cues_unique",
      "subtitle_cues_track_time_idx",
    ]) {
      const ok = indexes.some((row) => row.indexname === name);
      checks.push({ label: `index ${name}`, ok, detail: ok ? "present" : "MISSING" });
    }

    // The inverse check: a prefix index the migration used to create and now drops. Its presence
    // means an older revision of 0029 ran and the DROP has not been applied.
    const stale = indexes.some((row) => row.indexname === "subtitle_tracks_file_idx");
    checks.push({
      label: "no redundant subtitle_tracks_file_idx",
      ok: !stale,
      detail: stale ? "PRESENT — re-apply 0029 to drop it" : "absent, as intended",
    });

    const constraints = await client<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conrelid IN ('subtitle_tracks'::regclass, 'subtitle_cues'::regclass)
         AND contype = 'f'`;
    for (const name of [
      "subtitle_tracks_file_id_files_id_fk",
      "subtitle_tracks_created_by_users_id_fk",
      "subtitle_tracks_translated_from_id_fk",
      "subtitle_cues_track_id_fk",
    ]) {
      const ok = constraints.some((row) => row.conname === name);
      checks.push({ label: `fk ${name}`, ok, detail: ok ? "present" : "MISSING" });
    }

    /**
     * The allowance actually reached the existing rows. The column default only applies to rows
     * written from now on, so an account that predates the migration would otherwise read as `0`
     * — which means unlimited, the opposite of what was intended.
     */
    const quotas = await client<{ role: string; uncapped: string; capped: string }[]>`
      SELECT role,
             count(*) FILTER (WHERE subtitle_quota_seconds = 0)::text AS uncapped,
             count(*) FILTER (WHERE subtitle_quota_seconds > 0)::text AS capped
        FROM users GROUP BY role ORDER BY role`;
    for (const row of quotas) {
      const ok = row.role === "master" ? row.capped === "0" : row.uncapped === "0";
      checks.push({
        label: `allowance for role=${row.role}`,
        ok,
        detail:
          row.role === "master"
            ? `${row.uncapped} uncapped, ${row.capped} capped (master should be all uncapped)`
            : `${row.capped} capped, ${row.uncapped} uncapped (users should be all capped)`,
      });
    }

    const settings = await client<{ count: string }[]>`SELECT count(*)::text FROM subtitle_settings`;
    checks.push({
      label: "subtitle_settings rows",
      // Zero is correct and expected: the row is created by the first save in /admin/subtitles.
      ok: Number(settings[0].count) <= 1,
      detail: `${settings[0].count} (0 until the first save; never more than 1)`,
    });

    const passed = checks.filter((check) => check.ok).length;
    for (const check of checks) {
      console.log(`${check.ok ? "✅" : "❌"} ${check.label.padEnd(42)} ${check.detail}`);
    }
    console.log(`\n${passed}/${checks.length} checks passed`);
    if (passed !== checks.length) process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();
