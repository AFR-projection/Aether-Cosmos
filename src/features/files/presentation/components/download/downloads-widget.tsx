"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, Download, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/feedback/spinner";
import { cn } from "@/shared/lib/utils";
import { errorCodeMessage, useFormat, useT, type TranslationKey } from "@/shared/lib/i18n";
import {
  EMPTY_DOWNLOADS,
  getDownloads,
  subscribeDownloads,
  clearDownloadHistory,
  type DownloadItem,
} from "@files/application/commands/download-store";

function useDownloads(): readonly DownloadItem[] {
  return useSyncExternalStore(subscribeDownloads, getDownloads, () => EMPTY_DOWNLOADS);
}

/** Status is carried by an icon *and* by wording, never by colour alone. */
function StatusIcon({ status }: { status: DownloadItem["status"] }) {
  if (status === "active") return <Spinner size="sm" />;
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-success-ink" aria-hidden="true" />;
  if (status === "error") return <XCircle className="h-4 w-4 text-danger-ink" aria-hidden="true" />;
  return <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

/**
 * The four states in the words the activity timeline already uses for the same
 * transfer, so a download reads the same wherever the user meets it.
 */
const STATUS_KEY: Record<DownloadItem["status"], TranslationKey> = {
  active: "files.activity.status.downloading",
  done: "files.activity.status.completed",
  error: "files.activity.status.failed",
  canceled: "files.activity.status.cancelled",
};

function DownloadRow({ item }: { item: DownloadItem }) {
  const t = useT();
  const { formatBytes } = useFormat();
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
        <span className="sr-only">{t("files.activity.srStatus", { status: t(STATUS_KEY[item.status]) })}</span>
        {item.status === "active" && item.speed > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("files.download.speed", { size: formatBytes(item.speed) })}
          </span>
        )}
      </div>

      {item.status === "active" && (
        <div
          role="progressbar"
          aria-label={t("files.download.itemProgress", { name: item.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={
            pct === null
              ? t("files.download.sizeUnknown")
              : t("files.download.percentDone", { count: pct })
          }
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
        // The store records a code; this is where it becomes a sentence.
        <p className="mt-1 text-xs text-danger-ink">{errorCodeMessage(item.error, t)}</p>
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
  const t = useT();
  const downloads = useDownloads();
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const panelId = useId();

  const activeCount = downloads.reduce((n, d) => (d.status === "active" ? n + 1 : n), 0);
  const finishedCount = downloads.length - activeCount;

  // Nothing to show and never used → render nothing.
  if (downloads.length === 0) return null;

  // One sentence for both the panel's heading and the toggle's name: a transfer
  // in flight is the news, a list of finished ones is the fallback.
  const summary =
    activeCount > 0
      ? t("files.download.activeSummary", { count: activeCount })
      : t("files.download.recentSummary", { count: downloads.length });

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
                {t("files.activity.filter.downloads")}
                <span className="ml-1.5 font-normal text-muted-foreground">{summary}</span>
              </p>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("files.download.clearFinished")}
                  disabled={finishedCount === 0}
                  onClick={clearDownloadHistory}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("files.download.closePanel")}
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
        aria-label={t("files.download.toggle", { summary })}
        className={cn(
          "relative flex h-11 w-11 items-center justify-center rounded-full border bg-surface-elevated/95 shadow-lg backdrop-blur",
          "transition-colors duration-150 hover:bg-surface-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          activeCount > 0 ? "border-accent/40" : "border-border"
        )}
      >
        <Download
          className={cn("h-5 w-5", activeCount > 0 ? "text-accent-ink" : "text-muted-foreground")}
          aria-hidden="true"
        />
        {activeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-on-accent"
          >
            {activeCount}
          </span>
        )}
      </button>
    </div>
  );
}
