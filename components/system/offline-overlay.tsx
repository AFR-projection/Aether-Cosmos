"use client";

import { useSyncExternalStore, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getConnectionStatus, subscribeConnectionStatus } from "@/lib/system/notify-store";

export function OfflineOverlay() {
  const status = useSyncExternalStore(
    subscribeConnectionStatus,
    getConnectionStatus,
    () => "idle" as ReturnType<typeof getConnectionStatus>
  );

  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [retrying, setRetrying] = useState(false);

  const isOffline = status === "offline";

  useEffect(() => {
    if (isOffline) {
      setLastChecked(new Date());
    }
  }, [isOffline]);

  async function handleRetry() {
    setRetrying(true);
    setLastChecked(new Date());
    try {
      await fetch("/api/auth/csrf", { method: "GET", cache: "no-store" });
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
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label="You are offline"
        >
          <div className="text-center max-w-sm w-full">
            <div className="mb-6 mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-muted border border-border">
              <WifiOff className="h-10 w-10 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-bold mb-2">You&apos;re Offline</h2>
            <p className="text-muted-foreground text-sm mb-1">
              We can&apos;t reach the server right now.
            </p>
            <p className="text-muted-foreground/60 text-xs mb-6">
              Your local work has not been lost.
            </p>
            <Button
              onClick={handleRetry}
              disabled={retrying}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`} />
              Try Again
            </Button>
            {lastChecked && (
              <p className="mt-4 text-xs text-muted-foreground/50">
                Last checked:{" "}
                {lastChecked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
