"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  AlertCircle, CheckCircle2, ChevronDown, Clock, Pause, Pin, PinOff, Play,
  RotateCcw, X, Zap,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import {
  UploadQueue, formatSpeed,
  type UploadItem, type UploadItemStatus, type UploadStats,
} from "@files/application/commands/upload-queue";
import { cn } from "@/shared/lib/utils";
import {
  errorCodeMessage, uploadEtaLabel, uploadStatusKey, useFormat, useT,
  type Translator,
} from "@/shared/lib/i18n";

interface UploadPanelProps {
  queue: UploadQueue;
  onDismiss: () => void;
}

/** Statuses where bytes are still moving, so the row shows a spinner and a bar. */
const IN_FLIGHT: ReadonlySet<UploadItemStatus> = new Set([
  "preparing",
  "uploading",
  "verifying",
]);

/**
 * The queue reports codes; a person needs a sentence.
 *
 * Resolved through the shared `errors.code.*` registry, so a code the queue
 * gains later needs no edit here — and an unknown code still shows the code
 * rather than nothing at all.
 */
function errorText(code: string | undefined, t: Translator): string | null {
  if (!code) return null;
  return errorCodeMessage(code, t);
}

/** Decoration only: the same numbers are in the text beside it. */
function ProgressRing({ progress, active }: { progress: number; active: boolean }) {
  const size = 36;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(100, Math.max(0, progress)) / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90 shrink-0" aria-hidden="true">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-muted"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className={cn("transition-all duration-300", active ? "text-accent-ink" : "text-success-ink")}
      />
    </svg>
  );
}

function RowStatusIcon({ status }: { status: UploadItemStatus }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-success-ink" aria-hidden="true" />;
  }
  if (status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-danger-ink" aria-hidden="true" />;
  }
  if (status === "resume_requires_file") {
    return <AlertCircle className="h-3.5 w-3.5 text-warning-ink" aria-hidden="true" />;
  }
  if (IN_FLIGHT.has(status)) {
    return (
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
        aria-hidden="true"
      />
    );
  }
  return <span className="h-3.5 w-3.5 rounded-full border border-border" aria-hidden="true" />;
}

function UploadRow({
  item,
  onRetry,
  onCancel,
}: {
  item: UploadItem;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const name = item.file?.name ?? item.remotePath;
  const t = useT();
  const { formatBytes } = useFormat();
  const inFlight = IN_FLIGHT.has(item.status);
  const failed = item.status === "error" || item.status === "resume_requires_file";
  const detail = failed ? errorText(item.error, t) : null;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      className="rounded-lg px-3 py-2 transition-colors hover:bg-muted/30"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <RowStatusIcon status={item.status} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight text-foreground" title={name}>
            {name}
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatBytes(item.totalBytes)}</span>
            {inFlight ? (
              <span className="font-mono tabular-nums text-accent-ink">
                {Math.round(item.progress)}%
              </span>
            ) : (
              <span className={cn(failed && "text-warning-ink")}>
                {t(uploadStatusKey(item.status))}
              </span>
            )}
          </p>
        </div>
        {/* Always visible: hover-revealed controls cannot be reached by touch. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {failed && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("files.upload.retryItem", { name })}
              onClick={onRetry}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
          {(item.status === "queued" || failed) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("files.upload.removeItem", { name })}
              onClick={onCancel}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {inFlight && (
        <div
          role="progressbar"
          aria-label={t("files.upload.itemProgress", { name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.progress)}
          className="ml-6 mt-1.5 h-0.5 overflow-hidden rounded-full bg-muted"
        >
          <motion.div
            className="h-full rounded-full bg-accent"
            animate={{ width: `${item.progress}%` }}
            transition={{ duration: 0.2 }}
          />
        </div>
      )}

      {detail && <p className="ml-6 mt-0.5 text-xs text-danger-ink">{detail}</p>}
    </motion.li>
  );
}

export function UploadPanel({ queue, onDismiss }: UploadPanelProps) {
  const t = useT();
  const { formatBytes, formatNumber } = useFormat();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [stats, setStats] = useState<UploadStats>({
    total: 0, completed: 0, failed: 0, active: 0, queued: 0,
    totalBytes: 0, loadedBytes: 0, overallProgress: 0, speed: 0, eta: 0,
  });
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [paused, setPaused] = useState(false);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const onChange = (newItems: UploadItem[], newStats: UploadStats) => {
      setItems([...newItems]);
      setStats(newStats);
    };
    queue.on("change", onChange);
    return () => {
      queue.off("change", onChange);
    };
  }, [queue]);

  const allDone = stats.completed + stats.failed === stats.total && stats.total > 0;
  const hasActive = stats.active > 0 || stats.queued > 0;

  const smartItems = useMemo(() => {
    const visible = items.filter((i) => i.status !== "cancelled");
    const active = visible.filter((i) => IN_FLIGHT.has(i.status) || i.status === "queued");
    const failed = visible.filter(
      (i) => i.status === "error" || i.status === "resume_requires_file"
    );
    const done = visible.filter((i) => i.status === "done");
    if (expanded) return [...active, ...failed, ...done.slice(-3)];
    const current = active[0] ?? failed[0];
    return current ? [current] : [];
  }, [items, expanded]);

  const handleDismiss = useCallback(() => {
    queue.clearCompleted();
    onDismiss();
  }, [queue, onDismiss]);

  useEffect(() => {
    if (!allDone) {
      if (autoDismissRef.current) {
        clearTimeout(autoDismissRef.current);
        autoDismissRef.current = null;
      }
      return;
    }

    // No toast from here. This panel is already on screen showing the same
    // result, and file-browser.tsx raises the one completion notice for the
    // batch — two of them read as the app firing twice.
    //
    // A run that ended with failures is never dismissed on a timer: the only
    // record of what went wrong is in this panel.
    if (!pinned && !expanded && stats.failed === 0) {
      autoDismissRef.current = setTimeout(handleDismiss, 4000);
    }

    return () => {
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, [allDone, pinned, expanded, stats.failed, handleDismiss]);

  // Collapse again once the queue has been idle for a moment.
  useEffect(() => {
    if (!hasActive && expanded && !pinned) {
      const timer = setTimeout(() => setExpanded(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [hasActive, expanded, pinned]);

  const statusLabel =
    stats.active > 0
      ? t("files.upload.activeCount", { count: stats.active })
      : allDone
        ? stats.failed > 0
          ? t("files.upload.finishedWithFailures", { count: stats.failed })
          : t("files.upload.allFinished")
        : stats.queued > 0
          ? t("files.upload.waiting")
          : t("files.upload.idleTitle");

  return (
    <motion.section
      aria-label={t("files.upload.panelLabel")}
      initial={reduceMotion ? { opacity: 0 } : { y: 24, opacity: 0, scale: 0.96 }}
      animate={reduceMotion ? { opacity: 1 } : { y: 0, opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { y: 24, opacity: 0, scale: 0.96 }}
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32 }}
      className={cn(
        "fixed z-50 overflow-hidden",
        "bottom-5 right-5 sm:bottom-6 sm:right-6",
        "rounded-2xl border border-border/40 bg-surface/90 shadow-xl backdrop-blur-2xl",
        expanded ? "w-[min(100vw-2rem,340px)]" : "w-auto max-w-[min(100vw-2rem,320px)]"
      )}
      // Hover only ever anticipates the click; the header button below does the
      // same job for keyboard and touch.
      onMouseEnter={() => {
        if (hasActive && !pinned) setExpanded(true);
      }}
      onMouseLeave={() => {
        if (!pinned && allDone) setExpanded(false);
      }}
    >
      <div
        className={cn(
          "flex items-center gap-1 pr-2.5",
          expanded && "border-b border-border/30"
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        >
          <span className="relative shrink-0">
            <ProgressRing progress={stats.overallProgress} active={hasActive} />
            <span className="absolute inset-0 flex items-center justify-center">
              {allDone && stats.failed === 0 ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success-ink" aria-hidden="true" />
              ) : allDone && stats.failed > 0 ? (
                <AlertCircle className="h-3.5 w-3.5 text-warning-ink" aria-hidden="true" />
              ) : (
                <span className="font-mono text-xs font-bold tabular-nums text-foreground">
                  {Math.round(stats.overallProgress)}
                </span>
              )}
            </span>
          </span>

          <span className="min-w-0 flex-1">
            <span
              role="status"
              className="block truncate text-xs font-semibold leading-tight text-foreground"
            >
              {statusLabel}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {t("files.upload.fileTally", {
                completed: formatNumber(stats.completed),
                total: formatNumber(stats.total),
              })}
              {hasActive && stats.speed > 0 && ` · ${formatSpeed(stats.speed)}`}
              {hasActive && stats.eta > 0 && ` · ${uploadEtaLabel(stats.eta, t)}`}
            </span>
          </span>

          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              expanded && "rotate-180"
            )}
            aria-hidden="true"
          />
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {hasActive && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={paused ? t("files.upload.resume") : t("files.upload.pause")}
              aria-pressed={paused}
              onClick={() => {
                if (paused) queue.resume();
                else queue.pause();
                setPaused(!paused);
              }}
            >
              {paused ? (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={pinned ? t("files.upload.letClose") : t("files.upload.keepOpen")}
            aria-pressed={pinned}
            onClick={() => setPinned((p) => !p)}
          >
            {pinned ? (
              <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Pin className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("files.upload.dismiss")}
            onClick={handleDismiss}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-b border-border/20 px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-2.5">
                  {stats.speed > 0 && (
                    <span className="flex items-center gap-1">
                      <Zap className="h-3 w-3 text-accent-ink" aria-hidden="true" />
                      {formatSpeed(stats.speed)}
                    </span>
                  )}
                  {hasActive && stats.eta > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden="true" />
                      {uploadEtaLabel(stats.eta, t)}
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums">
                  {formatBytes(stats.loadedBytes)} / {formatBytes(stats.totalBytes)}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={t("files.upload.overallProgress")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(stats.overallProgress)}
                className="h-1 overflow-hidden rounded-full bg-muted"
              >
                <motion.div
                  className={cn(
                    "h-full rounded-full",
                    stats.failed > 0 && !hasActive ? "bg-warning" : "bg-accent"
                  )}
                  animate={{ width: `${stats.overallProgress}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.3 }}
                />
              </div>
            </div>

            <div className="max-h-[200px] overflow-y-auto py-1">
              {smartItems.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t("files.upload.nothingUploading")}
                </p>
              ) : (
                <ul>
                  <AnimatePresence mode="popLayout">
                    {smartItems.map((item) => (
                      <UploadRow
                        key={item.id}
                        item={item}
                        onRetry={() => queue.retryItem(item.id)}
                        onCancel={() => queue.cancelItem(item.id)}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>

            {stats.failed > 0 && (
              <div className="flex justify-end border-t border-border/20 px-3 py-2">
                <Button variant="ghost" size="sm" onClick={() => queue.retryFailed()}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("files.upload.retryFailed", { count: stats.failed })}
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!expanded && smartItems[0] && (
        <p className="-mt-0.5 truncate px-3 pb-2.5 pl-12 text-xs text-muted-foreground">
          {smartItems[0].file?.name ?? smartItems[0].remotePath}
        </p>
      )}
    </motion.section>
  );
}
