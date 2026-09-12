import Redis from "ioredis";
import { Worker, type Job } from "bullmq";
import {
  SUBTITLE_QUEUE_NAMES,
  type SubtitleQueueRole,
} from "@/shared/infrastructure/queue";

export type SubtitleJobHandler = (job: Job) => Promise<void>;
export type SubtitleHandlerRegistry = Readonly<Record<string, SubtitleJobHandler>>;

const DEFAULT_CONCURRENCY: Record<SubtitleQueueRole, number> = {
  control: 2,
  prepare: 1,
  asr: 1,
  translate: 2,
};
const MAX_CONCURRENCY = 128;

export function workerConcurrency(
  role: SubtitleQueueRole,
  env: Record<string, string | undefined> = process.env
): number {
  const key = `SUBTITLE_${role.toUpperCase()}_CONCURRENCY`;
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONCURRENCY[role];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new Error(`${key} must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  return value;
}

export async function dispatchRegisteredHandler(
  job: Job,
  handlers: SubtitleHandlerRegistry
): Promise<void> {
  const type =
    typeof (job.data as { type?: unknown } | null)?.type === "string"
      ? (job.data as { type: string }).type
      : job.name;
  const handler = handlers[type];
  if (!handler) throw new Error(`No handler registered for subtitle job type ${type}`);
  await handler(job);
}

type StartOptions = {
  role: SubtitleQueueRole;
  handlers: SubtitleHandlerRegistry;
  concurrency?: number;
};

/** Start one queue-specific process. Job logs contain IDs only, never payloads or credentials. */
export async function startSubtitleWorker(options: StartOptions): Promise<void> {
  if (process.env.REDIS_DISABLED === "true") {
    console.log(`Subtitle ${options.role} worker skipped: REDIS_DISABLED=true`);
    return;
  }

  const redisConn = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  const concurrency = options.concurrency ?? workerConcurrency(options.role);
  const queueName = SUBTITLE_QUEUE_NAMES[options.role];
  const worker = new Worker(
    queueName,
    (job) => dispatchRegisteredHandler(job, options.handlers),
    { connection: redisConn as unknown as import("bullmq").ConnectionOptions, concurrency }
  );

  worker.on("completed", (job) => {
    console.log(`Subtitle ${options.role} job ${job.id ?? "unknown"} completed`);
  });
  worker.on("failed", (job, error) => {
    console.error(
      `Subtitle ${options.role} job ${job?.id ?? "unknown"} failed: ${error.message}`
    );
  });
  worker.on("error", (error) => {
    console.error(`Subtitle ${options.role} worker error: ${error.message}`);
  });

  let closing: Promise<void> | null = null;
  const close = (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return closing;
    console.log(`Subtitle ${options.role} worker received ${signal}; closing`);
    closing = (async () => {
      try {
        await worker.close();
      } finally {
        await redisConn.quit().catch(() => redisConn.disconnect());
      }
      process.exitCode = 0;
    })();
    return closing;
  };

  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
  console.log(
    `Subtitle ${options.role} worker started on ${queueName} (concurrency=${concurrency})`
  );
}
