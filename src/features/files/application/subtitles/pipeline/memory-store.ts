import { randomUUID } from "node:crypto";
import type {
  BackfillCursor,
  ClaimedWork,
  EnsureRunSeed,
  OutboxMessage,
  PipelineRun,
  PipelineTarget,
  SourceIdentity,
  SubtitlePipelineStore,
  WorkItem,
  WorkLease,
  WorkSeed,
} from "./contracts";

export class MemorySubtitlePipelineStore implements SubtitlePipelineStore {
  readonly sources = new Map<string, SourceIdentity>();
  readonly runs = new Map<string, PipelineRun>();
  readonly targets = new Map<string, PipelineTarget>();
  readonly work = new Map<string, WorkItem>();

  constructor(sources: readonly SourceIdentity[] = []) {
    for (const source of sources) this.sources.set(source.fileId, source);
  }

  async loadSource(fileId: string) { return this.sources.get(fileId) ?? null; }
  async getRun(runId: string) { return this.runs.get(runId) ?? null; }
  async listTargets(runId: string) { return [...this.targets.values()].filter((item) => item.runId === runId); }

  async ensureRun(seed: EnsureRunSeed) {
    const existing = [...this.runs.values()].find((item) => item.requestKey === seed.requestKey);
    if (existing) return { run: existing, created: false };
    const run: PipelineRun = {
      id: randomUUID(), fileId: seed.source.fileId, userId: seed.source.userId,
      sourceVersion: seed.source.version, sourceR2Key: seed.source.r2Key,
      sourceMimeType: seed.source.mimeType, policyVersion: seed.policyVersion,
      requestKey: seed.requestKey, localeSetHash: seed.localeSetHash, status: seed.status,
      stage: "ensure", durationMs: seed.source.durationMs, plannerCursorMs: 0, plannedThroughMs: 0,
      totalWorkItems: seed.status === "queued" ? 1 : 0, completedWorkItems: 0, progress: 0,
      unsupportedCode: seed.unsupportedCode ?? null, failureCode: null, failureMessage: null,
    };
    this.runs.set(run.id, run);
    for (const language of seed.targets) this.insertTarget(run.id, language, seed.status === "unsupported" ? "blocked" : "pending");
    if (seed.status === "queued") await this.createWork([{
      runId: run.id, targetId: null, userId: run.userId, kind: "control",
      idempotencyKey: `${run.requestKey}:control:-:-`, ordinal: null, cursorStartMs: null, cursorEndMs: null,
    }], seed.now, false);
    return { run, created: true };
  }

  private insertTarget(runId: string, language: string, status: PipelineTarget["status"]): PipelineTarget {
    const existing = [...this.targets.values()].find((item) => item.runId === runId && item.language === language);
    if (existing) return existing;
    const item: PipelineTarget = { id: randomUUID(), runId, language, kind: "automatic", status };
    this.targets.set(item.id, item);
    return item;
  }

  async addAutomaticTargets(runId: string, languages: readonly string[], localeSetHash: string) {
    let added = 0;
    for (const language of languages) {
      const before = this.targets.size;
      this.insertTarget(runId, language, "pending");
      if (this.targets.size > before) added += 1;
    }
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, localeSetHash });
    return added;
  }

  async getWorkItem(id: string): Promise<WorkItem | null> {
    return this.work.get(id) ?? null;
  }

  async claimWorkItem(input: { workItemId: string; workerId: string; now: Date; leaseMs: number }): Promise<ClaimedWork | null> {
    const item = this.work.get(input.workItemId);
    if (!item || input.leaseMs < 1) return null;
    const run = this.runs.get(item.runId);
    if (!run || !["queued", "running"].includes(run.status)) return null;
    const available = item.availableAt <= input.now && item.attemptCount < item.maxAttempts;
    const claimable = (["pending", "retry"].includes(item.status) && available) ||
      (item.status === "leased" && item.leaseExpiresAt !== null && item.leaseExpiresAt <= input.now);
    if (!claimable) return null;
    const claimed: ClaimedWork = {
      ...item, status: "leased", leaseOwner: input.workerId,
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), fencingToken: item.fencingToken + 1,
      attemptCount: item.attemptCount + 1, deliverySequence: item.deliverySequence + 1,
    };
    this.work.set(item.id, claimed);
    return claimed;
  }

  async createWork(seeds: readonly WorkSeed[], now: Date, updateCount = true): Promise<readonly WorkItem[]> {
    const created: WorkItem[] = [];
    for (const seed of seeds) {
      if ([...this.work.values()].some((item) => item.idempotencyKey === seed.idempotencyKey)) continue;
      const item: WorkItem = { id: randomUUID(), ...seed, status: "pending", availableAt: seed.availableAt ?? now,
        attemptCount: 0, maxAttempts: seed.maxAttempts ?? 8, deliverySequence: 0,
        leaseOwner: null, leaseExpiresAt: null, fencingToken: 0, outputCheckpoint: null };
      this.work.set(item.id, item); created.push(item);
      if (updateCount) {
        const run = this.runs.get(item.runId);
        if (run) this.runs.set(run.id, { ...run, totalWorkItems: run.totalWorkItems + 1 });
      }
    }
    return created;
  }

  async advancePlan(runId: string, expected: number, next: number, stage: PipelineRun["stage"]) {
    const run = this.runs.get(runId);
    if (!run || run.plannerCursorMs !== expected || !["queued", "running"].includes(run.status)) return false;
    this.runs.set(runId, { ...run, plannerCursorMs: next, plannedThroughMs: next, stage, status: "running" });
    return true;
  }

  async claimDueWork(input: { workerId: string; now: Date; leaseMs: number; limit: number }) {
    const eligible = [...this.work.values()].filter((item) =>
      ((["pending", "retry"].includes(item.status) && item.availableAt <= input.now) ||
       (item.status === "leased" && item.leaseExpiresAt !== null && item.leaseExpiresAt <= input.now)) &&
      item.attemptCount < item.maxAttempts && ["queued", "running"].includes(this.runs.get(item.runId)?.status ?? ""));
    const byUser = new Map<string, WorkItem[]>();
    for (const item of eligible) byUser.set(item.userId, [...(byUser.get(item.userId) ?? []), item]);
    for (const items of byUser.values()) items.sort(compareWork);
    const selected: WorkItem[] = [];
    for (let rank = 0; selected.length < input.limit; rank += 1) {
      const round = [...byUser.values()].map((items) => items[rank]).filter(Boolean).sort(compareWork);
      if (round.length === 0) break;
      selected.push(...round.slice(0, input.limit - selected.length));
    }
    return selected.map((item): ClaimedWork => {
      const claimed = { ...item, status: "leased" as const, leaseOwner: input.workerId,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs), fencingToken: item.fencingToken + 1,
        attemptCount: item.attemptCount + 1, deliverySequence: item.deliverySequence + 1 };
      this.work.set(item.id, claimed); return claimed;
    });
  }

  async heartbeat(lease: WorkLease, now: Date, leaseMs: number) {
    const item = this.validLease(lease, now); if (!item) return false;
    this.work.set(item.id, { ...item, leaseExpiresAt: new Date(now.getTime() + leaseMs) }); return true;
  }

  async complete(lease: WorkLease, checkpoint: Record<string, unknown> | null, now: Date) {
    const item = this.validLease(lease, now); if (!item) return false;
    this.work.set(item.id, { ...item, status: "succeeded", leaseOwner: null, leaseExpiresAt: null,
      outputCheckpoint: checkpoint });
    const run = this.runs.get(item.runId);
    if (run) this.runs.set(run.id, { ...run, completedWorkItems: run.completedWorkItems + 1 });
    return true;
  }

  async retry(lease: WorkLease, _failure: { code: string; message: string; availableAt: Date }, now: Date) {
    const item = this.validLease(lease, now); if (!item) return "lost" as const;
    const status = item.attemptCount >= item.maxAttempts ? "failed" as const : "retry" as const;
    this.work.set(item.id, { ...item, status, availableAt: _failure.availableAt, leaseOwner: null, leaseExpiresAt: null });
    return status;
  }

  private validLease(lease: WorkLease, now: Date): WorkItem | null {
    const item = this.work.get(lease.id);
    return item?.status === "leased" && item.leaseOwner === lease.leaseOwner &&
      item.fencingToken === lease.fencingToken && item.leaseExpiresAt !== null && item.leaseExpiresAt > now ? item : null;
  }

  async revalidateSource(run: PipelineRun) { return this.loadSource(run.fileId); }
  async invalidateRun(runId: string, code: string, message: string) {
    const run = this.runs.get(runId); if (!run || !["queued", "running", "blocked"].includes(run.status)) return false;
    this.runs.set(runId, { ...run, status: "stale", failureCode: code, failureMessage: message });
    for (const [id, item] of this.work) if (item.runId === runId && !["succeeded", "failed", "cancelled"].includes(item.status))
      this.work.set(id, { ...item, status: "cancelled", leaseOwner: null, leaseExpiresAt: null });
    return true;
  }

  async listUndiscoveredSources(cursor: BackfillCursor | null, limit: number) {
    return [...this.sources.values()].filter((item) => {
      if (!item.createdAt) return false;
      return !cursor || item.createdAt > cursor.createdAt ||
        (item.createdAt.getTime() === cursor.createdAt.getTime() && item.fileId > cursor.fileId);
    }).sort((a, b) => (a.createdAt!.getTime() - b.createdAt!.getTime()) || a.fileId.localeCompare(b.fileId)).slice(0, limit);
  }

  async enqueueOutbox(limit: number, enqueue: (message: OutboxMessage) => Promise<void>) {
    const due = [...this.work.values()].filter((item) => ["pending", "retry"].includes(item.status))
      .sort(compareWork).slice(0, limit);
    for (const item of due) {
      const next = item.deliverySequence + 1;
      this.work.set(item.id, { ...item, deliverySequence: next });
      await enqueue({ workItemId: item.id, deliverySequence: next, queueKey: `subtitle-work:${item.id}:${next}`, kind: item.kind });
    }
    return due.length;
  }
}

function compareWork(a: WorkItem, b: WorkItem): number {
  return a.availableAt.getTime() - b.availableAt.getTime() || a.id.localeCompare(b.id);
}
