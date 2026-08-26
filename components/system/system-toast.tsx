"use client";

import { useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  dismissNotice,
  EMPTY_NOTICES,
  getSystemNotices,
  subscribeSystemNotices,
  type NotifyTone,
  type SystemNotice,
} from "@/lib/system/notify-store";

/* Tone is state, so it comes from the status tokens — the same four colours the
   badges, banners and connection pill use. The `system` tone is the product's own
   voice rather than a status, which is why it alone rides on the accent. */
const toneStyles: Record<
  NotifyTone,
  { icon: typeof Info; ring: string; accent: string; bar: string }
> = {
  info: {
    icon: Info,
    ring: "border-info/25",
    accent: "text-info",
    bar: "from-info to-info/60",
  },
  success: {
    icon: CheckCircle2,
    ring: "border-success/25",
    accent: "text-success",
    bar: "from-success to-success/60",
  },
  warning: {
    icon: AlertTriangle,
    ring: "border-warning/30",
    accent: "text-warning",
    bar: "from-warning to-warning/60",
  },
  error: {
    icon: XCircle,
    ring: "border-danger/30",
    accent: "text-danger",
    bar: "from-danger to-danger/60",
  },
  system: {
    icon: Sparkles,
    ring: "border-accent/25",
    accent: "text-accent",
    bar: "from-accent to-accent-light",
  },
};

function ToastCard({ notice }: { notice: SystemNotice }) {
  const style = toneStyles[notice.tone];
  const Icon = style.icon;
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      layout
      initial={
        reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96, filter: "blur(4px)" }
      }
      animate={
        reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
      }
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96, filter: "blur(4px)" }}
      transition={
        reduceMotion
          ? { duration: 0.15 }
          : { type: "spring", stiffness: 420, damping: 32, mass: 0.6 }
      }
      className={cn(
        "pointer-events-auto relative w-[min(100vw-2rem,22rem)] overflow-hidden rounded-2xl",
        "border bg-surface/90 shadow-lg backdrop-blur-xl",
        style.ring
      )}
    >
      <div className={cn("absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r opacity-90", style.bar)} />
      <div className="flex gap-3 p-3.5 pr-10">
        <div
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted/50",
            style.accent
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold leading-snug text-foreground">
            <span className="min-w-0 flex-1">{notice.title}</span>
            {/* A repeat of the same message collapses into the card that is already
                on screen, so the card has to say how many times it happened. */}
            {notice.count > 1 && (
              <span
                className={cn(
                  "shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                  style.accent
                )}
              >
                <span className="sr-only">Repeated </span>
                <span aria-hidden="true">×</span>
                {notice.count}
                <span className="sr-only"> times</span>
              </span>
            )}
          </p>
          {notice.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {notice.description}
            </p>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => dismissNotice(notice.id)}
        className="absolute right-2 top-2 hover:bg-muted/60"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {/* The countdown is the dismiss timer made visible. With reduced motion the
          timer still runs — there is just no bar sliding across the card. */}
      {notice.duration > 0 && !reduceMotion && (
        <motion.div
          /* A collapsed repeat re-arms the dismiss timer, so the bar has to
             remount and run again — otherwise it sits at 0% while the card stays. */
          key={notice.count}
          /* scaleX, not width: the bar runs for seconds, and a transform stays on
             the compositor where a width animation would relayout every frame. */
          className={cn(
            "absolute bottom-0 left-0 h-[2px] w-full origin-left bg-gradient-to-r opacity-50",
            style.bar
          )}
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: notice.duration / 1000, ease: "linear" }}
        />
      )}
    </motion.div>
  );
}

export function SystemToastViewport() {
  const notices = useSyncExternalStore(
    subscribeSystemNotices,
    getSystemNotices,
    () => EMPTY_NOTICES as SystemNotice[]
  );

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[120] flex flex-col-reverse gap-2 sm:bottom-6 sm:right-6"
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout">
        {notices.map((notice) => (
          <ToastCard key={notice.id} notice={notice} />
        ))}
      </AnimatePresence>
    </div>
  );
}
