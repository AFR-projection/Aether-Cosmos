import { requireMaster, AuthError } from "@/shared/lib/auth/session";
import { subscribeAdmins, type AdminRealtimeEvent } from "@/shared/infrastructure/realtime/events";
import { apiError, handleApiError } from "@/shared/api/response";
import { SECURITY_HEADERS } from "@/shared/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Master-only Server-Sent Events stream for the admin panel. Broadcasts user
 * lifecycle/presence signals (register, verify, update, delete, login) so the
 * User Management page can refetch the moment something changes anywhere.
 *
 * Mirrors GET /api/events (the per-user stream): same heartbeat/cleanup/headers.
 * EventSource cannot send custom headers, so auth is cookie-session based via
 * requireMaster() — the role is verified server-side here.
 */
const HEARTBEAT_MS = 25_000;

function encodeSse(event: AdminRealtimeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET() {
  try {
    await requireMaster();

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

        const send = (event: AdminRealtimeEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSse(event));
          } catch {
            cleanup();
          }
        };

        unsubscribe = subscribeAdmins(send);

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
