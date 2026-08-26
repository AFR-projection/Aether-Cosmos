"use client";

import { useState, useEffect, useCallback, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Upload, Download, Trash2, Edit2, Move, Copy, RotateCcw, FolderPlus,
  CheckCircle2, AlertCircle, Clock, X,
  Zap, Search, Trash, Activity, Pin, PinOff, Pause, Play,
  Maximize2, Minimize2, GripVertical, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { cn, formatBytes } from "@/lib/utils";
import {
  getActivities, subscribeActivities, clearActivityHistory, removeActivity,
  EMPTY_ACTIVITIES, hydrateActivities, type ActivityItem, type ActivityType, type ActivityStatus,
  getActivityScopeId,
} from "@/lib/activity/activity-store";
import { apiFetch } from "@/lib/api/client";
import { canUseActivityPopup, openActivityPopup } from "@/lib/activity/activity-window";
import {
  EMPTY_DOWNLOADS, cancelDownload, getDownloads, subscribeDownloads, type DownloadItem,
} from "@/lib/download/download-store";
import {
  getSharedUploadQueue, type UploadQueue, type UploadItem, type UploadStats,
  formatSpeed, formatETA,
} from "@/lib/upload-queue";

// ─── Types ───────────────────────────────────────────────────────────────────

type FilterKey = "all" | "active" | "upload" | "download" | "move" | "delete" | "failed";

/** Spelled out rather than title-cased at render time: "Move" also covers copies
 *  and renames, which a capitalised key could never say. */
const FILTER_LABEL: Record<FilterKey, string> = {
  all: "All",
  active: "Active",
  upload: "Uploads",
  download: "Downloads",
  move: "Moved",
  delete: "Deleted",
  failed: "Failed",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTimeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function labelStatus(status: string): string {
  if (status === "done" || status === "completed") return "Completed";
  if (status === "active") return "Processing";
  if (status === "queued") return "Queued";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

function isYesterday(ts: number): boolean {
  const d = new Date(ts);
  const y = new Date(Date.now() - 86_400_000);
  return d.getDate() === y.getDate() && d.getMonth() === y.getMonth() && d.getFullYear() === y.getFullYear();
}

// ─── Activity metadata ────────────────────────────────────────────────────────

type MetaTone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

/** One class pair per tone, all from the theme — no palette colours in rows. */
const META_TONE: Record<MetaTone, string> = {
  accent: "bg-accent/10 text-accent",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * Colour groups these by consequence, not by type — the icon beside it already
 * says which action it was. Eight bespoke hues read as decoration, and two of
 * the pairs (blue/cyan, emerald/teal) were indistinguishable at 14px, so there
 * was nothing for anyone to learn.
 */
const ACTIVITY_META: Record<ActivityType, { label: string; tone: MetaTone }> = {
  upload:        { label: "Upload",         tone: "accent" },
  download:      { label: "Download",       tone: "info" },
  delete:        { label: "Deleted",        tone: "danger" },
  rename:        { label: "Renamed",        tone: "warning" },
  move:          { label: "Moved",          tone: "accent" },
  copy:          { label: "Copied",         tone: "info" },
  restore:       { label: "Restored",       tone: "success" },
  create_folder: { label: "Folder created", tone: "success" },
};

function ActivityTypeIcon({ type, className }: { type: ActivityType; className?: string }) {
  const cls = cn("h-3.5 w-3.5 shrink-0", className);
  switch (type) {
    case "upload":        return <Upload className={cls} aria-hidden="true" />;
    case "download":      return <Download className={cls} aria-hidden="true" />;
    case "delete":        return <Trash2 className={cls} aria-hidden="true" />;
    case "rename":        return <Edit2 className={cls} aria-hidden="true" />;
    case "move":          return <Move className={cls} aria-hidden="true" />;
    case "copy":          return <Copy className={cls} aria-hidden="true" />;
    case "restore":       return <RotateCcw className={cls} aria-hidden="true" />;
    case "create_folder": return <FolderPlus className={cls} aria-hidden="true" />;
    default:              return <Activity className={cls} aria-hidden="true" />;
  }
}

/** Decoration: every caller pairs this with the status in words. */
function StatusIcon({ status, className }: { status: ActivityStatus | "uploading"; className?: string }) {
  const cls = cn("h-3.5 w-3.5 shrink-0", className);
  if (status === "done")      return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden="true" />;
  if (status === "failed")    return <AlertCircle className={cn(cls, "text-danger")} aria-hidden="true" />;
  if (status === "cancelled") return <X className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
  if (status === "active" || status === "uploading" || status === "downloading" || status === "processing" || status === "preparing" || status === "verifying" || status === "retrying")
    return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden="true" />;
  return <Clock className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({
  value,
  failed,
  label,
  className,
}: {
  value: number;
  failed?: boolean;
  /** Named for assistive tech: a bare bar announces a number with no subject. */
  label: string;
  className?: string;
}) {
  const pct = Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}
    >
      <motion.div
        className={cn("h-full rounded-full", failed ? "bg-danger" : "bg-accent")}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.25 }}
      />
    </div>
  );
}

// ─── Live upload row (from UploadQueue) ───────────────────────────────────────

/** The queue reports codes; a person needs a sentence. */
function uploadErrorText(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "RESUME_REQUIRES_FILE") {
    return "Pick this file again to carry on where it stopped.";
  }
  return code;
}

function UploadRow({
  item, onRetry, onCancel,
}: { item: UploadItem; onRetry: () => void; onCancel: () => void }) {
  const isActive = item.status === "preparing" || item.status === "uploading" || item.status === "verifying";
  const isFailed = item.status === "error";
  const isQueued = item.status === "queued";
  const isResumeNeeded = item.status === "resume_requires_file";
  const name = item.file?.name ?? item.remotePath;
  const detail = isFailed || isResumeNeeded ? uploadErrorText(item.error) : null;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="rounded-lg px-3 py-2 transition-colors hover:bg-muted/20"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-1 shrink-0">
          {isActive && <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden="true" />}
          {isFailed && <AlertCircle className="h-3.5 w-3.5 text-danger" aria-hidden="true" />}
          {isResumeNeeded && <AlertCircle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />}
          {isQueued && <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
          {item.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <p className="truncate text-xs font-medium leading-tight text-foreground" title={name}>
              {name}
            </p>
            {/* Always visible: hover-revealed controls cannot be reached by touch. */}
            <div className="-mt-1 flex shrink-0 items-center gap-0.5">
              {isFailed && (
                <Button variant="ghost" size="icon" aria-label={`Retry ${name}`} onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
              {(isQueued || isFailed || isResumeNeeded) && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${name} from the queue`}
                  onClick={onCancel}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{formatBytes(item.totalBytes)}</span>
            {isActive && (
              <span className="font-mono tabular-nums text-accent">
                {item.status === "preparing" ? "Preparing" : `${Math.round(item.progress)}%`}
              </span>
            )}
            {isActive && item.speed > 0 && <span>{formatSpeed(item.speed)}</span>}
            {isQueued && <span>Waiting</span>}
            {isResumeNeeded && <span className="text-warning">Needs the file again</span>}
          </div>

          {isActive && (
            <ProgressBar value={item.progress} label={`Uploading ${name}`} className="mt-1.5" />
          )}
          {detail && <p className="mt-0.5 text-xs text-danger">{detail}</p>}
        </div>
      </div>
    </motion.li>
  );
}

// ─── Live download row (from download-store) ──────────────────────────────────

function DownloadRow({ item, onCancel }: { item: DownloadItem; onCancel: () => void }) {
  const hasProgress = item.total > 0;
  const pct = hasProgress ? Math.round((item.loaded / item.total) * 100) : 0;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="rounded-lg px-3 py-2 transition-colors hover:bg-muted/20"
    >
      <div className="flex items-start gap-2.5">
        <span
          className="mt-1 block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <p className="truncate text-xs font-medium leading-tight text-foreground" title={item.name}>
              {item.name}
            </p>
            <div className="-mt-1 flex shrink-0 items-center gap-1">
              {hasProgress && (
                <span className="font-mono text-xs tabular-nums text-accent">{pct}%</span>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Cancel the download of ${item.name}`}
                onClick={onCancel}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {hasProgress && (
              <span>
                {formatBytes(item.loaded)} / {formatBytes(item.total)}
              </span>
            )}
            {item.speed > 0 && <span>{formatSpeed(item.speed)}</span>}
            {!hasProgress && <span>Downloading</span>}
          </div>
          {hasProgress && (
            <ProgressBar value={pct} label={`Downloading ${item.name}`} className="mt-1.5" />
          )}
        </div>
      </div>
    </motion.li>
  );
}

// ─── History row (from activity-store) ───────────────────────────────────────

function HistoryRow({ item, onRemove }: { item: ActivityItem; onRemove: () => void }) {
  // Persisted history can outlive the client bundle that created it. Keep
  // unknown types visible instead of allowing one legacy event to crash the
  // entire Activity Center.
  const meta = ACTIVITY_META[item.type] ?? { label: "Activity", tone: "neutral" as MetaTone };
  const isFailed = item.status === "failed";
  const isCancelled = item.status === "cancelled";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="flex items-start gap-2.5 rounded-lg px-3 py-2 transition-colors hover:bg-muted/20"
    >
      <span className={cn("mt-1 shrink-0 rounded-md p-1", META_TONE[meta.tone])}>
        <ActivityTypeIcon type={item.type} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <p
              className={cn(
                "truncate text-xs font-medium leading-tight",
                isFailed ? "text-danger" : isCancelled ? "text-muted-foreground" : "text-foreground"
              )}
              title={item.name}
            >
              {item.name}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <span className="sr-only">{meta.label}. </span>
              {item.detail ?? labelStatus(item.status)}
            </p>
            {isFailed && item.error && (
              <p className="mt-0.5 truncate text-xs text-danger">{item.error}</p>
            )}
          </div>
          <div className="-mt-1 ml-1 flex shrink-0 items-center gap-1">
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {item.endedAt ? formatTimeOfDay(item.endedAt) : formatRelativeTime(item.startedAt)}
            </span>
            {/* Always visible: a hover-only remove control is unreachable by touch. */}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${item.name} from the history`}
              onClick={onRemove}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      <span className="mt-1 shrink-0">
        <StatusIcon status={item.status} />
      </span>
    </motion.li>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface/90 px-3 py-1.5 backdrop-blur-sm">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </h3>
      {count !== undefined && count > 0 && (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </div>
  );
}

// ─── Filter chip ──────────────────────────────────────────────────────────────

function FilterChip({
  label, active, count, onClick,
}: { label: string; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        active
          ? "bg-accent text-white"
          : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {label}
      {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

// ─── Overall upload stats bar ──────────────────────────────────────────────────

function UploadStatsBar({ stats, paused, onPause, onResume, onRetryFailed }: {
  stats: UploadStats;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  onRetryFailed: () => void;
}) {
  const hasActive = stats.active > 0 || stats.queued > 0;
  if (!hasActive && stats.failed === 0) return null;

  return (
    <div className="shrink-0 border-b border-border/20 bg-muted/10 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {hasActive && (
            <>
              <span className="flex items-center gap-1">
                <Zap className="h-3 w-3 text-accent" aria-hidden="true" />
                {formatSpeed(stats.speed)}
              </span>
              {stats.eta > 0 && <span>{formatETA(stats.eta)} left</span>}
            </>
          )}
          <span className="font-mono tabular-nums">
            {stats.completed}/{stats.total} files
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {stats.failed > 0 && (
            <Button variant="ghost" size="sm" onClick={onRetryFailed}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry {stats.failed} failed
            </Button>
          )}
          {hasActive && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={paused ? "Resume uploads" : "Pause uploads"}
              aria-pressed={paused}
              onClick={paused ? onResume : onPause}
            >
              {paused ? (
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </Button>
          )}
        </div>
      </div>
      {hasActive && (
        <ProgressBar
          value={stats.overallProgress}
          label="Overall upload progress"
          failed={stats.failed > 0 && !hasActive}
        />
      )}
    </div>
  );
}

// ─── Shared panel content ─────────────────────────────────────────────────────

interface PanelContentProps {
  pinned: boolean;
  paused: boolean;
  activeCount: number;
  uploadQueue?: UploadQueue | null;
  uploadStats: UploadStats;
  filter: FilterKey;
  search: string;
  liveUploads: UploadItem[];
  activeDownloads: DownloadItem[];
  todayItems: ActivityItem[];
  yesterdayItems: ActivityItem[];
  olderItems: ActivityItem[];
  historyItems: ActivityItem[];
  counts: Record<FilterKey, number>;
  activities: ActivityItem[];
  onPinToggle: () => void;
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetryFailed: () => void;
  onFilterChange: (f: FilterKey) => void;
  onSearchChange: (s: string) => void;
  onViewAll: () => void;
  onClearHistory: () => void;
}

function PanelContent({
  pinned, paused, activeCount,
  uploadQueue, uploadStats,
  filter, search,
  liveUploads, activeDownloads,
  todayItems, yesterdayItems, olderItems,
  historyItems, counts, activities,
  onPinToggle, onClose,
  onPause, onResume, onRetryFailed,
  onFilterChange, onSearchChange,
  onViewAll, onClearHistory,
}: PanelContentProps) {
  const searchId = useId();

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold text-foreground">Activity Center</h2>
          {activeCount > 0 && (
            <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 font-mono text-xs tabular-nums text-accent">
              {activeCount} active
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={pinned ? "Let this panel close on its own" : "Keep this panel open"}
            aria-pressed={pinned}
            onClick={onPinToggle}
          >
            {pinned ? (
              <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Pin className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close the Activity Center" onClick={onClose}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Upload stats bar */}
      {uploadQueue && (uploadStats.active > 0 || uploadStats.queued > 0 || uploadStats.failed > 0) && (
        <UploadStatsBar
          stats={uploadStats} paused={paused}
          onPause={onPause}
          onResume={onResume}
          onRetryFailed={onRetryFailed}
        />
      )}

      {/* Filter chips */}
      <div
        role="group"
        aria-label="Filter activity"
        className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/20 px-3 py-2"
      >
        {(["all","active","upload","download","move","delete","failed"] as FilterKey[]).map((f) => (
          <FilterChip
            key={f}
            label={FILTER_LABEL[f]}
            active={filter === f} count={counts[f]}
            onClick={() => onFilterChange(f)}
          />
        ))}
      </div>

      {/* Search */}
      <div className="shrink-0 border-b border-border/20 px-3 py-2">
        <label htmlFor={searchId} className="sr-only">
          Search activity
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            value={search} onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search activity…"
            className="h-9 border-transparent bg-muted/30 pl-8 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear the search"
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(filter === "all" || filter === "active" || filter === "upload") && liveUploads.length > 0 && (
          <div>
            <SectionHeader label="Uploading" count={liveUploads.length} />
            <ul>
              <AnimatePresence mode="popLayout">
                {liveUploads.map((item) => (
                  <UploadRow key={item.id} item={item}
                    onRetry={() => uploadQueue?.retryItem(item.id)}
                    onCancel={() => uploadQueue?.cancelItem(item.id)} />
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}

        {(filter === "all" || filter === "active" || filter === "download") && activeDownloads.length > 0 && (
          <div>
            <SectionHeader label="Downloading" count={activeDownloads.length} />
            <ul>
              <AnimatePresence mode="popLayout">
                {activeDownloads.map((item) => (
                  <DownloadRow key={item.id} item={item} onCancel={() => cancelDownload(item.id)} />
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}

        {filter !== "active" && (
          <>
            {todayItems.length > 0 && (
              <div>
                <SectionHeader label="Today" count={todayItems.length} />
                <ul>
                  <AnimatePresence mode="popLayout">
                    {todayItems.map((item) => (
                      <HistoryRow key={item.id} item={item} onRemove={() => removeActivity(item.id)} />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            )}
            {yesterdayItems.length > 0 && (
              <div>
                <SectionHeader label="Yesterday" count={yesterdayItems.length} />
                <ul>
                  <AnimatePresence mode="popLayout">
                    {yesterdayItems.map((item) => (
                      <HistoryRow key={item.id} item={item} onRemove={() => removeActivity(item.id)} />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            )}
            {olderItems.length > 0 && (
              <div>
                <SectionHeader label="Earlier" count={olderItems.length} />
                <ul>
                  <AnimatePresence mode="popLayout">
                    {olderItems.map((item) => (
                      <HistoryRow key={item.id} item={item} onRemove={() => removeActivity(item.id)} />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            )}
          </>
        )}

        {liveUploads.length === 0 && activeDownloads.length === 0 && historyItems.length === 0 && (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <span className="mb-3 rounded-full bg-muted/60 p-4">
              <Activity className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-foreground">
              {search || filter !== "all" ? "Nothing matches that filter" : "No activity yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {search || filter !== "all"
                ? "Try a different filter, or clear the search."
                : "Uploads, downloads, and file actions appear here."}
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      {activities.length > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/20 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {activities.length} item{activities.length !== 1 ? "s" : ""} in history
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearHistory}
            className="hover:bg-danger/10 hover:text-danger"
          >
            <Trash className="h-3.5 w-3.5" aria-hidden="true" /> Clear history
          </Button>
        </div>
      )}
      <button
        type="button"
        onClick={onViewAll}
        className="flex min-h-11 w-full shrink-0 items-center justify-center gap-2 border-t border-border/20 px-3 text-xs font-medium text-accent transition-colors hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        View all activity <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </>
  );
}

function FloatingActivityWindow({
  uploadStats,
  liveUploads,
  activeDownloads,
  activities,
  onClose,
  onViewAll,
  onRetryFailed,
  onCancelDownload,
}: {
  uploadStats: UploadStats;
  liveUploads: UploadItem[];
  activeDownloads: DownloadItem[];
  activities: ActivityItem[];
  onClose: () => void;
  onViewAll: () => void;
  onRetryFailed: () => void;
  onCancelDownload: (id: string) => void;
}) {
  type Geometry = { x: number; y: number; width: number; height: number };
  const [geometry, setGeometry] = useState<Geometry>({ x: 16, y: 92, width: 440, height: 620 });
  const [maximized, setMaximized] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null);
  const resizeRef = useRef<{ pointerX: number; pointerY: number; width: number; height: number } | null>(null);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("sbyafr_activity_window_geometry");
      if (saved) setGeometry(JSON.parse(saved) as Geometry);
    } catch { /* session storage is optional */ }
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem("sbyafr_activity_window_geometry", JSON.stringify(geometry)); } catch { /* ignore */ }
  }, [geometry]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (dragRef.current) {
        const nextX = dragRef.current.x + event.clientX - dragRef.current.pointerX;
        const nextY = dragRef.current.y + event.clientY - dragRef.current.pointerY;
        setGeometry((current) => ({ ...current, x: Math.max(8, Math.min(window.innerWidth - current.width - 8, nextX)), y: Math.max(8, Math.min(window.innerHeight - 80, nextY)) }));
      }
      if (resizeRef.current) {
        setGeometry((current) => ({ ...current, width: Math.max(340, Math.min(window.innerWidth - current.x - 8, resizeRef.current!.width + event.clientX - resizeRef.current!.pointerX)), height: Math.max(360, Math.min(window.innerHeight - current.y - 8, resizeRef.current!.height + event.clientY - resizeRef.current!.pointerY)) }));
      }
    };
    const up = () => { dragRef.current = null; resizeRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const totalBytes = uploadStats.totalBytes + activeDownloads.reduce((sum, item) => sum + item.total, 0);
  const loadedBytes = uploadStats.loadedBytes + activeDownloads.reduce((sum, item) => sum + item.loaded, 0);
  const overall = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;
  const totalTasks = uploadStats.total + activeDownloads.length;
  const activeTasks = uploadStats.active + activeDownloads.length;
  const queuedTasks = uploadStats.queued;
  const failedTasks = uploadStats.failed + activeDownloads.filter((item) => item.status === "error").length;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="File Activity Center floating window"
      // z-70 per the layer scale in components/ui/modal.tsx: above the floating
      // downloads widget, below every dialog — this window is not modal, so a
      // confirm prompt raised from inside it must still paint on top.
      className={cn("fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface/95 shadow-2xl backdrop-blur-2xl", minimized ? "h-auto" : "max-sm:!left-2 max-sm:!top-2 max-sm:!h-[calc(100dvh-1rem)] max-sm:!w-[calc(100vw-1rem)]")}
      style={maximized ? { inset: "1rem", width: "auto", height: "auto" } : { left: geometry.x, top: geometry.y, width: `min(calc(100vw - 1rem), ${geometry.width}px)`, height: minimized ? "auto" : `min(calc(100dvh - ${geometry.y + 16}px), ${geometry.height}px)` }}
    >
      <div
        className="flex min-h-14 shrink-0 cursor-move items-center justify-between border-b border-border/50 bg-foreground/[0.025] px-4"
        onPointerDown={(event) => { if (maximized) return; dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, x: geometry.x, y: geometry.y }; }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
                File Activity Center
              </h2>
              <span className="flex shrink-0 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-success">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
                Live
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {totalTasks} files · {uploadStats.completed} completed · {activeTasks} processing · {queuedTasks} queued
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onPointerDown={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={minimized ? "Restore the activity window" : "Minimize the activity window"}
            aria-pressed={minimized}
            onClick={() => setMinimized((value) => !value)}
          >
            {minimized ? (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden sm:inline-flex"
            aria-label={maximized ? "Restore the activity window" : "Maximize the activity window"}
            aria-pressed={maximized}
            onClick={() => setMaximized((value) => !value)}
          >
            <Maximize2 className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close the activity window"
            onClick={onClose}
            className="hover:bg-danger/10 hover:text-danger"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {!minimized && <>
        <div className="shrink-0 border-b border-border/40 px-4 py-4">
          <div className="mb-2 flex items-end justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Overall progress
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{overall}%</p>
            </div>
            <p className="text-xs tabular-nums text-muted-foreground">
              {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
            </p>
          </div>
          <div
            role="progressbar"
            aria-label="Overall transfer progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={overall}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${overall}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{totalTasks} files</span>
            <span>{uploadStats.completed} completed</span>
            <span>{activeTasks} processing</span>
            <span>{queuedTasks} queued</span>
            {failedTasks > 0 && <span className="text-danger">{failedTasks} failed</span>}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {liveUploads.map((item) => {
            const failed = item.status === "error";
            const name = item.file?.name ?? item.remotePath;
            const progress = Math.round(item.progress);
            return (
              <div key={item.id} className="rounded-xl border border-border/40 px-3 py-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      failed ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"
                    )}
                  >
                    {failed ? (
                      <AlertCircle className="h-4 w-4" aria-hidden="true" />
                    ) : item.status === "queued" ? (
                      <Clock className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Upload className="h-4 w-4" aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground" title={name}>
                          {name}
                        </p>
                        <p className={cn("mt-0.5 text-xs", failed ? "text-danger" : "text-muted-foreground")}>
                          {failed
                            ? uploadErrorText(item.error) ?? "The upload failed."
                            : item.status === "preparing"
                              ? "Preparing"
                              : item.status === "verifying"
                                ? "Verifying"
                                : item.status === "queued"
                                  ? "Queued"
                                  : "Uploading"}
                        </p>
                      </div>
                      <span className="font-mono text-xs tabular-nums text-accent">
                        {item.status === "preparing" ? "--" : `${progress}%`}
                      </span>
                    </div>
                    <ProgressBar
                      value={progress}
                      failed={failed}
                      label={`Uploading ${name}`}
                      className="mt-2 h-1.5"
                    />
                    <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                      {formatBytes(item.uploadedBytes)} / {formatBytes(item.totalBytes)}
                      {item.speed > 0 ? ` · ${formatSpeed(item.speed)}` : ""}
                    </p>
                    {failed && (
                      <Button variant="outline" size="sm" className="mt-2" onClick={onRetryFailed}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        Retry
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {activeDownloads.map((item) => {
            const progress = item.total > 0 ? Math.round((item.loaded / item.total) * 100) : 0;
            return (
              <div key={item.id} className="rounded-xl border border-border/40 px-3 py-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
                    <Download className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground" title={item.name}>
                          {item.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Downloading</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="font-mono text-xs tabular-nums text-info">
                          {item.total > 0 ? `${progress}%` : "Live"}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Cancel the download of ${item.name}`}
                          onClick={() => onCancelDownload(item.id)}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    {item.total > 0 && (
                      <ProgressBar
                        value={progress}
                        label={`Downloading ${item.name}`}
                        className="mt-2 h-1.5"
                      />
                    )}
                    <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                      {item.total > 0
                        ? `${formatBytes(item.loaded)} / ${formatBytes(item.total)}`
                        : "Preparing the download"}
                      {item.speed > 0 ? ` · ${formatSpeed(item.speed)}` : ""}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
          {liveUploads.length === 0 && activeDownloads.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No transfers are running right now.
            </p>
          )}
          {activities.slice(0, 8).map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5">
              <span className="rounded-lg bg-muted p-2 text-muted-foreground">
                <ActivityTypeIcon type={item.type} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground" title={item.name}>
                  {item.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.error ?? labelStatus(item.status)}
                </p>
              </div>
              <StatusIcon status={item.status} />
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
          <Button variant="ghost" size="sm" onClick={onViewAll} className="text-accent">
            View all activity <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <span className="text-xs text-muted-foreground">Synced from the transfer engine</span>
        </div>
        {!maximized && (
          <div
            onPointerDown={(event) => {
              event.stopPropagation();
              resizeRef.current = { pointerX: event.clientX, pointerY: event.clientY, width: geometry.width, height: geometry.height };
            }}
            className="absolute bottom-1 right-1 hidden h-5 w-5 cursor-se-resize sm:block"
            aria-hidden="true"
          >
            <GripVertical className="h-4 w-4 rotate-[-45deg] text-muted-foreground" />
          </div>
        )}
      </>}
    </div>
  );
}

// ─── Main ActivityCenter component ────────────────────────────────────────────

interface ActivityCenterProps {
  uploadQueue?: UploadQueue | null;
  inline?: boolean;
}

export function ActivityCenter({ uploadQueue: providedUploadQueue, inline = false }: ActivityCenterProps) {
  const uploadQueue = providedUploadQueue ?? getSharedUploadQueue();
  const activityScopeId = getActivityScopeId();
  const [open, setOpen] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [pinned, setPinned] = useState(false);
  const [paused, setPaused] = useState(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();
  // Mounted once here rather than inside PanelContent: the desktop and mobile
  // panels are both in the tree, and a hook in the shared child would put two
  // confirm dialogs on the page.
  const { askConfirm, dialogs } = useDialogs();

  useEffect(() => {
    let cancelled = false;
    if (!activityScopeId) return () => { cancelled = true; };
    void apiFetch<{ scopeId: string; items: ActivityItem[] }>(`/api/activity?scopeId=${encodeURIComponent(activityScopeId)}&limit=200`).then((response) => {
      if (!cancelled && response.success && response.data?.items) hydrateActivities(response.data.items, response.data.scopeId);
    });
    return () => { cancelled = true; };
  }, [activityScopeId]);

  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadStats, setUploadStats] = useState<UploadStats>({
    total: 0, completed: 0, failed: 0, active: 0, queued: 0,
    totalBytes: 0, loadedBytes: 0, overallProgress: 0, speed: 0, eta: 0,
  });

  const downloads = useSyncExternalStore(subscribeDownloads, getDownloads, () => EMPTY_DOWNLOADS);
  const activities = useSyncExternalStore(subscribeActivities, getActivities, () => EMPTY_ACTIVITIES);

  useEffect(() => {
    if (!uploadQueue) return;
    const onChange = (items: UploadItem[], stats: UploadStats) => {
      setUploadItems([...items]);
      setUploadStats(stats);
    };
    uploadQueue.on("change", onChange);
    onChange(uploadQueue.getItems(), uploadQueue.getStats());
    return () => { uploadQueue.off("change", onChange); };
  }, [uploadQueue]);

  useEffect(() => {
    return () => { if (clickTimerRef.current) clearTimeout(clickTimerRef.current); };
  }, []);

  useEffect(() => {
    try {
      if (canUseActivityPopup()) {
        sessionStorage.removeItem("sbyafr_activity_window_open");
      } else if (sessionStorage.getItem("sbyafr_activity_window_open") === "true") {
        setWindowOpen(true);
      }
    } catch { /* session storage is optional */ }
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem("sbyafr_activity_window_open", String(windowOpen)); } catch { /* ignore */ }
  }, [windowOpen]);

  const activeDownloads = (downloads as DownloadItem[]).filter((d) => d.status === "active");
  const allUploadsDone = uploadStats.total > 0 &&
    uploadStats.completed + uploadStats.failed === uploadStats.total &&
    uploadStats.active === 0 && uploadStats.queued === 0;

  const autocloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const everythingDone = allUploadsDone && activeDownloads.length === 0;
    if (everythingDone && open && !pinned) {
      autocloseRef.current = setTimeout(() => setOpen(false), 4500);
    }
    return () => { if (autocloseRef.current) clearTimeout(autocloseRef.current); };
  }, [allUploadsDone, activeDownloads.length, open, pinned]);

  const activeCount = (uploadStats.active + uploadStats.queued) + activeDownloads.length;
  const failedUploads = uploadStats.failed;
  const failedDownloads = (downloads as DownloadItem[]).filter((d) => d.status === "error").length;
  const failedHistory = (activities as ActivityItem[]).filter((a) => a.status === "failed").length;
  const totalFailed = failedUploads + failedDownloads + failedHistory;

  const liveUploads = uploadItems.filter(
    (i) => i.status !== "cancelled" && i.status !== "done"
  );

  const historyItems = useMemo(() => {
    const q = search.toLowerCase();
    return (activities as ActivityItem[]).filter((a) => {
      if (filter === "active") return false;
      if (filter === "upload" && a.type !== "upload") return false;
      if (filter === "download" && a.type !== "download") return false;
      if (filter === "move" && !["move","copy","rename"].includes(a.type)) return false;
      if (filter === "delete" && a.type !== "delete") return false;
      if (filter === "failed" && a.status !== "failed") return false;
      if (q && !a.name.toLowerCase().includes(q) && !(a.detail ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [activities, filter, search]);

  const todayItems    = historyItems.filter((a) => isToday(a.startedAt));
  const yesterdayItems = historyItems.filter((a) => isYesterday(a.startedAt));
  const olderItems    = historyItems.filter((a) => !isToday(a.startedAt) && !isYesterday(a.startedAt));

  const counts: Record<FilterKey, number> = {
    all:      (activities as ActivityItem[]).length + liveUploads.length + activeDownloads.length,
    active:   activeCount,
    upload:   (activities as ActivityItem[]).filter((a) => a.type === "upload").length + liveUploads.length,
    download: (activities as ActivityItem[]).filter((a) => a.type === "download").length + activeDownloads.length,
    move:     (activities as ActivityItem[]).filter((a) => ["move","copy","rename"].includes(a.type)).length,
    delete:   (activities as ActivityItem[]).filter((a) => a.type === "delete").length,
    failed:   totalFailed,
  };

  const clearHistory = useCallback(async () => {
    // One click used to wipe the whole log with no way back — history is the
    // only record of what happened to a file after the fact.
    const ok = await askConfirm({
      title: "Clear the activity history?",
      message: "Finished uploads, downloads, and file actions are removed from this list. The files themselves are not touched.",
      confirmText: "Clear history",
      danger: true,
    });
    if (ok) clearActivityHistory();
  }, [askConfirm]);

  const viewAll = useCallback(() => {
    if (canUseActivityPopup()) {
      setOpen(false);
      setWindowOpen(false);
       if (openActivityPopup(getActivityScopeId())) return;
      // Popup blockers must not strand the user. Use the same navigation as a
      // normal link when a desktop popup cannot be created.
      window.location.href = "/files/activity";
      return;
    }

    // Tablet and mobile keep the existing responsive Activity presentation.
    setOpen(false);
    setWindowOpen(true);
  }, []);

  return (
    <>
      {/* ── Trigger button — top-right on desktop, inside mobile header zone ── */}
      <motion.button
        type="button"
        onClick={() => {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => setOpen((value) => !value), 220);
        }}
        onDoubleClick={() => {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          viewAll();
        }}
        whileHover={reduceMotion ? undefined : { scale: 1.05 }}
        whileTap={reduceMotion ? undefined : { scale: 0.95 }}
        aria-label={
          activeCount > 0
            ? `Activity Center — ${activeCount} running`
            : totalFailed > 0
              ? `Activity Center — ${totalFailed} failed`
              : "Activity Center"
        }
        aria-expanded={open}
        className={cn(
          // Desktop: fixed top-right corner, above page content
          inline ? "relative z-50 flex items-center justify-center" : "fixed z-50 flex items-center justify-center",
          // Mobile: sits in the header bar row (top-safe + centered vertically)
          !inline && "top-[calc(var(--safe-top,0px)+0.6rem)] right-3 lg:top-3 lg:right-5",
          // Shape: icon button with subtle pill on desktop hover
          "h-9 w-9 rounded-xl",
          "border border-transparent",
          "bg-transparent hover:bg-muted/60",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          open && "bg-accent/10 border-accent/25 text-accent",
          !open && "text-muted-foreground hover:text-foreground"
        )}
      >
        {/* Icon + animated badge */}
        <span className="relative">
          <Activity className="h-[18px] w-[18px]" aria-hidden="true" />
          <AnimatePresence>
            {activeCount > 0 && (
              <motion.span
                key="active-badge"
                aria-hidden="true"
                initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                className={cn(
                  "absolute -right-2 -top-2 flex h-[18px] min-w-[18px] items-center justify-center px-1",
                  "rounded-full bg-accent text-xs font-bold leading-none tabular-nums text-white",
                  "ring-2 ring-background"
                )}
              >
                {activeCount > 9 ? "9+" : activeCount}
              </motion.span>
            )}
            {activeCount === 0 && totalFailed > 0 && (
              <motion.span
                key="failed-badge"
                aria-hidden="true"
                initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                className={cn(
                  "absolute -right-2 -top-2 flex h-[18px] min-w-[18px] items-center justify-center px-1",
                  "rounded-full bg-danger text-xs font-bold leading-none tabular-nums text-white",
                  "ring-2 ring-background"
                )}
              >
                {totalFailed > 9 ? "9+" : totalFailed}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </motion.button>

      {/* ── Panel ── */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop — full on mobile, click-outside-close on desktop */}
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.15 }}
              className="fixed inset-0 z-40 bg-black/40 lg:bg-black/10"
              onClick={() => !pinned && setOpen(false)}
            />

            {/* ── Desktop panel: drops down from top-right ── */}
            <motion.div
              role="dialog"
              aria-modal="false"
              aria-label="Activity Center"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.96 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.96 }}
              transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 38 }}
              className={cn(
                "fixed z-50 flex-col overflow-hidden",
                "hidden lg:flex",
                "h-dvh max-h-none w-[400px] rounded-l-2xl rounded-r-none border-y border-l border-border/50",
                "bg-surface/95 backdrop-blur-3xl",
                "shadow-2xl",
                "top-0 right-0"
              )}>
              <PanelContent
                pinned={pinned} paused={paused}
                activeCount={activeCount} uploadQueue={uploadQueue}
                uploadStats={uploadStats} filter={filter} search={search}
                liveUploads={liveUploads} activeDownloads={activeDownloads}
                todayItems={todayItems} yesterdayItems={yesterdayItems} olderItems={olderItems}
                historyItems={historyItems} counts={counts} activities={activities as ActivityItem[]}
                onPinToggle={() => setPinned((p) => !p)}
                onClose={() => setOpen(false)}
                onPause={() => { uploadQueue?.pause(); setPaused(true); }}
                onResume={() => { uploadQueue?.resume(); setPaused(false); }}
                onRetryFailed={() => uploadQueue?.retryFailed()}
                onFilterChange={setFilter}
                onSearchChange={setSearch}
                onViewAll={viewAll}
                onClearHistory={() => void clearHistory()}
              />
            </motion.div>

            {/* ── Mobile panel: full-width bottom sheet ── */}
            <motion.div
              role="dialog"
              aria-modal="false"
              aria-label="Activity Center"
              initial={reduceMotion ? { opacity: 0 } : { y: "100%" }}
              animate={reduceMotion ? { opacity: 1 } : { y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { y: "100%" }}
              transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 38 }}
              className={cn(
                "fixed z-50 flex flex-col overflow-hidden",
                "lg:hidden",
                "inset-x-0 bottom-0",
                "rounded-t-3xl border-x border-t border-border/40",
                "bg-surface/98 backdrop-blur-3xl",
                "shadow-2xl",
                "h-[85dvh]"
              )}
            >
              {/* Drag handle */}
              <div className="mx-auto mb-1 mt-3 h-1 w-10 shrink-0 rounded-full bg-border/50" aria-hidden="true" />
              <PanelContent
                pinned={pinned} paused={paused}
                activeCount={activeCount} uploadQueue={uploadQueue}
                uploadStats={uploadStats} filter={filter} search={search}
                liveUploads={liveUploads} activeDownloads={activeDownloads}
                todayItems={todayItems} yesterdayItems={yesterdayItems} olderItems={olderItems}
                historyItems={historyItems} counts={counts} activities={activities as ActivityItem[]}
                onPinToggle={() => setPinned((p) => !p)}
                onClose={() => setOpen(false)}
                onPause={() => { uploadQueue?.pause(); setPaused(true); }}
                onResume={() => { uploadQueue?.resume(); setPaused(false); }}
                onRetryFailed={() => uploadQueue?.retryFailed()}
                onFilterChange={setFilter}
                onSearchChange={setSearch}
                onViewAll={viewAll}
                onClearHistory={() => void clearHistory()}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {windowOpen && (
          <FloatingActivityWindow
            uploadStats={uploadStats}
            liveUploads={liveUploads}
            activeDownloads={activeDownloads}
            activities={activities as ActivityItem[]}
            onClose={() => setWindowOpen(false)}
            onViewAll={viewAll}
            onRetryFailed={() => uploadQueue.retryFailed()}
            onCancelDownload={cancelDownload}
          />
        )}
      </AnimatePresence>
      {dialogs}
    </>
  );
}
