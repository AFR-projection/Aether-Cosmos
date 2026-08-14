"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, Download, Trash2, Edit2, Move, Copy, RotateCcw, FolderPlus,
  CheckCircle2, AlertCircle, Clock, X,
  Zap, Search, Trash, Activity, Pin, PinOff, Pause, Play,
  Maximize2, Minimize2, GripVertical, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatBytes } from "@/lib/utils";
import {
  getActivities, subscribeActivities, clearActivityHistory, removeActivity,
  EMPTY_ACTIVITIES, hydrateActivities, type ActivityItem, type ActivityType, type ActivityStatus,
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

const ACTIVITY_META: Record<ActivityType, { label: string; color: string; bgColor: string }> = {
  upload:        { label: "Upload",        color: "text-blue-400",    bgColor: "bg-blue-400/10" },
  download:      { label: "Download",      color: "text-emerald-400", bgColor: "bg-emerald-400/10" },
  delete:        { label: "Deleted",       color: "text-red-400",     bgColor: "bg-red-400/10" },
  rename:        { label: "Renamed",       color: "text-amber-400",   bgColor: "bg-amber-400/10" },
  move:          { label: "Moved",         color: "text-violet-400",  bgColor: "bg-violet-400/10" },
  copy:          { label: "Copied",        color: "text-cyan-400",    bgColor: "bg-cyan-400/10" },
  restore:       { label: "Restored",      color: "text-teal-400",    bgColor: "bg-teal-400/10" },
  create_folder: { label: "Folder created",color: "text-orange-400",  bgColor: "bg-orange-400/10" },
};

function ActivityTypeIcon({ type, className }: { type: ActivityType; className?: string }) {
  const cls = cn("h-3.5 w-3.5 shrink-0", className);
  switch (type) {
    case "upload":        return <Upload className={cls} />;
    case "download":      return <Download className={cls} />;
    case "delete":        return <Trash2 className={cls} />;
    case "rename":        return <Edit2 className={cls} />;
    case "move":          return <Move className={cls} />;
    case "copy":          return <Copy className={cls} />;
    case "restore":       return <RotateCcw className={cls} />;
    case "create_folder": return <FolderPlus className={cls} />;
    default:               return <Activity className={cls} />;
  }
}

function StatusIcon({ status, className }: { status: ActivityStatus | "uploading"; className?: string }) {
  const cls = cn("h-3.5 w-3.5 shrink-0", className);
  if (status === "done")      return <CheckCircle2 className={cn(cls, "text-emerald-500")} />;
  if (status === "failed")    return <AlertCircle className={cn(cls, "text-red-500")} />;
  if (status === "cancelled") return <X className={cn(cls, "text-muted-foreground/50")} />;
  if (status === "active" || status === "uploading" || status === "downloading" || status === "processing" || status === "preparing" || status === "verifying" || status === "retrying")
    return <div className="h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent animate-spin shrink-0" />;
  return <Clock className={cn(cls, "text-muted-foreground/40")} />;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ value, failed, className }: { value: number; failed?: boolean; className?: string }) {
  return (
    <div className={cn("h-1 rounded-full bg-muted/40 overflow-hidden", className)}>
      <motion.div
        className={cn("h-full rounded-full", failed ? "bg-red-500/70" : "bg-accent")}
        animate={{ width: `${Math.min(100, value)}%` }}
        transition={{ duration: 0.25 }}
      />
    </div>
  );
}

// ─── Live upload row (from UploadQueue) ───────────────────────────────────────

function UploadRow({
  item, onRetry, onCancel,
}: { item: UploadItem; onRetry: () => void; onCancel: () => void }) {
  const isActive = item.status === "preparing" || item.status === "uploading" || item.status === "verifying";
  const isFailed = item.status === "error";
  const isQueued = item.status === "queued";
  const isResumeNeeded = item.status === "resume_requires_file";
  const name = item.file?.name ?? item.remotePath;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="group rounded-lg px-3 py-2.5 hover:bg-muted/20 transition-colors"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          {isActive && <div className="h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />}
          {isFailed && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
          {isResumeNeeded && <AlertCircle className="h-3.5 w-3.5 text-amber-500" />}
          {isQueued && <Clock className="h-3.5 w-3.5 text-muted-foreground/40" />}
          {item.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1">
            <p className="text-[12px] font-medium truncate leading-tight text-foreground/90">{name}</p>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {isFailed && (
                <button onClick={onRetry} className="rounded p-1 hover:bg-accent/10 text-accent text-[10px] font-medium transition-colors">
                  Retry
                </button>
              )}
              {(isQueued || isFailed) && (
                <button onClick={onCancel} className="rounded p-1 hover:bg-red-500/10 text-muted-foreground/50 hover:text-red-500 transition-colors">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground/60">{formatBytes(item.totalBytes)}</span>
            {isActive && <span className="text-[10px] font-mono text-accent">{item.status === "preparing" ? "Preparing" : `${Math.round(item.progress)}%`}</span>}
            {isActive && item.speed > 0 && <span className="text-[10px] text-muted-foreground/50">{formatSpeed(item.speed)}</span>}
            {isQueued && <span className="text-[10px] text-muted-foreground/40">Waiting…</span>}
            {isResumeNeeded && <span className="text-[10px] text-amber-500/80">Re-select file to resume</span>}
          </div>

          {isActive && <ProgressBar value={item.progress} className="mt-1.5" />}
          {(isFailed || isResumeNeeded) && item.error && (
            <p className="mt-0.5 text-[10px] text-red-500/70 truncate">{item.error}</p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Live download row (from download-store) ──────────────────────────────────

function DownloadRow({ item, onCancel }: { item: DownloadItem; onCancel: () => void }) {
  const hasProgress = item.total > 0;
  const pct = hasProgress ? Math.round((item.loaded / item.total) * 100) : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="rounded-lg px-3 py-2.5 hover:bg-muted/20 transition-colors"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">
          <div className="h-3.5 w-3.5 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1">
            <p className="text-[12px] font-medium truncate leading-tight text-foreground/90">{item.name}</p>
            <div className="flex items-center gap-1 shrink-0">{hasProgress && <span className="text-[10px] font-mono text-emerald-400">{pct}%</span>}<button onClick={onCancel} aria-label={`Cancel download ${item.name}`} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"><X className="h-3 w-3" /></button></div>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {hasProgress && <span className="text-[10px] text-muted-foreground/60">{formatBytes(item.loaded)} / {formatBytes(item.total)}</span>}
            {item.speed > 0 && <span className="text-[10px] text-muted-foreground/50">{formatSpeed(item.speed)}</span>}
            {!hasProgress && <span className="text-[10px] text-muted-foreground/40">Downloading…</span>}
          </div>
          {hasProgress && <ProgressBar value={pct} className="mt-1.5" />}
        </div>
      </div>
    </motion.div>
  );
}

// ─── History row (from activity-store) ───────────────────────────────────────

function HistoryRow({ item, onRemove }: { item: ActivityItem; onRemove: () => void }) {
  // Persisted history can outlive the client bundle that created it. Keep
  // unknown types visible instead of allowing one legacy event to crash the
  // entire Activity Center.
  const meta = ACTIVITY_META[item.type] ?? {
    label: "Activity",
    color: "text-muted-foreground",
    bgColor: "bg-muted/60",
  };
  const isFailed = item.status === "failed";
  const isCancelled = item.status === "cancelled";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="group flex items-start gap-2.5 rounded-lg px-3 py-2 hover:bg-muted/20 transition-colors"
    >
      <div className={cn("mt-0.5 rounded-md p-1 shrink-0", meta.bgColor)}>
        <ActivityTypeIcon type={item.type} className={meta.color} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <p className={cn(
              "text-[12px] font-medium truncate leading-tight",
              isFailed ? "text-red-400" : isCancelled ? "text-muted-foreground/50" : "text-foreground/90"
            )}>{item.name}</p>
            {item.detail && <p className="text-[10px] text-muted-foreground/50 truncate mt-0.5">{item.detail}</p>}
            {isFailed && item.error && <p className="text-[10px] text-red-500/70 truncate mt-0.5">{item.error}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-1">
            <span className="text-[10px] text-muted-foreground/40 whitespace-nowrap">
              {item.endedAt ? formatTimeOfDay(item.endedAt) : formatRelativeTime(item.startedAt)}
            </span>
            <button
              onClick={onRemove}
              className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 text-muted-foreground/30 hover:text-muted-foreground/70"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      <div className="mt-0.5 shrink-0">
        <StatusIcon status={item.status} />
      </div>
    </motion.div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-surface/80 backdrop-blur-sm">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[10px] font-mono text-muted-foreground/40">{count}</span>
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
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all",
        active
          ? "bg-foreground/90 text-background shadow-sm"
          : "bg-muted/50 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
      )}
    >
      {label}
      {count > 0 && (
        <span className={cn("tabular-nums", active ? "opacity-60" : "opacity-50")}>{count}</span>
      )}
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
    <div className="px-3 py-2 border-b border-border/20 bg-muted/10">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
          {hasActive && (
            <>
              <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-accent" />{formatSpeed(stats.speed)}</span>
              {stats.eta > 0 && <span>{formatETA(stats.eta)}</span>}
            </>
          )}
          <span className="font-mono">{stats.completed}/{stats.total} files</span>
        </div>
        <div className="flex items-center gap-1">
          {stats.failed > 0 && (
            <button onClick={onRetryFailed} className="text-[10px] text-accent hover:underline">
              Retry {stats.failed} failed
            </button>
          )}
          {hasActive && (
            <button onClick={paused ? onResume : onPause} className="rounded p-1 hover:bg-muted/60 text-muted-foreground/60 hover:text-foreground transition-colors">
              {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>
      {hasActive && (
        <ProgressBar
          value={stats.overallProgress}
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
  onViewAll,
}: PanelContentProps) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent/80" />
          <h2 className="text-sm font-semibold">Activity Center</h2>
          {activeCount > 0 && (
            <span className="text-[10px] font-mono bg-accent/10 text-accent rounded-full px-2 py-0.5">
              {activeCount} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onPinToggle}>
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
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
      <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto no-scrollbar border-b border-border/20 shrink-0">
        {(["all","active","upload","download","move","delete","failed"] as FilterKey[]).map((f) => (
          <FilterChip
            key={f}
            label={f === "all" ? "All" : f === "active" ? "Active" : f.charAt(0).toUpperCase() + f.slice(1)}
            active={filter === f} count={counts[f]}
            onClick={() => onFilterChange(f)}
          />
        ))}
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border/20 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
          <Input
            value={search} onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search activity…"
            className="pl-8 h-8 text-[12px] bg-muted/30 border-transparent"
          />
          {search && (
            <button onClick={() => onSearchChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-foreground transition-colors">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {(filter === "all" || filter === "active" || filter === "upload") && liveUploads.length > 0 && (
          <div>
            <SectionHeader label="Uploading" count={liveUploads.length} />
            <AnimatePresence mode="popLayout">
              {liveUploads.map((item) => (
                <UploadRow key={item.id} item={item}
                  onRetry={() => uploadQueue?.retryItem(item.id)}
                  onCancel={() => uploadQueue?.cancelItem(item.id)} />
              ))}
            </AnimatePresence>
          </div>
        )}

        {(filter === "all" || filter === "active" || filter === "download") && activeDownloads.length > 0 && (
          <div>
            <SectionHeader label="Downloading" count={activeDownloads.length} />
            <AnimatePresence mode="popLayout">
              {activeDownloads.map((item) => <DownloadRow key={item.id} item={item} onCancel={() => cancelDownload(item.id)} />)}
            </AnimatePresence>
          </div>
        )}

        {filter !== "active" && (
          <>
            {todayItems.length > 0 && (
              <div>
                <SectionHeader label="Today" count={todayItems.length} />
                <AnimatePresence mode="popLayout">
                  {todayItems.map((item) => (
                    <HistoryRow key={item.id} item={item} onRemove={() => removeActivity(item.id)} />
                  ))}
                </AnimatePresence>
              </div>
            )}
            {yesterdayItems.length > 0 && (
              <div>
                <SectionHeader label="Yesterday" count={yesterdayItems.length} />
                <AnimatePresence mode="popLayout">
                  {yesterdayItems.map((item) => (
                    <HistoryRow key={item.id} item={item} onRemove={() => removeActivity(item.id)} />
                  ))}
                </AnimatePresence>
              </div>
            )}
            {olderItems.length > 0 && (
              <div>
                <SectionHeader label="Earlier" count={olderItems.length} />
                <AnimatePresence mode="popLayout">
                  {olderItems.map((item) => (
                    <HistoryRow key={item.id} item={item} onRemove={() => removeActivity(item.id)} />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </>
        )}

        {liveUploads.length === 0 && activeDownloads.length === 0 && historyItems.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="rounded-full bg-muted/40 p-4 mb-3">
              <Activity className="h-6 w-6 text-muted-foreground/30" />
            </div>
            <p className="text-[13px] font-medium text-muted-foreground/60">No activity yet</p>
            <p className="text-[11px] text-muted-foreground/40 mt-1">
              Uploads, downloads, and file actions will appear here
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      {activities.length > 0 && (
        <div className="border-t border-border/20 px-3 py-2 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/40">
            {activities.length} item{activities.length !== 1 ? "s" : ""} in history
          </span>
          <button
            onClick={clearActivityHistory}
            className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-red-500 transition-colors rounded px-2 py-1 hover:bg-red-500/5"
          >
            <Trash className="h-3 w-3" /> Clear history
          </button>
        </div>
      )}
      <button onClick={onViewAll} className="flex min-h-11 w-full items-center justify-center gap-2 border-t border-border/20 px-3 text-xs font-medium text-accent transition-colors hover:bg-accent/5">
        View all activity <ExternalLink className="h-3.5 w-3.5" />
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
      className={cn("fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface/95 shadow-[0_24px_90px_rgba(0,0,0,0.38)] backdrop-blur-2xl", minimized ? "h-auto" : "max-sm:!left-2 max-sm:!top-2 max-sm:!h-[calc(100dvh-1rem)] max-sm:!w-[calc(100vw-1rem)]")}
      style={maximized ? { inset: "1rem", width: "auto", height: "auto" } : { left: geometry.x, top: geometry.y, width: `min(calc(100vw - 1rem), ${geometry.width}px)`, height: minimized ? "auto" : `min(calc(100dvh - ${geometry.y + 16}px), ${geometry.height}px)` }}
    >
      <div
        className="flex min-h-14 shrink-0 cursor-move items-center justify-between border-b border-border/50 bg-foreground/[0.025] px-4"
        onPointerDown={(event) => { if (maximized) return; dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, x: geometry.x, y: geometry.y }; }}
      >
        <div className="flex min-w-0 items-center gap-2"><GripVertical className="h-4 w-4 text-muted-foreground/50" /><div><div className="flex items-center gap-2"><h2 className="text-sm font-semibold tracking-tight">File Activity Center</h2><span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />Live</span></div><p className="text-[11px] text-muted-foreground">{totalTasks} files · {uploadStats.completed} completed · {activeTasks} processing · {queuedTasks} queued</p></div></div>
        <div className="flex items-center gap-0.5" onPointerDown={(event) => event.stopPropagation()}>
          <button aria-label={minimized ? "Restore activity window" : "Minimize activity window"} onClick={() => setMinimized((value) => !value)} className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">{minimized ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}</button>
          <button aria-label={maximized ? "Restore activity window" : "Maximize activity window"} onClick={() => setMaximized((value) => !value)} className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"><Maximize2 className="h-4 w-4" /></button>
          <button aria-label="Close activity window" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {!minimized && <>
        <div className="shrink-0 border-b border-border/40 px-4 py-4"><div className="mb-2 flex items-end justify-between"><div><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Overall progress</p><p className="mt-1 text-2xl font-semibold tabular-nums">{overall}%</p></div><p className="text-xs text-muted-foreground">{formatBytes(loadedBytes)} / {formatBytes(totalBytes)}</p></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${overall}%` }} role="progressbar" aria-label="Overall transfer progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall} /></div><div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{totalTasks} files</span><span>{uploadStats.completed} completed</span><span>{activeTasks} processing</span><span>{queuedTasks} queued</span>{failedTasks > 0 && <span className="text-red-400">{failedTasks} failed</span>}</div></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {liveUploads.map((item) => { const failed = item.status === "error"; const progress = Math.round(item.progress); return <div key={item.id} className="rounded-xl border border-border/40 px-3 py-3"><div className="flex items-start gap-3"><div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", failed ? "bg-red-500/10 text-red-400" : "bg-accent/10 text-accent")}>{failed ? <AlertCircle className="h-4 w-4" /> : item.status === "queued" ? <Clock className="h-4 w-4" /> : <Upload className="h-4 w-4" />}</div><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.file?.name ?? item.remotePath}</p><p className={cn("mt-0.5 text-xs", failed ? "text-red-400" : "text-muted-foreground")}>{failed ? item.error ?? "Upload failed" : item.status === "preparing" ? "Preparing" : item.status === "verifying" ? "Verifying" : item.status === "queued" ? "Queued" : "Uploading"}</p></div><span className="font-mono text-xs text-accent">{item.status === "preparing" ? "--" : `${progress}%`}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full transition-[width] duration-200", failed ? "bg-red-500" : "bg-accent")} style={{ width: `${progress}%` }} /></div><p className="mt-2 text-[11px] text-muted-foreground">{formatBytes(item.uploadedBytes)} / {formatBytes(item.totalBytes)}{item.speed > 0 ? ` · ${formatSpeed(item.speed)}` : ""}</p>{failed && <button onClick={onRetryFailed} className="mt-2 min-h-9 rounded-lg border border-accent/25 px-3 text-xs font-medium text-accent hover:bg-accent/10">Retry</button>}</div></div></div>; })}
          {activeDownloads.map((item) => { const progress = item.total > 0 ? Math.round((item.loaded / item.total) * 100) : 0; return <div key={item.id} className="rounded-xl border border-border/40 px-3 py-3"><div className="flex items-start gap-3"><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400"><Download className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.name}</p><p className="mt-0.5 text-xs text-muted-foreground">Downloading</p></div><div className="flex items-center gap-1"><span className="font-mono text-xs text-emerald-400">{item.total > 0 ? `${progress}%` : "Live"}</span><button aria-label={`Cancel download ${item.name}`} onClick={() => onCancelDownload(item.id)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"><X className="h-3 w-3" /></button></div></div>{item.total > 0 && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${progress}%` }} /></div>}<p className="mt-2 text-[11px] text-muted-foreground">{item.total > 0 ? `${formatBytes(item.loaded)} / ${formatBytes(item.total)}` : "Preparing download"}{item.speed > 0 ? ` · ${formatSpeed(item.speed)}` : ""}</p></div></div></div>; })}
          {liveUploads.length === 0 && activeDownloads.length === 0 && <div className="px-4 py-10 text-center text-sm text-muted-foreground">No transfers are currently running.</div>}
          {activities.slice(0, 8).map((item) => <div key={item.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5"><div className="rounded-lg bg-muted p-2 text-muted-foreground"><ActivityTypeIcon type={item.type} /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{item.name}</p><p className="text-[11px] text-muted-foreground">{item.error ?? labelStatus(item.status)}</p></div><StatusIcon status={item.status} /></div>)}
        </div>
        <div className="flex shrink-0 items-center justify-between border-t border-border/40 px-3 py-2"><button onClick={onViewAll} className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-xs font-medium text-accent hover:bg-accent/10">View all activity <ExternalLink className="h-3.5 w-3.5" /></button><span className="text-[10px] text-muted-foreground/60">State is synced from the transfer engine</span></div>
        {!maximized && <div onPointerDown={(event) => { event.stopPropagation(); resizeRef.current = { pointerX: event.clientX, pointerY: event.clientY, width: geometry.width, height: geometry.height }; }} className="absolute bottom-1 right-1 hidden h-5 w-5 cursor-se-resize sm:block"><GripVertical className="h-4 w-4 rotate-[-45deg] text-muted-foreground/40" /></div>}
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
  const [open, setOpen] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [pinned, setPinned] = useState(false);
  const [paused, setPaused] = useState(false);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ items: ActivityItem[] }>("/api/activity?limit=200").then((response) => {
      if (!cancelled && response.success && response.data?.items) hydrateActivities(response.data.items);
    });
    return () => { cancelled = true; };
  }, []);

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
    return () => { uploadQueue.off("change"); };
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

  const viewAll = useCallback(() => {
    if (canUseActivityPopup()) {
      setOpen(false);
      setWindowOpen(false);
      if (openActivityPopup()) return;
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
        onClick={() => {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => setOpen((value) => !value), 220);
        }}
        onDoubleClick={() => {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          viewAll();
        }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        aria-label="Activity Center"
        className={cn(
          // Desktop: fixed top-right corner, above page content
          inline ? "relative z-50 flex items-center justify-center" : "fixed z-50 flex items-center justify-center",
          // Mobile: sits in the header bar row (top-safe + centered vertically)
          !inline && "top-[calc(var(--safe-top,0px)+0.6rem)] right-3 lg:top-3 lg:right-5",
          // Shape: icon button with subtle pill on desktop hover
          "h-9 w-9 rounded-xl",
          "border border-transparent",
          "bg-transparent hover:bg-muted/60",
          "transition-all duration-150",
          open && "bg-accent/10 border-accent/25 text-accent",
          !open && "text-muted-foreground hover:text-foreground"
        )}
      >
        {/* Icon + animated badge */}
        <span className="relative">
          <Activity className="h-[18px] w-[18px]" />
          <AnimatePresence>
            {activeCount > 0 && (
              <motion.span
                key="active-badge"
                initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                className={cn(
                  "absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-[3px]",
                  "rounded-full bg-accent text-[8px] font-bold text-background",
                  "flex items-center justify-center",
                  "ring-2 ring-background"
                )}
              >
                {activeCount > 9 ? "9+" : activeCount}
              </motion.span>
            )}
            {activeCount === 0 && totalFailed > 0 && (
              <motion.span
                key="failed-badge"
                initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                className={cn(
                  "absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-[3px]",
                  "rounded-full bg-red-500 text-[8px] font-bold text-white",
                  "flex items-center justify-center",
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
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-40 lg:bg-black/10 bg-black/40"
              onClick={() => !pinned && setOpen(false)}
            />

            {/* ── Desktop panel: drops down from top-right ── */}
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
              className={cn(
                "fixed z-50 flex-col overflow-hidden",
                "hidden lg:flex",
                "h-dvh max-h-none w-[400px] rounded-l-2xl rounded-r-none border-y border-l border-border/50",
                "bg-surface/95 backdrop-blur-3xl",
                "shadow-[0_8px_48px_rgba(0,0,0,0.28)]",
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
              />
            </motion.div>

            {/* ── Mobile panel: full-width bottom sheet ── */}
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 38 }}
              className={cn(
                "fixed z-50 flex flex-col overflow-hidden",
                "lg:hidden",
                "inset-x-0 bottom-0",
                "rounded-t-3xl border-t border-x border-border/40",
                "bg-surface/98 backdrop-blur-3xl",
                "shadow-[0_-8px_48px_rgba(0,0,0,0.35)]",
                "h-[85dvh]"
              )}
            >
              {/* Drag handle */}
              <div className="mx-auto mt-3 mb-1 h-1 w-10 rounded-full bg-border/50 shrink-0" />
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
    </>
  );
}
