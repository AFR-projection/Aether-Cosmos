import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";

/**
 * Shared coordination state for the scheduled cleanups (trash, file lifetime,
 * log retention).
 *
 * Two things can run these: the BullMQ worker (when Redis is up) and the web
 * app's own interval (when it is not). They both go through `claimCleanupRun`,
 * which is a compare-and-swap on a single row — whoever wins the UPDATE runs the
 * sweep, everyone else backs off. That keeps the work exactly-once even with
 * both schedulers live or several app instances behind a load balancer.
 *
 * Stored in `system_settings` under its own id so no migration is needed.
 */

type Db = PostgresJsDatabase<typeof schema>;

export const CLEANUP_STATE_ID = "cleanup_state";

/** How old the last run must be before another is allowed. */
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export type CleanupSource = "worker" | "app";

export interface CleanupResult {
  trashFiles: number;
  trashFolders: number;
  lifetimeSoftDeleted: number;
  logsDeleted: number;
  expiredUploads?: number;
  verifiedLegacyFiles?: number;
  inconsistentReadyFiles?: number;
  abortedMultipartUploads?: number;
  orphanObjectsReported?: number;
  expiredArchives?: number;
  expiredSessions?: number;
  expiredOtpTokens?: number;
}

export interface CleanupState {
  lastRunAt: string | null;
  lastSource: CleanupSource | null;
  lastResult: CleanupResult | null;
  lastError: string | null;
}

const EMPTY_STATE: CleanupState = {
  lastRunAt: null,
  lastSource: null,
  lastResult: null,
  lastError: null,
};

async function ensureRow(db: Db): Promise<void> {
  await db.execute(sql`
    INSERT INTO system_settings (id, data, updated_at)
    VALUES (${CLEANUP_STATE_ID}, '{}'::jsonb, now())
    ON CONFLICT (id) DO NOTHING
  `);
}

/**
 * Try to become the runner for this interval.
 *
 * The staleness check and the timestamp write happen in the same UPDATE, so two
 * schedulers racing at the same instant cannot both win — Postgres serialises
 * the row and the loser sees the already-updated `lastRunAt`.
 */
export async function claimCleanupRun(
  db: Db,
  source: CleanupSource,
  intervalMs: number = CLEANUP_INTERVAL_MS
): Promise<boolean> {
  await ensureRow(db);

  const cutoff = new Date(Date.now() - intervalMs).toISOString();

  const result = await db.execute(sql`
    UPDATE system_settings
    SET data = data || jsonb_build_object(
          'lastRunAt', ${new Date().toISOString()}::text,
          'lastSource', ${source}::text
        ),
        updated_at = now()
    WHERE id = ${CLEANUP_STATE_ID}
      AND (
        data->>'lastRunAt' IS NULL
        OR (data->>'lastRunAt')::timestamptz < ${cutoff}::timestamptz
      )
  `);

  return (result as unknown as { count?: number }).count === 1;
}

/** Record the outcome of a run that this process claimed. */
export async function recordCleanupResult(
  db: Db,
  outcome: { result?: CleanupResult; error?: string }
): Promise<void> {
  await db.execute(sql`
    UPDATE system_settings
    SET data = data || jsonb_build_object(
          'lastResult', ${JSON.stringify(outcome.result ?? null)}::jsonb,
          'lastError', ${outcome.error ?? null}::text
        ),
        updated_at = now()
    WHERE id = ${CLEANUP_STATE_ID}
  `);
}

export async function readCleanupState(db: Db): Promise<CleanupState> {
  const rows = await db.execute(sql`
    SELECT data FROM system_settings WHERE id = ${CLEANUP_STATE_ID} LIMIT 1
  `);

  const row = (rows as unknown as Array<{ data?: Partial<CleanupState> }>)[0];
  if (!row?.data) return { ...EMPTY_STATE };

  return {
    lastRunAt: typeof row.data.lastRunAt === "string" ? row.data.lastRunAt : null,
    lastSource:
      row.data.lastSource === "worker" || row.data.lastSource === "app"
        ? row.data.lastSource
        : null,
    lastResult: (row.data.lastResult as CleanupResult | null) ?? null,
    lastError: typeof row.data.lastError === "string" ? row.data.lastError : null,
  };
}
