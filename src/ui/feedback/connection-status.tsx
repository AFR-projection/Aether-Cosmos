"use client";

import { useSyncExternalStore } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Wifi, WifiOff, Radio } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useT, type TranslationKey } from "@/shared/lib/i18n";
import {
  getConnectionStatus,
  subscribeConnectionStatus,
  type ConnectionStatus,
} from "@/shared/lib/system/notify-store";

type Variant = {
  /** Null for `idle`, which draws nothing at all. */
  labelKey: TranslationKey | null;
  tone: string;
  glow: string;
  show: boolean;
  /** which trailing indicator to render */
  indicator: "bars" | "live" | "pulse" | "none";
};

/* Status is status: these four read from the semantic tokens, so the pill agrees
   with every other piece of state in the app and follows the theme. The
   indicators inside inherit `currentColor`, so the tone carries them too. */
const VARIANTS: Record<ConnectionStatus, Variant> = {
  idle: { labelKey: null, tone: "", glow: "", show: false, indicator: "none" },
  connecting: {
    labelKey: "system.connection.connecting",
    tone: "text-info-ink border-info/25 bg-info/10",
    glow: "shadow-lg",
    show: true,
    indicator: "bars",
  },
  live: {
    labelKey: "system.connection.live",
    tone: "text-success-ink border-success/25 bg-success/10",
    glow: "shadow-lg",
    show: true,
    indicator: "live",
  },
  reconnecting: {
    labelKey: "system.connection.reconnecting",
    tone: "text-warning-ink border-warning/30 bg-warning/10",
    glow: "shadow-lg",
    show: true,
    indicator: "bars",
  },
  offline: {
    labelKey: "system.connection.offline",
    tone: "text-danger-ink border-danger/30 bg-danger/10",
    glow: "shadow-lg",
    show: true,
    indicator: "pulse",
  },
};

function LeadIcon({ status }: { status: ConnectionStatus }) {
  if (status === "offline") return <WifiOff className="h-3 w-3" />;
  if (status === "live") return <Wifi className="h-3 w-3" />;
  // connecting / reconnecting: gently spinning radio ping
  return <Radio className="h-3 w-3 animate-spin-slow" />;
}

/**
 * Compact live-status pill (top-center): Connecting / Live / Reconnecting /
 * Offline. Sleek glassy chip with a colored glow, a sweeping sheen, and a
 * status-specific indicator — animated signal bars while (re)connecting, a
 * rippling dot when live. All motion is CSS transform/opacity (cheap) and
 * respects reduced-motion.
 */
export function ConnectionStatusPill({ className }: { className?: string }) {
  const t = useT();
  const status = useSyncExternalStore(
    subscribeConnectionStatus,
    getConnectionStatus,
    () => "idle" as ConnectionStatus
  );
  const reduceMotion = useReducedMotion();
  const v = VARIANTS[status];

  return (
    <AnimatePresence mode="wait">
      {v.show && (
        <motion.div
          key={status}
          // Losing the connection is not something to find out only by noticing a
          // colour at the top of the screen.
          role="status"
          aria-live="polite"
          // Centred with framer's own `x` rather than a utility class, so the whole
          // position is described in one place next to the `y`/`scale` it animates.
          style={{ x: "-50%" }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.9 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.9 }}
          transition={
            reduceMotion ? { duration: 0.15 } : { type: "spring", stiffness: 440, damping: 30 }
          }
          className={cn(
            // `fixed` and `relative` cannot both apply — the pill needs the first
            // to pin itself, and `overflow-hidden` alone contains the sheen.
            "pointer-events-none fixed left-1/2 top-3 z-[120] overflow-hidden",
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1",
            "text-xs font-semibold tracking-wide backdrop-blur-xl",
            v.tone,
            v.glow,
            className
          )}
        >
          {/* Sheen sweep — only while actively (re)connecting for a "working" feel */}
          {v.indicator === "bars" && <span className="status-pill-sheen" aria-hidden />}

          <LeadIcon status={status} />
          <span className="relative">{v.labelKey ? t(v.labelKey) : null}</span>

          {v.indicator === "bars" && (
            <span className="signal-bars ml-0.5" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          {v.indicator === "live" && <span className="status-dot-live ml-0.5" aria-hidden />}
          {v.indicator === "pulse" && <span className="status-dot-pulse ml-0.5" aria-hidden />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
