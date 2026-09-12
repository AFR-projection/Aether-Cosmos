import type { Job } from "bullmq";
import { SUBTITLE_WORK_JOB_NAME } from "@/shared/infrastructure/queue";
import type { SubtitleHandlerRegistry } from "./runtime";

export type SubtitleWorkHandler = (delivery: {
  workItemId: string;
  deliverySequence: number;
}) => Promise<void>;

function deliveryFrom(job: Job): { workItemId: string; deliverySequence: number } {
  const data = job.data as { workItemId?: unknown; deliverySequence?: unknown };
  if (typeof data.workItemId !== "string" || data.workItemId.length === 0) {
    throw new Error("Subtitle work delivery is missing workItemId");
  }
  if (!Number.isSafeInteger(data.deliverySequence) || Number(data.deliverySequence) < 0) {
    throw new Error("Subtitle work delivery has an invalid deliverySequence");
  }
  return { workItemId: data.workItemId, deliverySequence: Number(data.deliverySequence) };
}

/** Keep runtime registration independent from bounded application-stage implementations. */
export function workDeliveryHandlers(handle: SubtitleWorkHandler): SubtitleHandlerRegistry {
  return { [SUBTITLE_WORK_JOB_NAME]: async (job) => handle(deliveryFrom(job)) };
}

export async function loadSubtitleWorkHandler(): Promise<SubtitleWorkHandler> {
  const modulePath = process.env.SUBTITLE_WORK_HANDLER_MODULE?.trim();
  if (!modulePath) {
    return async ({ workItemId }) => {
      throw new Error(`No application handler registered for subtitle work item ${workItemId}`);
    };
  }
  const loaded = (await import(modulePath)) as { handleSubtitleWork?: unknown };
  if (typeof loaded.handleSubtitleWork !== "function") {
    throw new Error(`${modulePath} must export handleSubtitleWork`);
  }
  return loaded.handleSubtitleWork as SubtitleWorkHandler;
}

export async function registeredWorkDeliveryHandlers(): Promise<SubtitleHandlerRegistry> {
  return workDeliveryHandlers(await loadSubtitleWorkHandler());
}
