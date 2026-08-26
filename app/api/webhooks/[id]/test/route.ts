import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhooks } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { getOwnedWebhook } from "@/lib/webhooks/manage";
import { fetchWebhook } from "@/lib/webhooks/ssrf";
import { WEBHOOK_USER_AGENT } from "@/lib/webhooks/constants";
import { APP_NAME } from "@/lib/app-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a signed test event to the webhook, synchronously, so the user gets
 * immediate feedback. Uses the exact same HMAC scheme as the worker's real
 * deliveries (X-Webhook-Signature: sha256=<hex>).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const { id } = await params;

    const hook = await getOwnedWebhook(userId, id);
    if (!hook) return apiError("Webhook not found", 404);

    const body = JSON.stringify({
      event: "ping",
      timestamp: new Date().toISOString(),
      data: { message: `Test event from ${APP_NAME}`, webhookId: hook.id },
    });
    const signature = createHmac("sha256", hook.secret).update(body).digest("hex");

    let status: number | null = null;
    let ok = false;
    let errorMessage: string | null = null;

    try {
      // Stored URLs are re-validated at send time: the row may predate the
      // current policy, and DNS can have moved under it since creation.
      const res = await fetchWebhook(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": `sha256=${signature}`,
          "X-Webhook-Event": "ping",
          "User-Agent": WEBHOOK_USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      ok = res.ok;
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Delivery failed";
    }

    // Record the attempt so the UI's "last delivery" reflects the test too.
    await db
      .update(webhooks)
      .set({ lastDeliveryAt: new Date(), lastStatus: status })
      .where(eq(webhooks.id, hook.id));

    return apiSuccess({ ok, status, error: errorMessage });
  } catch (error) {
    return handleApiError(error);
  }
}
