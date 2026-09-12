import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import {
  files,
  subtitlePipelineRuns,
  subtitlePipelineTargets,
  subtitlePipelineWorkItems,
} from "@/shared/infrastructure/db/schema";
import type {
  ClaimedWork,
  EnsureRunSeed,
  OutboxMessage,
  PipelineRun,
  PipelineTarget,
  SourceIdentity,
  SubtitlePipelineStore,
  WorkItem,
  WorkKind,
  WorkLease,
  WorkSeed,
} from "@files/application/subtitles/pipeline/contracts";

type PipelineDb = PostgresJsDatabase<typeof schema>;
type RunRow = typeof subtitlePipelineRuns.$inferSelect;
type TargetRow = typeof subtitlePipelineTargets.$inferSelect;
type WorkRow = typeof subtitlePipelineWorkItems.$inferSelect;

const run = (row: RunRow): PipelineRun => row;
const target = (row: TargetRow): PipelineTarget => row;
const work = (row: WorkRow): WorkItem => row;

function source(row: typeof files.$inferSelect): SourceIdentity {
  return {
    fileId: row.id,
    userId: row.userId,
    version: row.version,
    r2Key: row.r2Key,
    mimeType: row.mimeType,
    encrypted: row.encrypted,
    deletedAt: row.deletedAt,
    durationMs: row.mediaDurationMs,
    createdAt: row.createdAt,
  };
}

/** PostgreSQL implementation. Work rows are the transactional outbox; queue job ids dedupe delivery. */
export function postgresSubtitlePipelineStore(database: PipelineDb = defaultDb): SubtitlePipelineStore {
  async function loadSource(fileId: string): Promise<SourceIdentity | null> {
    const [row] = await database.select().from(files).where(eq(files.id, fileId)).limit(1);
    return row ? source(row) : null;
  }

  async function ensureRun(seed: EnsureRunSeed): Promise<{ run: PipelineRun; created: boolean }> {
    return database.transaction(async (tx) => {
      const inserted = await tx.insert(subtitlePipelineRuns).values({
        fileId: seed.source.fileId,
        userId: seed.source.userId,
        sourceVersion: seed.source.version,
        sourceR2Key: seed.source.r2Key,
        sourceMimeType: seed.source.mimeType,
        policyVersion: seed.policyVersion,
        requestKey: seed.requestKey,
        localeSetHash: seed.localeSetHash,
        status: seed.status,
        stage: "ensure",
        durationMs: seed.source.durationMs,
        unsupportedCode: seed.unsupportedCode ?? null,
        completedAt: seed.status === "unsupported" ? seed.now : null,
        updatedAt: seed.now,
      }).onConflictDoNothing({ target: subtitlePipelineRuns.requestKey }).returning();
      let row = inserted[0];
      const created = Boolean(row);
      if (!row) {
        [row] = await tx.select().from(subtitlePipelineRuns)
          .where(eq(subtitlePipelineRuns.requestKey, seed.requestKey)).limit(1);
      }
      if (!row) throw new Error("Pipeline run conflict was not readable");
      if (row.sourceR2Key !== seed.source.r2Key || row.sourceMimeType !== seed.source.mimeType ||
          row.sourceVersion !== seed.source.version || row.userId !== seed.source.userId) {
        throw new Error("PIPELINE_REQUEST_KEY_COLLISION");
      }
      await tx.insert(subtitlePipelineTargets).values(seed.targets.map((language) => ({
        runId: row!.id,
        language,
        kind: "automatic" as const,
        status: seed.status === "unsupported" ? "blocked" as const : "pending" as const,
        terminalCode: seed.status === "unsupported" ? seed.unsupportedCode ?? "UNSUPPORTED" : null,
        updatedAt: seed.now,
      }))).onConflictDoNothing({
        target: [subtitlePipelineTargets.runId, subtitlePipelineTargets.language],
      });
      if (created && seed.status === "queued") {
        await tx.insert(subtitlePipelineWorkItems).values({
          runId: row.id, userId: row.userId, targetId: null, kind: "control",
          idempotencyKey: `${row.requestKey}:control:-:-`, availableAt: seed.now, updatedAt: seed.now,
        }).onConflictDoNothing({ target: subtitlePipelineWorkItems.idempotencyKey });
        await tx.update(subtitlePipelineRuns).set({ totalWorkItems: 1, updatedAt: seed.now })
          .where(eq(subtitlePipelineRuns.id, row.id));
      }
      return { run: run(row), created };
    });
  }

  async function getRun(runId: string): Promise<PipelineRun | null> {
    const [row] = await database.select().from(subtitlePipelineRuns)
      .where(eq(subtitlePipelineRuns.id, runId)).limit(1);
    return row ? run(row) : null;
  }

  async function listTargets(runId: string): Promise<readonly PipelineTarget[]> {
    const rows = await database.select().from(subtitlePipelineTargets)
      .where(eq(subtitlePipelineTargets.runId, runId)).orderBy(asc(subtitlePipelineTargets.createdAt));
    return rows.map(target);
  }

  async function addAutomaticTargets(runId: string, languages: readonly string[], localeSetHash: string, now: Date): Promise<number> {
    if (languages.length === 0) {
      await database.update(subtitlePipelineRuns).set({ localeSetHash, updatedAt: now })
        .where(eq(subtitlePipelineRuns.id, runId));
      return 0;
    }
    return database.transaction(async (tx) => {
      const inserted = await tx.insert(subtitlePipelineTargets).values(languages.map((language) => ({
        runId, language, kind: "automatic" as const, status: "pending" as const, updatedAt: now,
      }))).onConflictDoNothing({ target: [subtitlePipelineTargets.runId, subtitlePipelineTargets.language] })
        .returning({ id: subtitlePipelineTargets.id });
      await tx.update(subtitlePipelineRuns).set({ localeSetHash, updatedAt: now })
        .where(eq(subtitlePipelineRuns.id, runId));
      return inserted.length;
    });
  }

  async function createWork(seeds: readonly WorkSeed[], now: Date): Promise<readonly WorkItem[]> {
    if (seeds.length === 0) return [];
    return database.transaction(async (tx) => {
      const rows = await tx.insert(subtitlePipelineWorkItems).values(seeds.map((seed) => ({
        runId: seed.runId,
        targetId: seed.targetId,
        userId: seed.userId,
        kind: seed.kind,
        idempotencyKey: seed.idempotencyKey,
        ordinal: seed.ordinal,
        cursorStartMs: seed.cursorStartMs,
        cursorEndMs: seed.cursorEndMs,
        availableAt: seed.availableAt ?? now,
        maxAttempts: seed.maxAttempts ?? 8,
        updatedAt: now,
      }))).onConflictDoNothing({ target: subtitlePipelineWorkItems.idempotencyKey }).returning();
      if (rows.length > 0) {
        const perRun = new Map<string, number>();
        for (const row of rows) perRun.set(row.runId, (perRun.get(row.runId) ?? 0) + 1);
        for (const [runId, count] of perRun) {
          await tx.update(subtitlePipelineRuns).set({
            totalWorkItems: sql`${subtitlePipelineRuns.totalWorkItems} + ${count}`,
            updatedAt: now,
          }).where(eq(subtitlePipelineRuns.id, runId));
        }
      }
      return rows.map(work);
    });
  }

  async function advancePlan(runId: string, expectedCursorMs: number, nextCursorMs: number, stage: PipelineRun["stage"], now: Date): Promise<boolean> {
    const rows = await database.update(subtitlePipelineRuns).set({
      plannerCursorMs: nextCursorMs, plannedThroughMs: nextCursorMs, stage, status: "running", updatedAt: now,
    }).where(and(eq(subtitlePipelineRuns.id, runId), eq(subtitlePipelineRuns.plannerCursorMs, expectedCursorMs),
      inArray(subtitlePipelineRuns.status, ["queued", "running"]))).returning({ id: subtitlePipelineRuns.id });
    return rows.length === 1;
  }

  async function getWorkItem(id: string): Promise<WorkItem | null> {
    const [row] = await database.select().from(subtitlePipelineWorkItems)
      .where(eq(subtitlePipelineWorkItems.id, id)).limit(1);
    return row ? work(row) : null;
  }

  async function claimWorkItem(input: { workItemId: string; workerId: string; now: Date; leaseMs: number }): Promise<ClaimedWork | null> {
    if (input.leaseMs < 1) return null;
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const rows = await database.execute(sql`
      UPDATE subtitle_pipeline_work_items w
      SET status = 'leased', lease_owner = ${input.workerId}, lease_expires_at = ${expiresAt},
          heartbeat_at = ${input.now}, fencing_token = w.fencing_token + 1,
          attempt_count = w.attempt_count + 1, delivery_sequence = w.delivery_sequence + 1,
          updated_at = ${input.now}
      FROM subtitle_pipeline_runs r
      WHERE w.id = ${input.workItemId} AND w.run_id = r.id
        AND r.status IN ('queued', 'running')
        AND w.attempt_count < w.max_attempts
        AND ((w.status IN ('pending', 'retry') AND w.available_at <= ${input.now})
          OR (w.status = 'leased' AND w.lease_expires_at <= ${input.now}))
      RETURNING w.*
    `);
    const row = (rows as unknown as WorkRow[])[0];
    return row ? (work(row) as ClaimedWork) : null;
  }

  async function claimDueWork(input: { workerId: string; now: Date; leaseMs: number; limit: number }): Promise<readonly ClaimedWork[]> {
    if (input.limit < 1 || input.leaseMs < 1) return [];
    const expiresAt = new Date(input.now.getTime() + input.leaseMs);
    const rows = await database.execute(sql`
      WITH per_user AS (
        SELECT w.id, row_number() OVER (
          PARTITION BY w.user_id ORDER BY w.available_at, w.created_at, w.id
        ) AS user_rank
        FROM subtitle_pipeline_work_items w
        JOIN subtitle_pipeline_runs r ON r.id = w.run_id
        WHERE (w.status IN ('pending', 'retry') AND w.available_at <= ${input.now})
           OR (w.status = 'leased' AND w.lease_expires_at <= ${input.now})
        AND r.status IN ('queued', 'running')
      ), picked AS (
        SELECT w.id
        FROM subtitle_pipeline_work_items w JOIN per_user p ON p.id = w.id
        ORDER BY p.user_rank, w.available_at, w.created_at, w.id
        LIMIT ${input.limit}
        FOR UPDATE OF w SKIP LOCKED
      )
      UPDATE subtitle_pipeline_work_items w
      SET status = 'leased', lease_owner = ${input.workerId}, lease_expires_at = ${expiresAt},
          heartbeat_at = ${input.now}, fencing_token = w.fencing_token + 1,
          attempt_count = w.attempt_count + 1, delivery_sequence = w.delivery_sequence + 1,
          updated_at = ${input.now}
      FROM picked WHERE w.id = picked.id AND w.attempt_count < w.max_attempts
      RETURNING w.*
    `);
    return (rows as unknown as WorkRow[]).map((row) => work(row) as ClaimedWork);
  }

  async function heartbeat(lease: WorkLease, now: Date, leaseMs: number): Promise<boolean> {
    const rows = await database.update(subtitlePipelineWorkItems).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs), heartbeatAt: now, updatedAt: now,
    }).where(and(eq(subtitlePipelineWorkItems.id, lease.id), eq(subtitlePipelineWorkItems.status, "leased"),
      eq(subtitlePipelineWorkItems.leaseOwner, lease.leaseOwner), eq(subtitlePipelineWorkItems.fencingToken, lease.fencingToken),
      gt(subtitlePipelineWorkItems.leaseExpiresAt, now))).returning({ id: subtitlePipelineWorkItems.id });
    return rows.length === 1;
  }

  async function complete(lease: WorkLease, checkpoint: Record<string, unknown> | null, now: Date): Promise<boolean> {
    return database.transaction(async (tx) => {
      const rows = await tx.update(subtitlePipelineWorkItems).set({
        status: "succeeded", outputCheckpoint: checkpoint, completedAt: now,
        leaseOwner: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now,
      }).where(and(eq(subtitlePipelineWorkItems.id, lease.id), eq(subtitlePipelineWorkItems.status, "leased"),
        eq(subtitlePipelineWorkItems.leaseOwner, lease.leaseOwner), eq(subtitlePipelineWorkItems.fencingToken, lease.fencingToken),
        gt(subtitlePipelineWorkItems.leaseExpiresAt, now))).returning({ runId: subtitlePipelineWorkItems.runId });
      if (!rows[0]) return false;
      await tx.update(subtitlePipelineRuns).set({
        completedWorkItems: sql`${subtitlePipelineRuns.completedWorkItems} + 1`, updatedAt: now,
      }).where(eq(subtitlePipelineRuns.id, rows[0].runId));
      return true;
    });
  }

  async function retry(lease: WorkLease, failure: { code: string; message: string; availableAt: Date }, now: Date): Promise<"retry" | "failed" | "lost"> {
    const rows = await database.execute(sql`
      UPDATE subtitle_pipeline_work_items
      SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed'::subtitle_work_item_status
                        ELSE 'retry'::subtitle_work_item_status END,
          available_at = ${failure.availableAt}, failure_code = ${failure.code},
          failure_message = ${failure.message.slice(0, 500)}, lease_owner = NULL,
          lease_expires_at = NULL, heartbeat_at = ${now}, updated_at = ${now}
      WHERE id = ${lease.id} AND status = 'leased' AND lease_owner = ${lease.leaseOwner}
        AND fencing_token = ${lease.fencingToken} AND lease_expires_at > ${now}
      RETURNING status
    `);
    const status = (rows as unknown as Array<{ status: "retry" | "failed" }>)[0]?.status;
    return status ?? "lost";
  }

  async function revalidateSource(pipeline: PipelineRun): Promise<SourceIdentity | null> {
    return loadSource(pipeline.fileId);
  }

  async function invalidateRun(runId: string, code: string, message: string, now: Date): Promise<boolean> {
    return database.transaction(async (tx) => {
      const rows = await tx.update(subtitlePipelineRuns).set({
        status: "stale", failureCode: code, failureMessage: message.slice(0, 500), updatedAt: now,
      }).where(and(eq(subtitlePipelineRuns.id, runId), inArray(subtitlePipelineRuns.status, ["queued", "running", "blocked"])))
        .returning({ id: subtitlePipelineRuns.id });
      if (!rows[0]) return false;
      await tx.update(subtitlePipelineTargets).set({ status: "stale", terminalCode: code,
        terminalMessage: message.slice(0, 500), updatedAt: now })
        .where(and(eq(subtitlePipelineTargets.runId, runId), inArray(subtitlePipelineTargets.status,
          ["pending", "queued", "processing", "blocked"])));
      await tx.update(subtitlePipelineWorkItems).set({ status: "cancelled", leaseOwner: null,
        leaseExpiresAt: null, failureCode: code, failureMessage: message.slice(0, 500), updatedAt: now })
        .where(and(eq(subtitlePipelineWorkItems.runId, runId), inArray(subtitlePipelineWorkItems.status,
          ["pending", "retry", "leased", "blocked"])));
      return true;
    });
  }

  async function listUndiscoveredSources(cursor: { createdAt: Date; fileId: string } | null, limit: number): Promise<readonly SourceIdentity[]> {
    const after = cursor ? or(gt(files.createdAt, cursor.createdAt),
      and(eq(files.createdAt, cursor.createdAt), gt(files.id, cursor.fileId))) : undefined;
    const rows = await database.select().from(files).where(and(
      isNull(files.deletedAt), eq(files.status, "ready"), sql`${files.mimeType} LIKE 'video/%'`, after,
    )).orderBy(asc(files.createdAt), asc(files.id)).limit(limit);
    return rows.map(source);
  }

  async function enqueueOutbox(limit: number, enqueue: (message: OutboxMessage) => Promise<void>): Promise<number> {
    // Fair round-robin: one due item per user per tick, oldest first, so one user's
    // backfill burst can never starve another user's fresh upload.
    const rows = await database.execute(sql`
      WITH due AS (
        SELECT w.id, w.kind, w.user_id, w.available_at, w.created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY w.user_id
                 ORDER BY w.available_at, w.created_at, w.id
               ) AS rn
        FROM subtitle_pipeline_work_items w
        JOIN subtitle_pipeline_runs r ON r.id = w.run_id
        WHERE w.status IN ('pending', 'retry') AND w.available_at <= now()
          AND r.status IN ('queued', 'running')
      ),
      picked AS (
        SELECT id FROM due WHERE rn = 1
        ORDER BY available_at, created_at, id
        LIMIT ${limit}
      )
      UPDATE subtitle_pipeline_work_items w
      SET delivery_sequence = w.delivery_sequence + 1, updated_at = now()
      FROM picked WHERE w.id = picked.id
      RETURNING w.id, w.delivery_sequence, w.kind
    `);
    let sent = 0;
    for (const row of rows as unknown as Array<{ id: string; delivery_sequence: number; kind: WorkKind }>) {
      const message: OutboxMessage = { workItemId: row.id, deliverySequence: row.delivery_sequence,
        queueKey: `subtitle-work:${row.id}:${row.delivery_sequence}`, kind: row.kind };
      await enqueue(message);
      sent += 1;
    }
    return sent;
  }

  return {
    loadSource, ensureRun, getRun, listTargets, addAutomaticTargets, createWork, advancePlan,
    getWorkItem, claimWorkItem, claimDueWork, heartbeat, complete, retry, revalidateSource,
    invalidateRun, listUndiscoveredSources, enqueueOutbox,
  };
}
