import Redis from "ioredis";
import { Queue } from "bullmq";

export const QUEUE_NAME = "storage-jobs";

let queue: Queue | null = null;

function getRedisConnection() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

export function getQueue(): Queue | null {
  if (process.env.REDIS_DISABLED === "true") return null;

  if (!queue) {
    try {
      queue = new Queue(QUEUE_NAME, {
        connection: getRedisConnection() as unknown as import("bullmq").ConnectionOptions,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      });
      queue.on("error", () => {});
    } catch {
      return null;
    }
  }
  return queue;
}

export type JobType =
  | "generate_thumbnail"
  | "compress_image"
  | "trim_media"
  | "recalculate_quota"
  | "deliver_webhook"
  | "cleanup_schedules"
  | "build_archive"
  | "process_deletion"
  // Second Brain enrichment (P1). Both are idempotent: a duplicate job is a no-op
  // once the memory's content hash already matches what was enriched.
  | "enrich_memory"
  | "enrich_brain"
  // PHASE 2: Derived relationship computation. Idempotent via contentHash staleness check.
  | "relate_memory"
  | "relate_brain";

export async function enqueueJob(
  type: JobType,
  data: Record<string, unknown> = {},
  opts?: { jobId?: string; repeat?: { every: number } }
): Promise<boolean> {
  try {
    const q = getQueue();
    if (!q) return false;
    await q.add(type, { type, ...data }, opts);
    return true;
  } catch {
    // Jobs are optional in dev without Redis
    return false;
  }
}

/** Ensure hourly cleanup repeatable job is registered. */
export async function ensureCleanupSchedule(): Promise<void> {
  try {
    const q = getQueue();
    if (!q) return;
    await q.add(
      "cleanup_schedules",
      { type: "cleanup_schedules" },
      {
        jobId: "cleanup-schedules-hourly",
        repeat: { every: 60 * 60 * 1000 },
        removeOnComplete: 20,
        removeOnFail: 20,
      }
    );
  } catch {
    // ignore
  }
}
