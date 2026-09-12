import Redis from "ioredis";
import { Queue, type JobsOptions } from "bullmq";

export const QUEUE_NAME = "storage-jobs";
export const SUBTITLE_QUEUE_NAMES = {
  control: "subtitle-control",
  prepare: "subtitle-prepare",
  asr: "subtitle-asr",
  translate: "subtitle-translate",
} as const;

export type SubtitleQueueRole = keyof typeof SUBTITLE_QUEUE_NAMES;
export type SubtitleWorkKind =
  | "control"
  | "prepare"
  | "asr"
  | "translate"
  | "materialize"
  | "publish"
  | "cleanup";
export type QueueName = typeof QUEUE_NAME | (typeof SUBTITLE_QUEUE_NAMES)[SubtitleQueueRole];
export type QueueSelector = "storage" | SubtitleQueueRole | QueueName;

export const SUBTITLE_WORK_QUEUE_ROLE: Readonly<Record<SubtitleWorkKind, SubtitleQueueRole>> = {
  control: "control",
  prepare: "prepare",
  asr: "asr",
  translate: "translate",
  materialize: "control",
  publish: "control",
  cleanup: "control",
};

export function queueRoleForSubtitleWork(kind: SubtitleWorkKind): SubtitleQueueRole {
  return SUBTITLE_WORK_QUEUE_ROLE[kind];
}

export type JobType =
  | "generate_thumbnail"
  | "inspect_media"
  | "compress_image"
  | "trim_media"
  | "extract_audio"
  | "recalculate_quota"
  | "deliver_webhook"
  | "cleanup_schedules"
  | "build_archive"
  | "process_deletion"
  | "enrich_memory"
  | "enrich_brain"
  | "relate_memory"
  | "relate_brain"
  | "embed_memory"
  | "embed_brain"
  | "transcribe_media"
  | "translate_subtitles";

export const SUBTITLE_WORK_JOB_NAME = "subtitle_work";
export type SubtitleWorkDelivery = Readonly<{
  workItemId: string;
  deliverySequence: number;
}>;

const queues = new Map<QueueName, Queue>();
const WORK_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function resolveQueueName(selector: QueueSelector = "storage"): QueueName {
  if (selector === "storage" || selector === QUEUE_NAME) return QUEUE_NAME;
  if (selector in SUBTITLE_QUEUE_NAMES) return SUBTITLE_QUEUE_NAMES[selector as SubtitleQueueRole];
  if (Object.values(SUBTITLE_QUEUE_NAMES).includes(selector as never)) return selector as QueueName;
  throw new Error(`Unknown queue selector: ${selector}`);
}

/** Legacy subtitle jobs switch queues without changing their existing enqueueJob call sites. */
export function queueForJob(type: JobType): QueueName {
  if (type === "transcribe_media") return SUBTITLE_QUEUE_NAMES.asr;
  if (type === "translate_subtitles") return SUBTITLE_QUEUE_NAMES.translate;
  return QUEUE_NAME;
}

export function defaultJobOptionsFor(queueName: QueueName): JobsOptions {
  const retention = { removeOnComplete: 100, removeOnFail: 50 };
  return queueName === QUEUE_NAME
    ? { attempts: 3, backoff: { type: "exponential", delay: 2000 }, ...retention }
    : { attempts: 1, ...retention };
}

function redisConnection(): Redis {
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

export function getQueue(selector: QueueSelector = "storage"): Queue | null {
  if (process.env.REDIS_DISABLED === "true") return null;
  const queueName = resolveQueueName(selector);
  const existing = queues.get(queueName);
  if (existing) return existing;
  try {
    const created = new Queue(queueName, {
      connection: redisConnection() as unknown as import("bullmq").ConnectionOptions,
      defaultJobOptions: defaultJobOptionsFor(queueName),
    });
    created.on("error", () => {});
    queues.set(queueName, created);
    return created;
  } catch {
    return null;
  }
}

export type EnqueueJobOptions = Pick<JobsOptions, "jobId" | "repeat"> & {
  queue?: QueueSelector;
};

/** Existing signature remains valid; queue can now be selected explicitly when needed. */
export async function enqueueJob(
  type: JobType,
  data: Record<string, unknown> = {},
  opts?: EnqueueJobOptions
): Promise<boolean> {
  try {
    const queueName = opts?.queue ? resolveQueueName(opts.queue) : queueForJob(type);
    const q = getQueue(queueName);
    if (!q) return false;
    const jobOptions = { ...opts };
    delete jobOptions.queue;
    await q.add(type, { type, ...data }, jobOptions);
    return true;
  } catch {
    return false;
  }
}

export function subtitleWorkJobId(
  role: SubtitleQueueRole,
  delivery: SubtitleWorkDelivery
): string {
  if (!WORK_ITEM_ID.test(delivery.workItemId)) throw new Error("Invalid subtitle work item ID");
  if (!Number.isSafeInteger(delivery.deliverySequence) || delivery.deliverySequence < 0) {
    throw new Error("Invalid subtitle delivery sequence");
  }
  return `subtitle-work-${role}-${delivery.workItemId}-${delivery.deliverySequence}`;
}

/** Deliver only ledger identity; application state, provider config, and content stay out of Redis. */
export async function enqueueSubtitleWork(
  role: SubtitleQueueRole,
  delivery: SubtitleWorkDelivery,
  opts: Pick<JobsOptions, "delay" | "priority"> = {}
): Promise<boolean> {
  try {
    const q = getQueue(role);
    if (!q) return false;
    await q.add(SUBTITLE_WORK_JOB_NAME, delivery, {
      ...opts,
      jobId: subtitleWorkJobId(role, delivery),
      attempts: 1,
    });
    return true;
  } catch {
    return false;
  }
}

export async function enqueueSubtitleWorkKind(
  kind: SubtitleWorkKind,
  delivery: SubtitleWorkDelivery,
  opts: Pick<JobsOptions, "delay" | "priority"> = {}
): Promise<boolean> {
  return enqueueSubtitleWork(queueRoleForSubtitleWork(kind), delivery, opts);
}

export async function closeQueues(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.allSettled(open.map((item) => item.close()));
}

/** Ensure hourly cleanup remains on the storage queue. */
export async function ensureCleanupSchedule(): Promise<void> {
  try {
    const q = getQueue("storage");
    if (!q) return;
    await q.add("cleanup_schedules", { type: "cleanup_schedules" }, {
      jobId: "cleanup-schedules-hourly",
      repeat: { every: 60 * 60 * 1000 },
      removeOnComplete: 20,
      removeOnFail: 20,
    });
  } catch {
    // Jobs are optional in development without Redis.
  }
}
