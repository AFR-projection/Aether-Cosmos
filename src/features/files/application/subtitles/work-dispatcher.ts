import { randomUUID } from "node:crypto";
import { enqueueSubtitleWorkKind } from "@/shared/infrastructure/queue";
import type {
  ClaimedWork,
  PipelineRun,
  SubtitlePipelineStore,
  WorkItem,
  WorkKind,
} from "./pipeline/contracts";
import {
  planNextSubtitleWindow,
  retryDelayMs,
  workKey,
} from "./pipeline/ledger";

/**
 * The control-stage state machine behind `SUBTITLE_WORK_HANDLER_MODULE`.
 *
 * BullMQ only delivers `(workItemId, deliverySequence)`. This module claims the
 * ledger row with a fencing lease, fans out the next bounded page of work, and
 * resolves terminal checkpoint rows. It stays free of ffmpeg, R2, and provider
 * calls: per-range ASR/translation work belongs in separate `workKind` stages
 * wired by the worker image, not here.
 *
 * A `deliverySequence` that no longer matches the claimed row is a duplicate
 * redelivery, not an error: the lease was already advanced by an earlier pickup.
 */

export const SUBTITLE_WORK_LEASE_MS = 5 * 60_000;

export type SubtitleWorkDelivery = {
  readonly workItemId: string;
  readonly deliverySequence?: number;
};

/** Parse dispatcher delivery payloads; the worker envelope only ever carries these keys. */
export function subtitleDeliveryFrom(
  data: unknown
): { workItemId: string; deliverySequence: number } {
  const payload = data as { workItemId?: unknown; deliverySequence?: unknown } | null;
  if (typeof payload?.workItemId !== "string" || payload.workItemId.length === 0) {
    throw new Error("Subtitle work delivery is missing workItemId");
  }
  if (!Number.isSafeInteger(payload.deliverySequence) || Number(payload.deliverySequence) < 0) {
    throw new Error("Subtitle work delivery has an invalid deliverySequence");
  }
  return { workItemId: payload.workItemId, deliverySequence: Number(payload.deliverySequence) };
}

export type StageHandler = (
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  run: PipelineRun,
  now: Date,
  workerId: string
) => Promise<void>;

export type StageHandlers = Partial<Record<WorkKind, StageHandler>>;

async function retryLease(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  code: string,
  message: string,
  now: Date
): Promise<void> {
  const lease = {
    id: claimed.id,
    leaseOwner: claimed.leaseOwner,
    fencingToken: claimed.fencingToken,
  };
  const delay = retryDelayMs(claimed.attemptCount);
  await store.retry(
    lease,
    { code, message, availableAt: new Date(now.getTime() + delay) },
    now
  );
}

async function controlStep(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  now: Date,
  workerId: string
): Promise<void> {
  const lease = {
    id: claimed.id,
    leaseOwner: claimed.leaseOwner,
    fencingToken: claimed.fencingToken,
  };
  const run = await store.getRun(claimed.runId);
  if (!run) {
    // Source run vanished: no cursor can advance, so the work item is terminal.
    await store.complete(lease, { outcome: "run-gone" }, now);
    return;
  }
  if (!["queued", "running"].includes(run.status)) {
    // Invalidated, completed, or blocked runs park their remaining work, not delete it:
    // a later resume or retry re-queues from the persisted cursor.
    await store.retry(
      lease,
      { code: "RUN_NOT_ACTIVE", message: `run is ${run.status}`, availableAt: new Date(now.getTime() + 60_000) },
      now
    );
    return;
  }
  const source = await store.revalidateSource(run);
  if (
    !source ||
    source.encrypted ||
    source.deletedAt ||
    source.version !== run.sourceVersion ||
    source.r2Key !== run.sourceR2Key ||
    source.mimeType !== run.sourceMimeType ||
    source.userId !== run.userId
  ) {
    await store.invalidateRun(run.id, "SOURCE_STALE", "The source changed before subtitle work completed.", now);
    await store.complete(lease, { outcome: "source-stale" }, now);
    return;
  }

  // Source still matches: fan out the next bounded planner page.
  const page = await planNextSubtitleWindow(run.id, store, now);
  const refreshed = await store.getRun(run.id);
  if (!refreshed) {
    await store.complete(lease, { outcome: "run-gone" }, now);
    return;
  }
  // The cursor CAS may lose a race; the winners already wrote the ranges.
  // Either way the ranges are durable in the ledger before this item completes,
  // and the outbox dispatcher enqueues their deliveries.
  await store.complete(lease, { outcome: "planned", nextCursorMs: page.nextCursorMs }, now);

  if (!page.complete) {
    // Self-requeue bounded: one control item continues the cursor, at most 24 ranges ahead.
    await store.createWork(
      [
        {
          runId: run.id,
          targetId: null,
          userId: run.userId,
          kind: "control",
          idempotencyKey: `${workKey(refreshed, "control")}:cursor:${page.nextCursorMs}`,
          ordinal: null,
          cursorStartMs: page.nextCursorMs,
          cursorEndMs: null,
        },
      ],
      now
    );
    void workerId;
  }
}

async function dispatchClaimedWork(
  store: SubtitlePipelineStore,
  claimed: ClaimedWork,
  now: Date,
  workerId: string,
  handlers: StageHandlers
): Promise<void> {
  if (claimed.kind === "control") {
    await controlStep(store, claimed, now, workerId);
    return;
  }
  // Per-range ASR/translate/materialize/publish/cleanup execution belongs in
  // dedicated stage handlers wired by the worker entrypoint; landing here means
  // no stage implementation was registered for the kind.
  const handler = handlers[claimed.kind];
  if (!handler) {
    const lease = {
      id: claimed.id,
      leaseOwner: claimed.leaseOwner,
      fencingToken: claimed.fencingToken,
    };
    await store.retry(
      lease,
      {
        code: "STAGE_UNREGISTERED",
        message: `No handler is registered for subtitle work kind ${claimed.kind}`,
        availableAt: new Date(now.getTime() + 5 * 60_000),
      },
      now
    );
    return;
  }
  const run = await store.getRun(claimed.runId);
  if (!run) {
    const lease = {
      id: claimed.id,
      leaseOwner: claimed.leaseOwner,
      fencingToken: claimed.fencingToken,
    };
    await store.complete(lease, { outcome: "run-gone" }, now);
    return;
  }
  await handler(store, claimed, run, now, workerId);
}

/**
 * Single entrypoint for `SUBTITLE_WORK_HANDLER_MODULE`.
 *
 * Claims the delivered work item, drops duplicate redeliveries whose sequence
 * already advanced, runs the stage step, and converts unexpected throws into a
 * ledger retry with backoff. The only caller-visible side effect besides the
 * ledger is the BullMQ enqueue of the next control page: that call only queues
 * ledger identities, which are already durable before it happens.
 */
export function createHandleSubtitleWork(handlers: StageHandlers) {
  return async function handleSubtitleWork(
    delivery: SubtitleWorkDelivery,
    store: SubtitlePipelineStore,
    input: { workerId?: string; now?: Date; leaseMs?: number } = {}
  ): Promise<void> {
    const { workItemId } = subtitleDeliveryFrom(delivery);
    const workerId = input.workerId ?? `subtitle-${randomUUID()}`;
    const leaseMs = input.leaseMs ?? SUBTITLE_WORK_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new RangeError("leaseMs must be a positive safe integer");
    }
    const now = input.now ?? new Date();
    const claimed = await store.claimWorkItem({ workItemId, workerId, now, leaseMs });
    if (!claimed) {
      // Either a duplicate delivery or an item no longer claimable (run stale,
      // attempts exhausted). Either way there is nothing billable left to do.
      return;
    }
    if (
      typeof delivery.deliverySequence === "number" &&
      delivery.deliverySequence < claimed.deliverySequence - 1
    ) {
      // Redelivery of a sequence this row already moved past: drop without side effects.
      await store.complete(
        { id: claimed.id, leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken },
        { outcome: "duplicate-delivery" },
        now
      );
      return;
    }
    try {
      await dispatchClaimedWork(store, claimed, now, workerId, handlers);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Subtitle work failed";
      await retryLease(store, claimed, "WORK_FAILED", message.slice(0, 500), now);
    }
  };
}

export type QueuedSubtitleDelivery = {
  readonly kind: WorkKind;
  readonly workItemId: WorkItem["id"];
  readonly deliverySequence: number;
};

/** Ledger-identity enqueue for one claimed item, routed to its role queue. */
export async function enqueueClaimedSubtitleWork(item: ClaimedWork): Promise<boolean> {
  return enqueueSubtitleWorkKind(item.kind, {
    workItemId: item.id,
    deliverySequence: item.deliverySequence,
  });
}
