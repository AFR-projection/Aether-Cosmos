import "./load-env";
import postgres from "postgres";

/**
 * Verify migrations 0027_backup and 0028_account_backup.
 *
 * Per-account backup needs both: 0028 stores the sealed recovery-wrapping key in
 * 0027's `backup_keys`, so a database carrying only 0028 fails at the first
 * download with a missing relation rather than at deploy time. This checks the
 * tables, the columns per-account restore actually reads, and the thirteen
 * `activity_action` labels the two migrations declare — an audit insert naming a
 * label the enum lacks is a 500 nobody sees until someone clicks Download.
 *
 * Reads the catalog only. Never prints a key, a phrase, or a row.
 *
 * Usage: npx tsx scripts/verify-account-backup-schema.ts
 */

/**
 * 0027 first — 0028's header says so, and `backup_keys` is the reason.
 *
 * One table, not the three 0027 created. `backup_settings` and `backup_jobs` belonged
 * to the whole-instance feature that has been removed, and
 * `drizzle/0027_backup_rollback.sql` drops them; asserting their presence here would
 * fail a database that is *more* correct than one that still has them.
 */
const TABLES_0027 = ["backup_keys"] as const;
const TABLES_0028 = [
  "account_backup_identities",
  "restore_batches",
  "restore_reservations",
] as const;

/** The staging marker, Files domain only. Brain imports in one transaction. */
const STAGING_COLUMNS = [
  ["files", "restore_batch_id"],
  ["folders", "restore_batch_id"],
] as const;

/**
 * 0027's six labels are still checked even though nothing writes them any more.
 *
 * They are enum values, and PostgreSQL cannot drop one: `activity_logs` rows written
 * by the old feature still name them, and `audit-actions.ts` still carries their
 * labels so the audit log stays readable. A database missing them is a database whose
 * old rows cannot be rendered.
 */
const LABELS_0027 = [
  "backup_create",
  "backup_download",
  "backup_delete",
  "backup_settings_change",
  "backup_key_rotate",
  "backup_purge_all",
] as const;

const LABELS_0028 = [
  "backup_takeout",
  "backup_restore_preview",
  "backup_restore_merge",
  "backup_restore_replace",
  "backup_recovery_view",
  "backup_restore_refused",
  "backup_restore_adopted",
] as const;

/** Indexes whose absence is a silent performance cliff, not an error. */
const INDEXES = [
  "account_backup_identities_one_generated",
  "account_backup_identities_id_idx",
  "restore_batches_user_state_idx",
  "restore_batches_stale_idx",
  "restore_reservations_user_idx",
  "files_restore_batch_idx",
  "folders_restore_batch_idx",
] as const;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  let failed = false;

  const report = (ok: boolean, line: string) => {
    if (!ok) failed = true;
    console.log(`${ok ? "  ok  " : "  MISSING  "} ${line}`);
  };

  try {
    const present = new Set(
      (
        await client<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
        `
      ).map((row) => row.table_name)
    );

    console.log("tables — 0027_backup");
    for (const table of TABLES_0027) report(present.has(table), table);

    console.log("");
    console.log("tables — 0028_account_backup");
    for (const table of TABLES_0028) report(present.has(table), table);

    const columns = new Set(
      (
        await client<{ key: string }[]>`
          SELECT table_name || '.' || column_name AS key
            FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'restore_batch_id'
        `
      ).map((row) => row.key)
    );

    console.log("");
    console.log("staging columns (Files domain only)");
    for (const [table, column] of STAGING_COLUMNS) {
      report(columns.has(`${table}.${column}`), `${table}.${column}`);
    }

    const labels = new Set(
      (
        await client<{ enumlabel: string }[]>`
          SELECT e.enumlabel
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = 'activity_action'
        `
      ).map((row) => row.enumlabel)
    );

    console.log("");
    console.log("activity_action labels — 0027");
    for (const label of LABELS_0027) report(labels.has(label), label);

    console.log("");
    console.log("activity_action labels — 0028");
    for (const label of LABELS_0028) report(labels.has(label), label);

    const indexes = new Set(
      (
        await client<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        `
      ).map((row) => row.indexname)
    );

    console.log("");
    console.log("indexes");
    for (const index of INDEXES) report(indexes.has(index), index);

    console.log("");
    if (failed) {
      console.error("Schema incomplete. Apply, in this order:");
      console.error("  npx tsx scripts/apply-migration.ts drizzle/0027_backup.sql");
      console.error("  npx tsx scripts/apply-migration.ts drizzle/0028_account_backup.sql");
      process.exitCode = 1;
      return;
    }
    console.log("Migrations 0027 and 0028 verified.");
  } catch (err) {
    console.error("Verification failed:");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
