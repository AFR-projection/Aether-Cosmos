import { and, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { webhooks } from "@/shared/infrastructure/db/schema";
import { enqueueJob } from "@/shared/infrastructure/queue";

export type WebhookEvent = "upload" | "delete" | "share";

/**
 * Enqueue webhook delivery jobs for all enabled webhooks subscribed to the event.
 */
export async function dispatchWebhookEvent(
  userId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const hooks = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.userId, userId), eq(webhooks.enabled, true)));

  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  for (const hook of hooks) {
    if (!hook.events.includes(event)) continue;
    await enqueueJob("deliver_webhook", {
      webhookId: hook.id,
      url: hook.url,
      secret: hook.secret,
      body,
    });
  }
}
