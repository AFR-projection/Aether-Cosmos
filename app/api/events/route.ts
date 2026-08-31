import { requireAuth, AuthError } from "@/shared/lib/auth/session";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { subscribeUser, type RealtimeEvent } from "@/shared/infrastructure/realtime/events";
import { apiError, handleApiError } from "@/shared/api/response";
import { SECURITY_HEADERS } from "@/shared/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

function encodeSse(event: RealtimeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET() {
  try {
    const user = await requireAuth();

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          unsubscribe?.();
          unsubscribe = null;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        const send = (event: RealtimeEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSse(event));
          } catch {
            cleanup();
          }
        };

        unsubscribe = subscribeUser(getEffectiveUserId(user), send);

        send({ type: "heartbeat", at: Date.now() });

        heartbeatTimer = setInterval(() => {
          send({ type: "heartbeat", at: Date.now() });
        }, HEARTBEAT_MS);
      },
      cancel() {
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
      },
    });

    return new Response(stream, {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return apiError(error.message, error.status);
    }
    return handleApiError(error);
  }
}
