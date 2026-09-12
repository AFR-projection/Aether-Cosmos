import "./load-env";
import postgres from "postgres";

const PIPELINE_TABLES = [
  "subtitle_settings",
  "subtitle_tracks",
  "subtitle_cues",
  "subtitle_pipeline_runs",
  "subtitle_pipeline_targets",
  "subtitle_pipeline_work_items",
  "subtitle_audio_chunks",
  "subtitle_cue_partitions",
  "subtitle_provider_profiles",
  "subtitle_provider_attempts",
  "subtitle_reconciliation_state",
] as const;

/**
 * Read-only check that migrations 0029 and 0031 landed.
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
         AND table_name = ANY(${PIPELINE_TABLES})`;
    for (const name of PIPELINE_TABLES) {
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

    const trackColumns = await client<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'subtitle_tracks'`;
    for (const name of [
      "pipeline_run_id", "source_version", "source_r2_key", "source_mime_type",
      "source_track_revision", "revision", "track_state", "superseded_by_id", "user_edited_at",
    ]) {
      const found = trackColumns.find((row) => row.column_name === name);
      checks.push({ label: `subtitle_tracks.${name}`, ok: !!found, detail: found?.data_type ?? "MISSING" });
    }
    for (const name of ["cue_count", "duration_seconds"]) {
      const found = trackColumns.find((row) => row.column_name === name);
      checks.push({
        label: `subtitle_tracks.${name} bigint`,
        ok: found?.data_type === "bigint",
        detail: found?.data_type ?? "MISSING",
      });
    }

    const cueColumns = await client<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'subtitle_cues'
         AND column_name IN ('idx', 'start_ms', 'end_ms')`;
    for (const name of ["idx", "start_ms", "end_ms"]) {
      const found = cueColumns.find((row) => row.column_name === name);
      checks.push({
        label: `subtitle_cues.${name} bigint`,
        ok: found?.data_type === "bigint",
        detail: found?.data_type ?? "MISSING",
      });
    }

    /**
     * The partial indexes preserve the old playable track while a run builds a candidate.
    const indexes = await client<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN (
         'subtitle_tracks', 'subtitle_cues', 'subtitle_pipeline_work_items',
         'subtitle_provider_profiles', 'subtitle_pipeline_runs'
       )`;
    for (const name of [
      "subtitle_tracks_current_unique",
      "subtitle_tracks_run_unique",
      "subtitle_cues_unique",
      "subtitle_cues_track_time_idx",
      "subtitle_pipeline_work_items_due_idx",
      "subtitle_pipeline_work_items_lease_idx",
      "subtitle_provider_profiles_capability_role_unique",
      "subtitle_pipeline_runs_request_key_unique",
    ]) {
      const ok = indexes.some((row) => row.indexname === name);
      checks.push({ label: `index ${name}`, ok, detail: ok ? "present" : "MISSING" });
    }

    // The inverse check: a prefix index the migration used to create and now drops. Its presence
    // means an older revision of 0029 ran and the DROP has not been applied.
    const stale = indexes.some((row) => row.indexname === "subtitle_tracks_unique");
    checks.push({
      label: "legacy subtitle_tracks_unique removed",
      ok: !stale,
      detail: stale ? "PRESENT — re-apply 0031" : "absent, as intended",
    });

    const cueWindow = indexes.find((row) => row.indexname === "subtitle_cues_track_time_idx");
    const cueWindowOk = !!cueWindow && ["track_id", "start_ms", "end_ms", "idx", "id"].every(
      (column) => cueWindow.indexdef.includes(column)
    );
    checks.push({
      label: "cue window index shape",
      ok: cueWindowOk,
      detail: cueWindow?.indexdef ?? "MISSING",
    });

    const currentTrack = indexes.find((row) => row.indexname === "subtitle_tracks_current_unique");
    checks.push({
      label: "current track partial predicate",
      ok: currentTrack?.indexdef.includes("WHERE (track_state = 'current'::subtitle_track_state)") ?? false,
      detail: currentTrack?.indexdef ?? "MISSING",
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
    const quotas = await client<{ count: string }[]>`
      SELECT count(*)::text FROM users WHERE subtitle_quota_seconds <> 0`;
    checks.push({
      label: "legacy subtitle quota disabled",
      ok: quotas[0].count === "0",
      detail: `${quotas[0].count} rows still capped`,
    });

    const profiles = await client<{ capability: string; role: string; count: string }[]>`
      SELECT capability::text, role::text, count(*)::text
        FROM subtitle_provider_profiles GROUP BY capability, role`;
    for (const capability of ["asr", "translation"]) {
      const primary = profiles.find((row) => row.capability === capability && row.role === "primary");
      checks.push({
        label: `${capability} primary profile cardinality`,
        ok: !primary || primary.count === "1",
        detail: primary?.count ?? "0 (legacy settings row was absent)",
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
