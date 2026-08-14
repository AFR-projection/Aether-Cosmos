"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Activity, ChevronDown, Clock3, Copy, Download, Edit3, FolderInput,
  FolderPlus, LoaderCircle, RotateCcw, Search, Trash2, Upload,
} from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { cn, formatBytes } from "@/lib/utils";
import { EMPTY_ACTIVITIES, getActivities, hydrateActivities, subscribeActivities, clearActivityHistory, type ActivityItem } from "@/lib/activity/activity-store";
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

function TimelineItem({ item }: { item: ActivityItem }) {
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const active = !failed && !cancelled && !["done", "completed"].includes(item.status);
  return (
    <article className="relative grid grid-cols-[40px_minmax(0,1fr)_auto] gap-3 border-b border-border/40 px-4 py-4 last:border-0 sm:px-6">
      <div className={cn(
        "relative z-10 flex h-9 w-9 items-center justify-center rounded-xl border",
        failed ? "border-red-500/25 bg-red-500/10 text-red-400" : cancelled ? "border-border bg-muted text-muted-foreground" : active ? "border-accent/30 bg-accent/10 text-accent" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
      )}>
        {active ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ActivityIcon type={item.type} />}
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">{item.name}</h3>
          <span className="rounded-full border border-border/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{item.type}</span>
        </div>
        <p className={cn("mt-1 text-xs", failed ? "text-red-400" : "text-muted-foreground")}>{item.error ?? item.detail ?? labelStatus(item.status)}</p>
        {(item.source || item.destination) && <p className="mt-1 truncate text-xs text-muted-foreground/70">{item.source ?? ""}{item.source && item.destination ? " -> " : ""}{item.destination ?? ""}</p>}
        {item.total && item.total > 0 && <p className="mt-1 text-[11px] text-muted-foreground/70">{formatBytes(item.loaded ?? 0)} / {formatBytes(item.total)}</p>}
      </div>
      <time className="pt-1 text-right text-[11px] text-muted-foreground/60" dateTime={new Date(item.startedAt).toISOString()}>
        {new Date(item.endedAt ?? item.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </time>
    </article>
  );
}

function LiveTransfers({ items, stats }: { items: UploadItem[]; stats: UploadStats }) {
  const live = items.filter((item) => !["done", "cancelled"].includes(item.status));
  if (live.length === 0) return null;
  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-accent/[0.045] shadow-[0_16px_50px_rgba(37,99,235,0.08)]">
      <div className="flex items-center justify-between border-b border-accent/15 px-5 py-4">
        <div><p className="text-sm font-semibold">Live transfers</p><p className="mt-0.5 text-xs text-muted-foreground">Connected to the local transfer engine</p></div>
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />Live</span>
      </div>
      <div className="space-y-1 p-3">
        {live.map((item) => (
            <div key={item.id} className="rounded-xl px-2 py-3 sm:px-3">
            <div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.file?.name ?? item.remotePath}</p><p className="mt-1 text-xs text-muted-foreground">{item.status === "preparing" ? "Preparing" : item.status === "verifying" ? "Verifying" : item.status === "queued" ? "Queued" : "Uploading"} · {formatBytes(item.uploadedBytes)} / {formatBytes(item.totalBytes)} · {formatSpeed(item.speed)}</p></div><span className="font-mono text-xs text-accent">{item.status === "preparing" ? "--" : `${Math.round(item.progress)}%`}</span></div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.min(100, item.progress)}%` }} /></div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-4 border-t border-accent/15 px-5 py-3 text-xs text-muted-foreground"><span>{stats.total} files</span><span>{stats.completed} completed</span><span>{stats.active} active</span><span>{stats.queued} queued</span><span>{formatETA(stats.eta)}</span></div>
    </section>
  );
}

export function ActivityPage() {
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

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ items: ActivityItem[] }>("/api/activity?limit=500").then((response) => {
      if (!cancelled && response.success && response.data?.items) hydrateActivities(response.data.items);
    });
    const onChange = (items: UploadItem[], stats: UploadStats) => { setUploadItems(items); setUploadStats(stats); };
    queue.on("change", onChange);
    setUploadItems(queue.getItems());
    setUploadStats(queue.getStats());
    return () => { cancelled = true; queue.off("change"); };
  }, [queue]);

  const sharedUploadActivities = useMemo(
    () => activities.filter((item) => item.id.startsWith("transfer-") && item.type === "upload"),
    [activities]
  );
  const sharedLiveUploads = useMemo(
    () => sharedUploadActivities.filter((item) => !["done", "completed", "failed", "cancelled"].includes(item.status)).map(activityUploadItem),
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
        <div><div className="flex items-center gap-3"><div className="rounded-2xl border border-accent/20 bg-accent/10 p-3 text-accent"><Activity className="h-5 w-5" /></div><div><div className="flex items-center gap-2"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">File Activity Center</p><span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />Live</span></div><h1 className="text-3xl font-bold tracking-tight">File Activity</h1></div></div><p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Monitor uploads, downloads, and every change made to your files in real time.</p></div>
         <div className="flex flex-wrap items-center gap-2"><label className="flex min-h-11 items-center gap-2 rounded-xl border border-border/60 px-3 text-xs text-muted-foreground"><span>Period</span><select aria-label="Filter activity by date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value as DateFilter)} className="bg-transparent font-medium text-foreground outline-none"><option value="all">Any date</option><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label><button onClick={clearActivityHistory} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border/60 px-4 text-sm font-medium text-muted-foreground transition-colors hover:border-red-500/30 hover:bg-red-500/5 hover:text-red-400"><Trash2 className="h-4 w-4" />Clear history</button></div>
      </header>

       <LiveTransfers items={visibleUploadItems} stats={visibleUploadStats} />

      <section className="overflow-hidden rounded-2xl border border-border/60 bg-surface/80 shadow-[0_20px_70px_rgba(0,0,0,0.08)]">
        <div className="flex flex-col gap-3 border-b border-border/50 p-4 sm:p-5"><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" /><input aria-label="Search activity" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files or activity details" className="h-11 w-full rounded-xl border border-border/60 bg-background/70 pl-10 pr-4 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-accent/50 focus:ring-2 focus:ring-accent/15" /></div><div className="flex flex-wrap items-center gap-2"><div className="flex max-w-full gap-1 overflow-x-auto pb-1">{TYPES.map((item) => <button key={item} onClick={() => setType(item)} className={cn("min-h-9 shrink-0 rounded-lg px-3 text-xs font-medium transition-colors", type === item ? "bg-foreground text-background" : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground")}>{item === "all" ? "All" : item.charAt(0).toUpperCase() + item.slice(1)}</button>)}</div><label className="ml-auto flex h-9 items-center gap-2 rounded-lg border border-border/60 px-2.5 text-xs text-muted-foreground"><span className="sr-only">Filter status</span><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="bg-transparent outline-none"><option value="all">All statuses</option><option value="processing">Processing</option><option value="success">Success</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label><label className="flex h-9 items-center gap-2 rounded-lg border border-border/60 px-2.5 text-xs text-muted-foreground"><ChevronDown className="h-3.5 w-3.5" /><span className="sr-only">Sort activity</span><select value={sort} onChange={(event) => setSort(event.target.value as "newest" | "oldest")} className="bg-transparent outline-none"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label></div></div>
        <div className="flex items-center justify-between px-4 py-3 text-xs text-muted-foreground sm:px-6"><span>{filtered.length} event{filtered.length === 1 ? "" : "s"}</span><span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />Timeline</span></div>
        {filtered.length > 0 ? <div>{filtered.map((item) => <TimelineItem key={item.id} item={item} />)}</div> : <div className="flex flex-col items-center px-6 py-20 text-center"><Activity className="mb-3 h-8 w-8 text-muted-foreground/30" /><p className="text-sm font-medium">No matching activity</p><p className="mt-1 text-xs text-muted-foreground">Try another filter or search term.</p></div>}
      </section>
    </main>
  );
}
