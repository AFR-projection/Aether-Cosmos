"use client";

import { useSyncExternalStore, useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, RefreshCw } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { useFormat, useT } from "@/shared/lib/i18n";
import {
  getConnectionStatus,
  setConnectionStatus,
  subscribeConnectionStatus,
  type ConnectionStatus,
} from "@/shared/lib/system/notify-store";

export function OfflineOverlay() {
  const t = useT();
  const { formatTime } = useFormat();
  const status = useSyncExternalStore(
    subscribeConnectionStatus,
    getConnectionStatus,
    () => "idle" as ConnectionStatus
  );

  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [retrying, setRetrying] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const isOffline = status === "offline";

  useEffect(() => {
    if (isOffline) {
      setLastChecked(new Date());
    }
  }, [isOffline]);

  // `aria-modal` is a promise the overlay has to keep: focus starts inside, Tab
  // cannot leave, and the page behind stops scrolling. Escape deliberately does
  // nothing — being offline is not a state the user can dismiss.
  useEffect(() => {
    if (!isOffline) return;
    const opener = document.activeElement as HTMLElement | null;
    retryRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [isOffline]);

  async function handleRetry() {
    setRetrying(true);
    setLastChecked(new Date());
    try {
      const res = await fetch("/api/auth/csrf", { method: "GET", cache: "no-store" });
      // The probe answering is the news: hand the app back to "connecting" so the
      // overlay lifts instead of waiting for the SSE hook to notice on its own.
      if (res.ok) setConnectionStatus("connecting");
    } catch {
      // fetch failure is expected offline; the SSE hook will reconnect automatically
    } finally {
      setRetrying(false);
    }
  }

  return (
    <AnimatePresence>
      {isOffline && (
        <motion.div
          key="offline-overlay"
          ref={dialogRef}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="offline-overlay-title"
        >
          <div className="text-center max-w-sm w-full">
            <div className="mb-6 mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-muted border border-border">
              <WifiOff className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
            </div>
            <h2 id="offline-overlay-title" className="text-xl font-bold mb-2">
              {t("system.offline.title")}
            </h2>
            <p className="text-muted-foreground text-sm mb-1">
              {t("system.offline.body")}
            </p>
            <p className="text-muted-foreground text-xs mb-6">
              {t("system.offline.reassure")}
            </p>
            <Button ref={retryRef} onClick={handleRetry} disabled={retrying} aria-busy={retrying}>
              <RefreshCw className={cn("h-4 w-4", retrying && "animate-spin")} aria-hidden="true" />
              {t(retrying ? "system.offline.checking" : "errorPages.tryAgain")}
            </Button>
            {lastChecked && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t("system.offline.lastCheckedLabel")}{" "}
                <time dateTime={lastChecked.toISOString()}>{formatTime(lastChecked)}</time>
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
