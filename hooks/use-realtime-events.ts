"use client";

import { useEffect, useRef } from "react";
import type { RealtimeEvent } from "@/lib/realtime/types";
import { notify, setConnectionStatus, showSystemToast } from "@/lib/system/notify-store";
import { consumeLocalUpload } from "@/lib/system/local-upload-registry";

const SESSION_ID_KEY = "storage_current_session_id";

/** Persist opaque session id for realtime force-logout matching. */
export function rememberCurrentSessionId(sessionId: string | null | undefined): void {
  try {
    if (!sessionId) {
      sessionStorage.removeItem(SESSION_ID_KEY);
      return;
    }
    sessionStorage.setItem(SESSION_ID_KEY, sessionId);
  } catch {
    // ignore
  }
}

export function readRememberedSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_ID_KEY);
  } catch {
    return null;
  }
}

function forceLogout(reason: string): void {
  try {
    sessionStorage.removeItem(SESSION_ID_KEY);
  } catch {
    // ignore
  }
  const alert =
    reason === "ip" ? "SESSION_IP_CHANGED" : "SESSION_REVOKED";
  window.location.href = `/login?alert=${alert}`;
}

function shouldForceLogout(event: Extract<RealtimeEvent, { type: "session_revoked" }>): boolean {
  if (event.wasCurrent) return true;
  if (event.reason === "revoke_all" || event.reason === "admin_revoke_all") return true;
  if (event.reason === "revoke_current" || event.reason === "ip_change") return true;
  if (event.sessionId) {
    const mine = readRememberedSessionId();
    if (mine && mine === event.sessionId) return true;
  }
  return false;
}

/** @deprecated Prefer `notify()` — kept for call-site compatibility. */
export function showRealtimeToast(message: string, durationMs = 4200): void {
  showSystemToast(message, durationMs);
}

function toastForEvent(
  event: RealtimeEvent
): { title: string; description?: string; tone?: "info" | "success" | "warning" | "system" } | null {
  switch (event.type) {
    case "upload_complete":
      // Suppress the realtime toast for files uploaded in THIS tab — the upload
      // panel already shows a batch-summary toast, so showing both is redundant.
      // Uploads from other devices still surface here (that's the whole point).
      if (consumeLocalUpload(event.fileId)) return null;
      return {
        title: "Upload complete",
        description: event.name,
        tone: "success",
      };
    case "share_access":
      return {
        title: "Share accessed",
        description: event.fileName,
        tone: "info",
      };
    case "session_revoked":
      if (shouldForceLogout(event)) return null; // redirect handles UX
      return {
        title: "Session updated",
        description:
          event.reason === "revoke_others"
            ? "Other devices were signed out"
            : event.reason === "admin_revoke_one"
              ? "An admin revoked one of your sessions"
              : "A session was revoked",
        tone: "warning",
      };
    case "heartbeat":
      return null;
    default:
      return null;
  }
}

/**
 * Connects to GET /api/events (SSE) while authenticated.
 * Updates connection status + elegant system toasts.
 * Force-logs out this browser when its session is revoked remotely.
 */
export function useRealtimeEvents(enabled = true): void {
  const attemptRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcedLive = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const connect = () => {
      if (cancelled) return;
      clearTimer();

      // Always retire the previous stream first. Without this, a network
      // handover that fires `online` before the old EventSource errors leaves
      // that socket open forever — on a phone with flaky signal they stack up,
      // each one holding a server connection and its heartbeat timer.
      if (esRef.current) {
        esRef.current.onopen = null;
        esRef.current.onmessage = null;
        esRef.current.onerror = null;
        esRef.current.close();
        esRef.current = null;
      }

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setConnectionStatus("offline");
        return;
      }

      setConnectionStatus(attemptRef.current > 0 ? "reconnecting" : "connecting");

      const es = new EventSource("/api/events");
      esRef.current = es;

      es.onopen = () => {
        const wasReconnect = attemptRef.current > 0;
        attemptRef.current = 0;
        setConnectionStatus("live");
        if (wasReconnect || !announcedLive.current) {
          announcedLive.current = true;
          if (wasReconnect) {
            notify({
              title: "Reconnected",
              description: "Live updates are back.",
              tone: "success",
              duration: 2800,
            });
          }
        }
      };

      es.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as RealtimeEvent;
          if (event.type === "session_revoked" && shouldForceLogout(event)) {
            const reason =
              event.reason === "ip_change"
                ? "ip"
                : event.reason === "admin_revoke_all" || event.reason === "admin_revoke_one"
                  ? "revoked"
                  : "revoked";
            forceLogout(reason);
            return;
          }
          const text = toastForEvent(event);
          if (text) {
            notify({
              title: text.title,
              description: text.description,
              tone: text.tone ?? "system",
            });
          }
        } catch {
          // ignore malformed
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (cancelled) return;

        attemptRef.current += 1;
        setConnectionStatus(
          typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "reconnecting"
        );
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attemptRef.current, 5));
        timerRef.current = setTimeout(connect, delay);
      };
    };

    const onOnline = () => {
      if (cancelled) return;
      attemptRef.current = Math.max(attemptRef.current, 1);
      connect();
    };

    window.addEventListener("online", onOnline);
    connect();

    return () => {
      cancelled = true;
      clearTimer();
      window.removeEventListener("online", onOnline);
      esRef.current?.close();
      esRef.current = null;
      setConnectionStatus("idle");
    };
  }, [enabled]);
}
