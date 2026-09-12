import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { subtitlePipelineRuns, subtitleReconciliationState } from "@/shared/infrastructure/db/schema";
import { subtitleLocaleSetHash } from "@files/domain/services/subtitles/locale-targets";
import { backfillSubtitlePipelines, reconcileSubtitleLocales } from "@files/application/subtitles/pipeline/reconciliation";
import { postgresSubtitlePipelineStore } from "@files/infrastructure/subtitles/pipeline-store";
import type { BackfillCursor } from "@files/application/subtitles/pipeline/contracts";

const BACKFILL_KIND = "library_backfill" as const;
const LEASE_REPAIR_KIND = "lease_repair" as const;
const LOCALE_KIND = "locale_reconciliation" as const;
const LEASE_MS = 5 * 60_000;

function cursorFrom(row: {
  cursorCreatedAt: Date | null;
  cursorId: string | null;
}): BackfillCursor | null {
  if (!row.cursorCreatedAt || !row.cursorId) return null;
  return { createdAt: row.cursorCreatedAt, fileId: row.cursorId };
}

/** Atomically claim the reconciliation lease for one sweep kind. */
async function claimLease(kind: "library_backfill" | "lease_repair" | "locale_reconciliation", owner: string, now: Date): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const rows = await db.execute(sql`
    INSERT INTO subtitle_reconciliation_state (kind, status, lease_owner, lease_expires_at, heartbeat_at, updated_at)
    VALUES (${kind}, 'running', ${owner}, ${expiresAt}, ${now}, ${now})
    ON CONFLICT (kind) DO UPDATE
    SET status = 'running', lease_owner = ${owner}, lease_expires_at = ${expiresAt},
        heartbeat_at = ${now}, fencing_token = subtitle_reconciliation_state.fencing_token + 1,
        updated_at = ${now}
    WHERE subtitle_reconciliation_state.status IN ('idle', 'failed')
       OR subtitle_reconciliation_state.lease_expires_at <= ${now}
    RETURNING kind
  `);
  return (rows as unknown as Array<{ kind: string }>).length === 1;
}

async function releaseLease(
  kind: "library_backfill" | "lease_repair" | "locale_reconciliation",
  owner: string,
  patch: { status: "idle" | "failed"; lastErrorCode?: string; lastErrorMessage?: string },
  now: Date
): Promise<void> {
  await db
    .update(subtitleReconciliationState)
    .set({
      status: patch.status,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: patch.lastErrorCode ?? null,
      lastErrorMessage: patch.lastErrorMessage?.slice(0, 500) ?? null,
      lastCompletedAt: patch.status === "idle" ? now : undefined,
      updatedAt: now,
    })
    .where(and(eq(subtitleReconciliationState.kind, kind), eq(subtitleReconciliationState.leaseOwner, owner)));
}

/**
 * One-shot reconciliation sweep driven by a scheduler.
 *
 * Two phases, each behind its own lease so a stuck backfill never blocks lease repair:
 *
 * 1. library_backfill — keyset-paginated `ensure` over undiscovered sources.
 *    The cursor advances only after the whole batch (≤200) is persisted, and the
 *    sweep self-continues while batches are full, so a crash resumes exactly at
 *    the last durable cursor.
 * 2. lease_repair — expired `'leased'` work items return to `'retry'` with a
 *    failure record, so a dead worker frees its slot without losing billing truth.
 *
 * Callers schedule this (cron/interval); it exits after one full pass.
 */
export async function runSubtitleReconciliation(
  input: { backfillLimit?: number; leaseRepairLimit?: number; now?: Date } = {}
): Promise<void> {
  const owner = `reconcile-${randomUUID()}`;
  const now = input.now ?? new Date();
  const backfillLimit = input.backfillLimit ?? 200;
  const leaseRepairLimit = input.leaseRepairLimit ?? 50;

  // Phase 1: library backfill
  if (await claimLease(BACKFILL_KIND, owner, now)) {
    try {
      const store = postgresSubtitlePipelineStore();
      const [state] = await db
        .select()
        .from(subtitleReconciliationState)
        .where(eq(subtitleReconciliationState.kind, BACKFILL_KIND))
        .limit(1);
      let cursor = state ? cursorFrom(state) : null;
      let totalScanned = 0;
      let totalProcessed = 0;

      for (;;) {
        const page = await backfillSubtitlePipelines(store, { cursor, limit: backfillLimit });
        totalScanned += page.processed;
        totalProcessed += page.processed;
        await db
          .update(subtitleReconciliationState)
          .set({
            cursorCreatedAt: page.cursor?.createdAt ?? null,
            cursorId: page.cursor?.fileId ?? null,
            scannedCount: sql`${subtitleReconciliationState.scannedCount} + ${page.processed}`,
            processedCount: sql`${subtitleReconciliationState.processedCount} + ${page.processed}`,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(subtitleReconciliationState.kind, BACKFILL_KIND), eq(subtitleReconciliationState.leaseOwner, owner)));
        if (page.done) break;
        cursor = page.cursor;
      }
      console.log(`Subtitle backfill sweep: ${totalProcessed} source(s) ensured across scanned pages`);
      await releaseLease(BACKFILL_KIND, owner, { status: "idle" }, new Date());
      void totalScanned;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backfill sweep failed";
      await releaseLease(BACKFILL_KIND, owner, { status: "failed", lastErrorCode: "BACKFILL_FAILED", lastErrorMessage: message }, new Date());
      throw error;
    }
  }

  // Phase 2: lease repair
  if (await claimLease(LEASE_REPAIR_KIND, owner, now)) {
    try {
      const repaired = await db.execute(sql`
        UPDATE subtitle_pipeline_work_items
        SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
            failure_code = 'LEASE_EXPIRED', failure_message = 'Worker lease expired; item returned to due queue',
            heartbeat_at = ${new Date()}, updated_at = ${new Date()}
        WHERE status = 'leased' AND lease_expires_at <= ${new Date()}
          AND id IN (
            SELECT id FROM subtitle_pipeline_work_items
            WHERE status = 'leased' AND lease_expires_at <= ${new Date()}
            ORDER BY lease_expires_at
            LIMIT ${leaseRepairLimit}
            FOR UPDATE SKIP LOCKED
          )
      `);
      const count = (repaired as unknown as Array<unknown>).length;
      if (count > 0) console.log(`Subtitle lease repair: returned ${count} expired lease(s) to retry`);
      await db
        .update(subtitleReconciliationState)
        .set({
          processedCount: sql`${subtitleReconciliationState.processedCount} + ${count}`,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(subtitleReconciliationState.kind, LEASE_REPAIR_KIND), eq(subtitleReconciliationState.leaseOwner, owner)));
      await releaseLease(LEASE_REPAIR_KIND, owner, { status: "idle" }, new Date());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Lease repair failed";
      await releaseLease(LEASE_REPAIR_KIND, owner, { status: "failed", lastErrorCode: "LEASE_REPAIR_FAILED", lastErrorMessage: message }, new Date());
      throw error;
    }
  }

  // Phase 3: locale reconciliation — find runs whose app-locale hash has drifted
  // and add the missing targets so new locales backfill without manual triggers.
  if (await claimLease(LOCALE_KIND, owner, now)) {
    try {
      const store = postgresSubtitlePipelineStore();
      const [state] = await db
        .select()
        .from(subtitleReconciliationState)
        .where(eq(subtitleReconciliationState.kind, LOCALE_KIND))
        .limit(1);

      const currentHash = subtitleLocaleSetHash();
      const cursorCreatedAt = state?.cursorCreatedAt ?? new Date("1970-01-01");
      const runs = await db
        .select({ id: subtitlePipelineRuns.id })
        .from(subtitlePipelineRuns)
        .where(
          and(
            ne(subtitlePipelineRuns.localeSetHash, currentHash),
            eq(subtitlePipelineRuns.status, "running"),
            gt(subtitlePipelineRuns.updatedAt, cursorCreatedAt)
          )
        )
        .orderBy(desc(subtitlePipelineRuns.updatedAt))
        .limit(50);

      let totalAdded = 0;
      for (const run of runs) {
        const { added } = await reconcileSubtitleLocales(store, { runId: run.id, now });
        totalAdded += added;
      }

      if (totalAdded > 0) {
        console.log(`Subtitle locale reconciliation: ${totalAdded} missing locale target(s) added`);
      }

      await db
        .update(subtitleReconciliationState)
        .set({
          cursorCreatedAt: now,
          processedCount: sql`${subtitleReconciliationState.processedCount} + ${totalAdded}`,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(and(eq(subtitleReconciliationState.kind, LOCALE_KIND), eq(subtitleReconciliationState.leaseOwner, owner)));

      await releaseLease(LOCALE_KIND, owner, { status: "idle" }, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Locale reconciliation failed";
      await releaseLease(LOCALE_KIND, owner, { status: "failed", lastErrorCode: "LOCALE_RECONCILIATION_FAILED", lastErrorMessage: message }, now);
      throw error;
    }
  }
}
