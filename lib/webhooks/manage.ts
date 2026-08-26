import { randomBytes } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhooks } from "@/lib/db/schema";
import { parseWebhookUrl } from "@/lib/webhooks/ssrf";

export const WEBHOOK_EVENTS = ["upload", "delete", "share"] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export const MAX_WEBHOOKS_PER_USER = 10;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/** Public shape (secret included — it's the user's own, shown so they can verify HMAC). */
export type WebhookRow = typeof webhooks.$inferSelect;

export async function listWebhooks(userId: string): Promise<WebhookRow[]> {
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.userId, userId))
    .orderBy(desc(webhooks.createdAt));
}

export async function countWebhooks(userId: string): Promise<number> {
  const rows = await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.userId, userId));
  return rows.length;
}

export async function createWebhook(input: {
  userId: string;
  url: string;
  events: WebhookEventName[];
}): Promise<WebhookRow> {
  const [row] = await db
    .insert(webhooks)
    .values({
      userId: input.userId,
      url: input.url,
      secret: generateWebhookSecret(),
      events: input.events.length ? input.events : [...WEBHOOK_EVENTS],
      enabled: true,
    })
    .returning();
  return row;
}

/** Owner-scoped fetch — returns null if the webhook isn't this user's. */
export async function getOwnedWebhook(userId: string, id: string): Promise<WebhookRow | null> {
  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function updateWebhook(
  userId: string,
  id: string,
  patch: { url?: string; events?: WebhookEventName[]; enabled?: boolean }
): Promise<WebhookRow | null> {
  const [row] = await db
    .update(webhooks)
    .set({
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: patch.events } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    })
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteWebhook(userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
    .returning({ id: webhooks.id });
  return deleted.length > 0;
}

/**
 * Synchronous shape check kept for callers that only need to reject a malformed
 * or obviously-internal URL without touching DNS.
 *
 * It is NOT sufficient on its own: a hostname that resolves to a private
 * address passes here. Anything that is about to open a socket must go through
 * `assertSafeWebhookTarget` / `fetchWebhook` in `lib/webhooks/ssrf.ts`.
 */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const parsed = parseWebhookUrl(raw);
  return parsed.ok ? { ok: true, url: parsed.url } : { ok: false, error: parsed.error };
}
