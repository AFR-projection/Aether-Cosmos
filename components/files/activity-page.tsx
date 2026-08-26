"use client";

import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import {
  Activity, ArrowRight, ChevronDown, Clock3, Copy, Download, Edit3, FolderIcon,
  FolderInput, FolderPlus, LoaderCircle, RotateCcw, Search, Trash2, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { apiFetch } from "@/lib/api/client";
import { cn, formatBytes } from "@/lib/utils";
import { configureActivityScope, EMPTY_ACTIVITIES, getActivities, hydrateActivities, subscribeActivities, clearActivityHistory, type ActivityItem } from "@/lib/activity/activity-store";
import { subscribeActivityIdentity } from "@/lib/activity/activity-identity";
import { configureDownloadScope } from "@/lib/download/download-store";
import { configureEncryptedDownloadScope } from "@/lib/download/encrypted-download-store";
import { getSharedUploadQueue, formatETA, formatSpeed, type UploadItem, type UploadStats } from "@/lib/upload-queue";

const TYPES = ["all", "upload", "download", "move", "copy", "rename", "delete", "restore"] as const;
type TypeFilter = typeof TYPES[number];
type StatusFilter = "all" | "processing" | "success" | "failed" | "cancelled";
type DateFilter = "all" | "today" | "7d" | "30d";

const iconByType: Record<string, typeof Activity> = {
  upload: Upload,
  download: Download,
  move: FolderInput,
  copy: Copy,
  rename: Edit3,
  delete: Trash2,
  restore: RotateCcw,
  create_folder: FolderPlus,
};

/** The stored type is a key (`create_folder`); a row has to read as English. */
const typeLabel: Record<string, string> = {
  upload: "Upload",
  download: "Download",
  move: "Moved",
  copy: "Copied",
  rename: "Renamed",
  delete: "Deleted",
  restore: "Restored",
  create_folder: "Folder created",
};

function labelStatus(status: string) {
  if (status === "done" || status === "completed") return "Completed";
  if (status === "active") return "Processing";
  if (status === "queued") return "Queued";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function activityUploadItem(item: ActivityItem): UploadItem {
  const status: UploadItem["status"] = item.status === "completed" || item.status === "done"
    ? "done"
    : item.status === "failed"
      ? "error"
      : item.status === "cancelled"
        ? "cancelled"
        : item.status === "paused"
          ? "resume_requires_file"
          : item.status === "preparing"
            ? "preparing"
            : item.status === "verifying"
              ? "verifying"
              : item.status === "queued"
                ? "queued"
                : "uploading";
  return {
    id: item.id,
    file: null,
    folderId: null,
    remotePath: item.name,
    status,
    progress: item.progress ?? 0,
    uploadedBytes: item.loaded ?? 0,
    totalBytes: item.total ?? 0,
    speed: item.speed ?? 0,
    error: item.error,
    fileId: item.fileId,
    retries: 0,
  };
}

function ActivityIcon({ type }: { type: string }) {
  const Icon = iconByType[type] ?? Activity;
  return <Icon className="h-4 w-4" aria-hidden="true" />;
}

function TimelineDetail({ item }: { item: ActivityItem }) {
  const { type, detail, source, destination, error, status, loaded, total } = item;

  if (error) return <p className="mt-1 text-xs text-danger">{error}</p>;

  if (type === "rename") {
    const newName = detail?.startsWith("→") ? detail.slice(1).trim() : detail;
    if (newName) {
      return (
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="max-w-[180px] truncate font-mono">{item.name}</span>
          <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="max-w-[200px] truncate font-mono font-medium text-foreground">{newName}</span>
        </p>
      );
    }
  }

  if (type === "move" || type === "copy") {
    if (source || destination) {
      return (
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {source && (
            <>
              <FolderIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="max-w-[140px] truncate">{source}</span>
            </>
          )}
          {source && destination && <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
          {destination && (
            <>
              <FolderIcon className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
              <span className="max-w-[140px] truncate font-medium text-foreground">{destination}</span>
            </>
          )}
        </p>
      );
    }
  }

  if ((type === "upload" || type === "download") && total && total > 0) {
    return (
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
        {formatBytes(loaded ?? 0)} / {formatBytes(total)}
      </p>
    );
  }

  return <p className="mt-1 text-xs text-muted-foreground">{detail ?? labelStatus(status)}</p>;
}

function TimelineItem({ item }: { item: ActivityItem }) {
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const active = !failed && !cancelled && !["done", "completed"].includes(item.status);
  const stamp = item.endedAt ?? item.startedAt;

  const titleName = item.type === "rename" && item.detail?.startsWith("→")
    ? item.detail.slice(1).trim()
    : item.name;

  return (
    <article className="relative grid grid-cols-[40px_minmax(0,1fr)_auto] gap-3 border-b border-border/40 px-4 py-4 last:border-0 sm:px-6">
      <div className={cn(
        "relative z-10 flex h-9 w-9 items-center justify-center rounded-xl border",
        failed
          ? "border-danger/25 bg-danger/10 text-danger"
          : cancelled
            ? "border-border bg-muted text-muted-foreground"
            : active
              ? "border-accent/30 bg-accent/10 text-accent"
              : "border-success/25 bg-success/10 text-success"
      )}>
        {active ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ActivityIcon type={item.type} />}
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground" title={titleName}>
            {titleName}
          </h3>
          <span className="rounded-full border border-border/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {typeLabel[item.type] ?? "Activity"}
          </span>
          <span className="sr-only">{labelStatus(item.status)}.</span>
        </div>
        <TimelineDetail item={item} />
      </div>
      <time className="pt-1 text-right text-xs tabular-nums text-muted-foreground" dateTime={new Date(stamp).toISOString()}>
        {new Date(stamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </time>
    </article>
  );
}

function LiveTransfers({ items, stats }: { items: UploadItem[]; stats: UploadStats }) {
  const live = items.filter((item) => !["done", "cancelled", "resume_requires_file"].includes(item.status));
  if (live.length === 0) return null;
  return (
    <section
      aria-label="Live transfers"
      className="mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-accent/[0.045] shadow-lg"
    >
      <div className="flex items-center justify-between gap-3 border-b border-accent/15 px-5 py-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Live transfers</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Connected to the local transfer engine</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
          Live
        </span>
      </div>
      <ul className="space-y-1 p-3">
        {live.map((item) => {
          const name = item.file?.name ?? item.remotePath;
          const progress = Math.round(Math.min(100, item.progress));
          return (
            <li key={item.id} className="rounded-xl px-2 py-3 sm:px-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground" title={name}>
                    {name}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.status === "preparing"
                      ? "Preparing"
                      : item.status === "verifying"
                        ? "Verifying"
                        : item.status === "queued"
                          ? "Queued"
                          : "Uploading"}
                    {" · "}
                    {formatBytes(item.uploadedBytes)} / {formatBytes(item.totalBytes)}
                    {item.speed > 0 ? ` · ${formatSpeed(item.speed)}` : ""}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums text-accent">
                  {item.status === "preparing" ? "--" : `${progress}%`}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`Uploading ${name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-accent/15 px-5 py-3 text-xs text-muted-foreground">
        <span>{stats.total} files</span>
        <span>{stats.completed} completed</span>
        <span>{stats.active} active</span>
        <span>{stats.queued} queued</span>
        {stats.eta > 0 && <span>{formatETA(stats.eta)} left</span>}
      </div>
    </section>
  );
}

export function ActivityPage({ scopeId }: { scopeId: string }) {
  configureActivityScope(scopeId);
  configureDownloadScope(scopeId);
  configureEncryptedDownloadScope(scopeId);
  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [now, setNow] = useState(0);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploadStats, setUploadStats] = useState<UploadStats>(() => getSharedUploadQueue().getStats());
  const activities = useSyncExternalStore(subscribeActivities, getActivities, () => EMPTY_ACTIVITIES);
  const queue = getSharedUploadQueue();
  const { askConfirm, dialogs } = useDialogs();
  const searchId = useId();
  const statusId = useId();
  const sortId = useId();

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ scopeId: string; items: ActivityItem[] }>(`/api/activity?scopeId=${encodeURIComponent(scopeId)}&limit=500`).then((response) => {
      if (!cancelled && response.success && response.data?.items) hydrateActivities(response.data.items, response.data.scopeId);
    });
    const onChange = (items: UploadItem[], stats: UploadStats) => { setUploadItems(items); setUploadStats(stats); };
    queue.on("change", onChange);
    setUploadItems(queue.getItems());
    setUploadStats(queue.getStats());
    return () => { cancelled = true; queue.off("change", onChange); };
  }, [queue, scopeId]);

  useEffect(() => subscribeActivityIdentity((message) => {
    if (!message.previousScopeId || message.previousScopeId !== scopeId) return;
    configureActivityScope(null);
    configureDownloadScope(null);
    configureEncryptedDownloadScope(null);
    window.location.href = "/login";
  }), [scopeId]);

  const sharedUploadActivities = useMemo(
    () => activities.filter((item) => item.id.startsWith("transfer-") && item.type === "upload"),
    [activities]
  );
  const sharedLiveUploads = useMemo(
    () => sharedUploadActivities.filter((item) => !["done", "completed", "failed", "cancelled", "paused"].includes(item.status)).map(activityUploadItem),
    [sharedUploadActivities]
  );
  const visibleUploadItems = useMemo(() => {
    if (sharedUploadActivities.length === 0) return uploadItems;
    const names = new Set(sharedUploadActivities.map((item) => item.name));
    return [...sharedLiveUploads, ...uploadItems.filter((item) => !names.has(item.file?.name ?? item.remotePath))];
  }, [sharedLiveUploads, sharedUploadActivities, uploadItems]);
  const visibleUploadStats = useMemo<UploadStats>(() => {
    if (sharedUploadActivities.length === 0) return uploadStats;
    const totalBytes = sharedUploadActivities.reduce((sum, item) => sum + (item.total ?? 0), 0);
    const loadedBytes = sharedUploadActivities.reduce((sum, item) => sum + Math.min(item.loaded ?? 0, item.total ?? item.loaded ?? 0), 0);
    const completed = sharedUploadActivities.filter((item) => item.status === "done" || item.status === "completed").length;
    const failed = sharedUploadActivities.filter((item) => item.status === "failed").length;
    const active = sharedUploadActivities.filter((item) => !["done", "completed", "failed", "cancelled", "queued"].includes(item.status)).length;
    const queued = sharedUploadActivities.filter((item) => item.status === "queued").length;
    const speed = sharedUploadActivities.reduce((sum, item) => sum + (item.speed ?? 0), 0);
    return { total: sharedUploadActivities.length, completed, failed, active, queued, totalBytes, loadedBytes, overallProgress: totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0, speed, eta: speed > 0 ? (totalBytes - loadedBytes) / speed : 0 };
  }, [sharedUploadActivities, uploadStats]);

  const clearHistory = useCallback(async () => {
    // The timeline is the only record of what happened to a file after the
    // fact, so wiping it asks first.
    const ok = await askConfirm({
      title: "Clear the activity history?",
      message: "Every event below is removed from the timeline. The files themselves are not touched.",
      confirmText: "Clear history",
      danger: true,
    });
    if (ok) clearActivityHistory();
  }, [askConfirm]);

  const filtered = useMemo(() => [...activities]
    .filter((item) => type === "all" || item.type === type)
    .filter((item) => {
      if (status === "all") return true;
      if (status === "success") return item.status === "done" || item.status === "completed";
      if (status === "processing") return !["done", "completed", "failed", "cancelled"].includes(item.status);
      return item.status === status;
    })
    .filter((item) => {
      if (dateFilter === "all") return true;
      const days = dateFilter === "today" ? 1 : dateFilter === "7d" ? 7 : 30;
      return now > 0 && item.startedAt >= now - days * 86_400_000;
    })
    .filter((item) => `${item.name} ${item.detail ?? ""} ${item.error ?? ""}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const delta = (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
      return sort === "newest" ? delta : -delta;
    }), [activities, dateFilter, now, search, sort, status, type]);

  return (
    <main className="mx-auto min-h-dvh w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6 lg:px-8">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="rounded-2xl border border-accent/20 bg-accent/10 p-3 text-accent">
              <Activity className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                  File Activity Center
                </p>
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
                  Live
                </span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">File Activity</h1>
            </div>
          </div>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Monitor uploads, downloads, and every change made to your files in real time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 rounded-xl border border-border/60 px-3 text-xs text-muted-foreground">
            <span>Period</span>
            <select
              aria-label="Filter activity by date"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value as DateFilter)}
              className="bg-transparent font-medium text-foreground outline-none"
            >
              <option value="all">Any date</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <Button variant="secondary" onClick={() => void clearHistory()}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Clear history
          </Button>
        </div>
      </header>

      <LiveTransfers items={visibleUploadItems} stats={visibleUploadStats} />

      <section className="overflow-hidden rounded-2xl border border-border/60 bg-surface/80 shadow-xl">
        <div className="flex flex-col gap-3 border-b border-border/50 p-4 sm:p-5">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Search activity
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={searchId}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search files or activity details"
              className="h-11 pl-10"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Filter by type" className="flex max-w-full gap-1 overflow-x-auto pb-1">
              {TYPES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setType(item)}
                  aria-pressed={type === item}
                  className={cn(
                    "h-9 shrink-0 rounded-lg px-3 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                    type === item
                      ? "bg-accent text-white"
                      : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {item === "all" ? "All" : typeLabel[item] ?? item}
                </button>
              ))}
            </div>
            <label
              htmlFor={statusId}
              className="ml-auto flex h-9 items-center gap-2 rounded-lg border border-border/60 px-2.5 text-xs text-muted-foreground"
            >
              <span className="sr-only">Filter by status</span>
              <select
                id={statusId}
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
                className="bg-transparent text-foreground outline-none"
              >
                <option value="all">All statuses</option>
                <option value="processing">Processing</option>
                <option value="success">Success</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label
              htmlFor={sortId}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/60 px-2.5 text-xs text-muted-foreground"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Sort the timeline</span>
              <select
                id={sortId}
                value={sort}
                onChange={(event) => setSort(event.target.value as "newest" | "oldest")}
                className="bg-transparent text-foreground outline-none"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground sm:px-6">
          <span role="status">
            {filtered.length} event{filtered.length === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
            Timeline
          </span>
        </div>
        {filtered.length > 0 ? (
          <div>
            {filtered.map((item) => (
              <TimelineItem key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center px-6 py-20 text-center">
            <Activity className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No matching activity</p>
            <p className="mt-1 text-xs text-muted-foreground">Try another filter or search term.</p>
          </div>
        )}
      </section>
      {dialogs}
    </main>
  );
}
