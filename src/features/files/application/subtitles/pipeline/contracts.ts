export type PipelineRunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "unsupported"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";
export type PipelineStage =
  | "ensure"
  | "planning"
  | "preparing"
  | "transcribing"
  | "materializing_source"
  | "translating"
  | "publishing"
  | "cleanup"
  | "completed";
export type WorkKind = "control" | "prepare" | "asr" | "translate" | "materialize" | "publish" | "cleanup";
export type WorkStatus = "pending" | "leased" | "succeeded" | "retry" | "blocked" | "failed" | "cancelled";
export type TargetStatus = "pending" | "queued" | "processing" | "satisfied" | "ready" | "blocked" | "failed" | "cancelled" | "skipped" | "stale";

export type SourceIdentity = {
  readonly fileId: string;
  readonly userId: string;
  readonly version: number;
  readonly r2Key: string;
  readonly mimeType: string;
  readonly encrypted: boolean;
  readonly deletedAt: Date | null;
  readonly durationMs: number | null;
  /** Required on rows returned by keyset backfill scans. */
  readonly createdAt?: Date;
};

export type PipelineRun = {
  readonly id: string;
  readonly fileId: string;
  readonly userId: string;
  readonly sourceVersion: number;
  readonly sourceR2Key: string;
  readonly sourceMimeType: string;
  readonly policyVersion: number;
  readonly requestKey: string;
  readonly localeSetHash: string;
  readonly status: PipelineRunStatus;
  readonly stage: PipelineStage;
  readonly durationMs: number | null;
  readonly plannerCursorMs: number;
  readonly plannedThroughMs: number;
  readonly totalWorkItems: number;
  readonly completedWorkItems: number;
  readonly progress: number;
  readonly unsupportedCode: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
};

export type PipelineTarget = {
  readonly id: string;
  readonly runId: string;
  readonly language: string;
  readonly kind: "automatic" | "manual";
  readonly status: TargetStatus;
};

export type WorkItem = {
  readonly id: string;
  readonly runId: string;
  readonly targetId: string | null;
  readonly userId: string;
  readonly kind: WorkKind;
  readonly status: WorkStatus;
  readonly idempotencyKey: string;
  readonly ordinal: number | null;
  readonly cursorStartMs: number | null;
  readonly cursorEndMs: number | null;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly deliverySequence: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly fencingToken: number;
  readonly outputCheckpoint: Record<string, unknown> | null;
};

export type WorkSeed = Pick<WorkItem, "runId" | "targetId" | "userId" | "kind" | "idempotencyKey" | "ordinal" | "cursorStartMs" | "cursorEndMs"> & {
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
};

export type OutboxMessage = {
  readonly workItemId: string;
  readonly deliverySequence: number;
  readonly queueKey: string;
  readonly kind: WorkKind;
};

export type ClaimedWork = WorkItem & {
  readonly status: "leased";
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
};

export type WorkLease = Pick<ClaimedWork, "id" | "leaseOwner" | "fencingToken">;

export type EnsureRunSeed = {
  readonly source: SourceIdentity;
  readonly policyVersion: number;
  readonly requestKey: string;
  readonly localeSetHash: string;
  readonly targets: readonly string[];
  readonly status: "queued" | "unsupported";
  readonly unsupportedCode?: string;
  readonly now: Date;
};

export interface SubtitlePipelineStore {
  loadSource(fileId: string): Promise<SourceIdentity | null>;
  ensureRun(seed: EnsureRunSeed): Promise<{ run: PipelineRun; created: boolean }>;
  getRun(runId: string): Promise<PipelineRun | null>;
  listTargets(runId: string): Promise<readonly PipelineTarget[]>;
  addAutomaticTargets(runId: string, languages: readonly string[], localeSetHash: string, now: Date): Promise<number>;
  createWork(seeds: readonly WorkSeed[], now: Date): Promise<readonly WorkItem[]>;
  getWorkItem(id: string): Promise<WorkItem | null>;
  claimWorkItem(input: { workItemId: string; workerId: string; now: Date; leaseMs: number }): Promise<ClaimedWork | null>;
  advancePlan(runId: string, expectedCursorMs: number, nextCursorMs: number, stage: PipelineStage, now: Date): Promise<boolean>;
  claimDueWork(input: { workerId: string; now: Date; leaseMs: number; limit: number }): Promise<readonly ClaimedWork[]>;
  heartbeat(lease: WorkLease, now: Date, leaseMs: number): Promise<boolean>;
  complete(lease: WorkLease, checkpoint: Record<string, unknown> | null, now: Date): Promise<boolean>;
  retry(lease: WorkLease, failure: { code: string; message: string; availableAt: Date }, now: Date): Promise<"retry" | "failed" | "lost">;
  revalidateSource(run: PipelineRun): Promise<SourceIdentity | null>;
  invalidateRun(runId: string, code: string, message: string, now: Date): Promise<boolean>;
  listUndiscoveredSources(cursor: BackfillCursor | null, limit: number): Promise<readonly SourceIdentity[]>;
  enqueueOutbox(limit: number, enqueue: (message: OutboxMessage) => Promise<void>): Promise<number>;
}

export type BackfillCursor = { readonly createdAt: Date; readonly fileId: string };
