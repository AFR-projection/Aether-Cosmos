"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, Download, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/system/spinner";
import { cn, formatBytes } from "@/lib/utils";
import {
  EMPTY_DOWNLOADS,
  getDownloads,
  subscribeDownloads,
  clearDownloadHistory,
  type DownloadItem,
} from "@/lib/download/download-store";

function useDownloads(): readonly DownloadItem[] {
  return useSyncExternalStore(subscribeDownloads, getDownloads, () => EMPTY_DOWNLOADS);
}

function speedLabel(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Status is carried by an icon *and* by wording, never by colour alone. */
function StatusIcon({ status }: { status: DownloadItem["status"] }) {
  if (status === "active") return <Spinner size="sm" />;
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
  if (status === "error") return <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />;
  return <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

const STATUS_TEXT: Record<DownloadItem["status"], string> = {
  active: "Downloading",
  done: "Finished",
  error: "Failed",
  canceled: "Canceled",
};

function DownloadRow({ item }: { item: DownloadItem }) {
  const pct =
    item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : null;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <StatusIcon status={item.status} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={item.name}>
          {item.name}
        </span>
        <span className="sr-only">{STATUS_TEXT[item.status]}.</span>
        {item.status === "active" && item.speed > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {speedLabel(item.speed)}
          </span>
        )}
      </div>

      {item.status === "active" && (
        <div
          role="progressbar"
          aria-label={`Downloading ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={pct === null ? "Size unknown" : `${pct} percent`}
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
        >
          {pct !== null ? (
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          ) : (
            // Indeterminate (streamed ZIP, total unknown): a moving bar says
            // "still working" without claiming a percentage it cannot know.
            <div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
          )}
        </div>
      )}

      {item.status === "active" && item.loaded > 0 && (
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          {formatBytes(item.loaded)}
          {item.total > 0 ? ` / ${formatBytes(item.total)}` : ""}
          {pct !== null ? ` · ${pct}%` : ""}
        </p>
      )}

      {item.status === "error" && item.error && (
        <p className="mt-1 text-xs text-danger">{item.error}</p>
      )}
    </li>
  );
}

/**
 * Floating downloads widget: a badge button that expands into a history panel.
 * It sits at z-60 — above page chrome and full-screen surfaces, below dialogs,
 * so a confirm prompt is never covered by a progress list.
 */
export function DownloadsWidget() {
  const downloads = useDownloads();
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const panelId = useId();

  const activeCount = downloads.reduce((n, d) => (d.status === "active" ? n + 1 : n), 0);
  const finishedCount = downloads.length - activeCount;

  // Nothing to show and never used → render nothing.
  if (downloads.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
            className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface-elevated/95 shadow-2xl backdrop-blur"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <p className="text-xs font-semibold text-foreground">
                Downloads
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {activeCount > 0 ? `${activeCount} in progress` : `${downloads.length} recent`}
                </span>
              </p>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Clear finished downloads"
                  disabled={finishedCount === 0}
                  onClick={clearDownloadHistory}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close downloads panel"
                  onClick={() => setOpen(false)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {downloads.map((d) => (
                <DownloadRow key={d.id} item={d} />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={
          activeCount > 0
            ? `Downloads — ${activeCount} in progress`
            : `Downloads — ${downloads.length} recent`
        }
        className={cn(
          "relative flex h-11 w-11 items-center justify-center rounded-full border bg-surface-elevated/95 shadow-lg backdrop-blur",
          "transition-colors duration-150 hover:bg-surface-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          activeCount > 0 ? "border-accent/40" : "border-border"
        )}
      >
        <Download
          className={cn("h-5 w-5", activeCount > 0 ? "text-accent" : "text-muted-foreground")}
          aria-hidden="true"
        />
        {activeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-white"
          >
            {activeCount}
          </span>
        )}
      </button>
    </div>
  );
}
