"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AdminRealtimeEvent } from "@/shared/infrastructure/realtime/types";

export type AdminLiveStatus = "connecting" | "live" | "reconnecting" | "offline";

/**
 * Subscribes the admin panel to GET /api/admin/events (SSE) and invalidates the
 * given React Query key whenever a user lifecycle/presence event arrives, so the
 * list refetches within a moment of any change anywhere.
 *
 * Mirrors the reconnect/backoff shape of `useRealtimeEvents`. Events are just
 * "something changed" signals — we debounce and invalidate rather than patch
 * state, keeping the server as the single source of truth (no drift).
 */
export function useAdminEvents(
  queryKey: readonly unknown[] = ["admin-users"],
  enabled = true
): AdminLiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AdminLiveStatus>("connecting");

  const attemptRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest key in a ref so reconnects don't need to re-run the effect.
  const keyRef = useRef(queryKey);
  useEffect(() => {
    keyRef.current = queryKey;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const clearReconnect = () => {
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };

    const scheduleInvalidate = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: keyRef.current as unknown[] });
      }, 400);
    };

    const connect = () => {
      if (cancelled) return;
      clearReconnect();

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setStatus("offline");
        return;
      }

      setStatus(attemptRef.current > 0 ? "reconnecting" : "connecting");

      const es = new EventSource("/api/admin/events");
      esRef.current = es;

      es.onopen = () => {
        attemptRef.current = 0;
        setStatus("live");
      };

      es.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as AdminRealtimeEvent;
          if (event.type === "heartbeat") return;
          scheduleInvalidate();
        } catch {
          // ignore malformed payloads
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (cancelled) return;

        attemptRef.current += 1;
        setStatus(
          typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "reconnecting"
        );
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attemptRef.current, 5));
        reconnectRef.current = setTimeout(connect, delay);
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
      clearReconnect();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      window.removeEventListener("online", onOnline);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [enabled, queryClient]);

  return status;
}
