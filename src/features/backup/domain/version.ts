/**
 * What version of the world an artifact came from.
 *
 * `SCHEMA_VERSION` is the migration head, hard-coded rather than read from the
 * database — and that is not laziness. This instance was bootstrapped with
 * `db:push`, so `__drizzle_migrations` is empty and there is no table that knows
 * the head (see `scripts/apply-migration.ts`). A constant with a test that pins it
 * to the highest file in `drizzle/` is the only version marker here that cannot
 * lie: `tests/backup-version.test.ts` fails the build if a migration is added and
 * this is not bumped.
 *
 * It travels inside every archive's encrypted summary and comes back out through the
 * restore preview (`POST /api/backup/restore/inspect`), which is what makes an archive
 * written against an older schema a fact somebody can see rather than a surprise. The
 * preview does not refuse on a mismatch: the importer writes through the current
 * schema's columns either way, and a stale marker is information, not a verdict.
 */
export const SCHEMA_VERSION = "0028";

/**
 * The oldest app that can read this format.
 *
 * Bumped only when the format changes, never when the app version changes — an
 * artifact written by 0.9.0 must still be readable by 0.4.0 as long as nothing in
 * the container moved.
 */
export const MIN_APP_VERSION = "0.4.0";
