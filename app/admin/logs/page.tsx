"use client";

import { Suspense, useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ScrollText, Search, RefreshCw, Activity, Upload, Download, Trash2, Loader2, FileDown, ChevronDown, LogIn, LogOut, Share2, Edit3, FolderPlus, FolderMinus, UserPlus, UserMinus, Shield, Star, Clock, Globe, FileText, HardDrive, X, Users, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

const actionConfig: Record<string, { icon: typeof Upload; color: string; bg: string; label: string; description: string }> = {
  login: { icon: LogIn, color: "text-emerald-500", bg: "bg-emerald-500/10", label: "Login", description: "User logged in" },
  logout: { icon: LogOut, color: "text-slate-500 dark:text-slate-400", bg: "bg-slate-400/10", label: "Logout", description: "User logged out" },
  upload: { icon: Upload, color: "text-blue-500", bg: "bg-blue-500/10", label: "Upload", description: "File uploaded" },
  download: { icon: Download, color: "text-violet-500", bg: "bg-violet-500/10", label: "Download", description: "File downloaded" },
  delete: { icon: Trash2, color: "text-red-500", bg: "bg-red-500/10", label: "Delete", description: "File deleted" },
  restore: { icon: Upload, color: "text-amber-500", bg: "bg-amber-500/10", label: "Restore", description: "File restored" },
  share: { icon: Share2, color: "text-cyan-500", bg: "bg-cyan-500/10", label: "Share", description: "File shared" },
  edit: { icon: Edit3, color: "text-orange-500", bg: "bg-orange-500/10", label: "Edit", description: "File metadata edited" },
  rename: { icon: Edit3, color: "text-orange-400", bg: "bg-orange-400/10", label: "Rename", description: "File renamed" },
  move: { icon: HardDrive, color: "text-teal-500", bg: "bg-teal-500/10", label: "Move", description: "File moved" },
  copy: { icon: FileText, color: "text-indigo-400", bg: "bg-indigo-400/10", label: "Copy", description: "File copied" },
  create_folder: { icon: FolderPlus, color: "text-green-500", bg: "bg-green-500/10", label: "Create Folder", description: "Folder created" },
  delete_folder: { icon: FolderMinus, color: "text-red-400", bg: "bg-red-400/10", label: "Delete Folder", description: "Folder deleted" },
  impersonate: { icon: Shield, color: "text-amber-500", bg: "bg-yellow-500/10", label: "Impersonate", description: "Admin impersonated user" },
  create_user: { icon: UserPlus, color: "text-emerald-400", bg: "bg-emerald-400/10", label: "Create User", description: "New user created" },
  update_user: { icon: UserMinus, color: "text-blue-400", bg: "bg-blue-400/10", label: "Update User", description: "User updated" },
  delete_user: { icon: UserMinus, color: "text-red-500", bg: "bg-red-500/10", label: "Delete User", description: "User deleted" },
  suspend_user: { icon: UserMinus, color: "text-orange-500", bg: "bg-orange-500/10", label: "Suspend User", description: "User suspended" },
  favorite: { icon: Star, color: "text-amber-500", bg: "bg-yellow-400/10", label: "Favorite", description: "File favorited" },
  account_lock: { icon: Shield, color: "text-red-500", bg: "bg-red-500/10", label: "Account Lock", description: "Account locked after failed logins" },
  ip_rate_limit: { icon: Globe, color: "text-orange-500", bg: "bg-orange-500/10", label: "IP Rate Limit", description: "IP hit login rate limit" },
  session_revoked: { icon: LogOut, color: "text-rose-500", bg: "bg-rose-500/10", label: "Session Revoked", description: "Session was revoked" },
  password_change: { icon: Shield, color: "text-indigo-500", bg: "bg-indigo-500/10", label: "Password Change", description: "Password was changed" },
};

const filterActions = [
  { value: "", label: "All Actions", icon: Activity },
  { value: "login", label: "Login", icon: LogIn },
  { value: "logout", label: "Logout", icon: LogOut },
  { value: "account_lock", label: "Account Lock", icon: Shield },
  { value: "ip_rate_limit", label: "IP Rate Limit", icon: Globe },
  { value: "session_revoked", label: "Session Revoked", icon: LogOut },
  { value: "password_change", label: "Password Change", icon: Shield },
  { value: "upload", label: "Upload", icon: Upload },
  { value: "download", label: "Download", icon: Download },
  { value: "delete", label: "Delete", icon: Trash2 },
  { value: "share", label: "Share", icon: Share2 },
  { value: "edit", label: "Edit", icon: Edit3 },
  { value: "rename", label: "Rename", icon: Edit3 },
  { value: "create_folder", label: "Create Folder", icon: FolderPlus },
  { value: "delete_folder", label: "Delete Folder", icon: FolderMinus },
  { value: "create_user", label: "Create User", icon: UserPlus },
  { value: "update_user", label: "Update User", icon: UserMinus },
  { value: "delete_user", label: "Delete User", icon: UserMinus },
  { value: "suspend_user", label: "Suspend User", icon: UserMinus },
  { value: "impersonate", label: "Impersonate", icon: Shield },
  { value: "favorite", label: "Favorite", icon: Star },
];

type LogEntry = {
  id: string;
  action: string;
  userId: string;
  ip: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  username: string;
  email: string | null;
  userRole: string;
};

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth}mo ago`;
}

function formatAbsoluteTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString("id-ID", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function DescribeMetadata({ log }: { log: LogEntry }) {
  const meta = log.metadata as Record<string, unknown> | null;
  if (!meta || Object.keys(meta).length === 0) return <span className="text-muted-foreground">—</span>;

  const getDetail = () => {
    switch (log.action) {
      case "upload":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.fileName || "Unknown")}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">{String(meta.mimeType || "Unknown")}</span>
            {meta.size != null && (
              <>
                <span className="text-muted-foreground"> · </span>
                <span className="text-muted-foreground">{formatBytes(Number(meta.size))}</span>
              </>
            )}
          </>
        );
      case "download":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.fileName || "Unknown")}</span>
            {meta.source && (
              <>
                <span className="text-muted-foreground"> · via </span>
                <span className="text-cyan-500 font-medium">{String(meta.source)}</span>
              </>
            )}
          </>
        );
      case "delete":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.fileName || "Unknown")}</span>
            {meta.folder != null && (
              <>
                <span className="text-muted-foreground"> in </span>
                <span className="text-muted-foreground">/{String(meta.folder)}</span>
              </>
            )}
          </>
        );
      case "share":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.fileName || "Unknown")}</span>
            {meta.permission && (
              <>
                <span className="text-muted-foreground"> as </span>
                <span className={cn("font-medium", meta.permission === "edit" ? "text-orange-500" : "text-blue-500")}>
                  {String(meta.permission)}
                </span>
              </>
            )}
            {meta.phone && (
              <>
                <span className="text-muted-foreground"> → </span>
                <span className="text-muted-foreground">{String(meta.phone)}</span>
              </>
            )}
          </>
        );
      case "login":
        return (
          <>
            {meta.userAgent && (
              <span className="text-muted-foreground line-clamp-1">{String(meta.userAgent)}</span>
            )}
          </>
        );
      case "create_user":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.username || "Unknown")}</span>
            {meta.role && (
              <>
                <span className="text-muted-foreground"> as </span>
                <span className={cn("font-medium", meta.role === "master" ? "text-yellow-500" : "text-emerald-500")}>
                  {String(meta.role)}
                </span>
              </>
            )}
          </>
        );
      case "update_user":
      case "suspend_user":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.username || meta.targetUserId || "Unknown")}</span>
            {meta.status && (
              <>
                <span className="text-muted-foreground"> → </span>
                <span className={cn("font-medium", meta.status === "active" ? "text-emerald-500" : "text-red-500")}>
                  {String(meta.status)}
                </span>
              </>
            )}
          </>
        );
      case "create_folder":
      case "delete_folder":
        return <span className="font-medium text-foreground">{String(meta.folderName || "Unknown")}</span>;
      case "rename":
        return (
          <>
            <span className="text-muted-foreground">{String(meta.oldName || "Unknown")}</span>
            <span className="text-muted-foreground"> → </span>
            <span className="font-medium text-foreground">{String(meta.newName || "Unknown")}</span>
          </>
        );
      case "move":
        return (
          <>
            <span className="font-medium text-foreground">{String(meta.fileName || "Unknown")}</span>
            {meta.destination && (
              <>
                <span className="text-muted-foreground"> → </span>
                <span className="text-muted-foreground">/{String(meta.destination)}</span>
              </>
            )}
          </>
        );
      case "impersonate":
        return (
          <>
            <span className="text-muted-foreground">Target: </span>
            <span className="font-medium text-foreground">{String(meta.targetUserId || "Unknown")}</span>
          </>
        );
      default:
        return <span className="text-muted-foreground font-mono text-xs">{JSON.stringify(meta)}</span>;
    }
  };

  return <span className="text-xs leading-relaxed">{getDetail()}</span>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function AdminLogsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-16 skeleton rounded-xl" />
          ))}
        </div>
      }
    >
      <AdminLogsContent />
    </Suspense>
  );
}

function AdminLogsContent() {
  const searchParams = useSearchParams();
  const [action, setAction] = useState(searchParams.get("action") ?? "");
  const [search, setSearch] = useState(searchParams.get("user") ?? searchParams.get("search") ?? "");
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    const a = searchParams.get("action");
    const u = searchParams.get("user") ?? searchParams.get("search");
    if (a) setAction(a);
    if (u) setSearch(u);
  }, [searchParams]);

  const { data: logs, refetch, isLoading, isFetching } = useQuery({
    queryKey: ["admin-logs", action, search],
    queryFn: async () => {
      const res = await apiFetch<{ logs: Array<LogEntry> }>("/api/admin/monitoring", {
        method: "POST",
        body: JSON.stringify({
          action: action || undefined,
          search: search || undefined,
          limit: 200,
        }),
      });
      return res.data?.logs ?? [];
    },
    refetchInterval: autoRefresh ? 10000 : false,
  });

  // Stats
  const stats = useMemo(() => {
    if (!logs) return { total: 0, actions: {} as Record<string, number>, uniqueUsers: 0, uniqueIPs: 0 };
    const actions: Record<string, number> = {};
    const users = new Set<string>();
    const ips = new Set<string>();
    for (const log of logs) {
      actions[log.action] = (actions[log.action] || 0) + 1;
      users.add(log.userId);
      if (log.ip) ips.add(log.ip);
    }
    return { total: logs.length, actions, uniqueUsers: users.size, uniqueIPs: ips.size };
  }, [logs]);

  function exportToCSV() {
    if (!logs || logs.length === 0) return;
    setExporting(true);

    const headers = ["Timestamp", "Action", "User", "Email", "Role", "IP", "Resource", "Details"];
    const rows = logs.map((log) => [
      new Date(log.createdAt).toISOString(),
      log.action,
      log.username,
      log.email ?? "",
      log.userRole,
      log.ip ?? "",
      log.resourceType ? `${log.resourceType}/${log.resourceId}` : "",
      JSON.stringify(log.metadata ?? {}),
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `activity-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);

    setTimeout(() => setExporting(false), 1000);
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Activity Logs"
        subtitle="Audit trail of every action across the platform"
        live={autoRefresh}
        actions={
          <>
            <Button
              variant={autoRefresh ? "default" : "secondary"}
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className="gap-1.5"
            >
              <Clock className={cn("h-3.5 w-3.5", autoRefresh && "animate-spin")} />
              Auto
            </Button>
            <Button variant="secondary" size="sm" onClick={exportToCSV} className="gap-1.5" disabled={isLoading || !logs?.length}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Export
            </Button>
            <Button variant="secondary" size="sm" onClick={() => refetch()} className="gap-1.5" disabled={isLoading}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </>
        }
      />

      {/* Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Logs", value: stats.total, icon: Activity, tone: "text-accent", tile: "bg-accent/10" },
          { label: "Unique Users", value: stats.uniqueUsers, icon: Users, tone: "text-blue-500", tile: "bg-blue-500/10" },
          { label: "Unique IPs", value: stats.uniqueIPs, icon: Globe, tone: "text-violet-500", tile: "bg-violet-500/10" },
          { label: "Action Types", value: Object.keys(stats.actions).length, icon: Layers, tone: "text-emerald-500", tile: "bg-emerald-500/10" },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-surface/50 px-4 py-3"
            >
              <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", s.tile, s.tone)}>
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-2xl font-bold tracking-tight text-foreground">{s.value}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Action Filter Chips */}
      <div className="flex flex-wrap gap-1.5">
        {filterActions.map((f) => {
          const Icon = f.icon;
          const isActive = action === f.value;
          const count = f.value ? stats.actions[f.value] : stats.total;
          return (
            <button
              key={f.value}
              onClick={() => setAction(isActive ? "" : f.value)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                isActive
                  ? "bg-accent text-accent-foreground shadow-sm"
                  : "bg-surface border border-border/50 text-muted-foreground hover:bg-accent/10 hover:text-foreground"
              )}
            >
              <Icon className="h-3 w-3" />
              {f.label}
              {count != null && count > 0 && (
                <span className={cn("ml-0.5 text-[10px]", isActive ? "text-accent-foreground/70" : "text-muted-foreground/50")}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            placeholder="Search user, IP, action, file..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-10"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Logs List */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="h-16 skeleton rounded-xl" />
          ))}
        </div>
      ) : (logs ?? []).length === 0 ? (
        <div className="flex flex-col items-center py-16 text-muted-foreground">
          <ScrollText className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium">No logs found</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Try adjusting your filters</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/50 bg-surface overflow-hidden">
          {/* Desktop Header */}
          <div className="hidden lg:grid grid-cols-[140px_1fr_160px_140px_160px_40px] border-b border-border/40 bg-muted/30 px-4 py-3 text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
            <span>Action</span>
            <span>User</span>
            <span>IP Address</span>
            <span>Details</span>
            <span>Time</span>
            <span></span>
          </div>

          <div className="divide-y divide-border/30">
            {(logs ?? []).map((log, idx) => {
              const config = actionConfig[log.action] ?? { icon: Activity, color: "text-gray-400", bg: "bg-gray-400/10", label: log.action, description: log.action };
              const Icon = config.icon;
              const isExpanded = expandedId === log.id;

              return (
                <div key={log.id}>
                  <motion.div
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.5) }}
                    className={cn(
                      "group cursor-pointer transition-colors",
                      "hover:bg-accent/5",
                      isExpanded && "bg-accent/5"
                    )}
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  >
                    {/* Mobile Layout */}
                    <div className="lg:hidden px-4 py-3.5">
                      <div className="flex items-start gap-3">
                        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", config.bg)}>
                          <Icon className={cn("h-4 w-4", config.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={cn("text-sm font-semibold", config.color)}>{config.label}</span>
                            <span className="text-xs text-muted-foreground">·</span>
                            <span className="text-xs font-medium text-foreground">{log.username}</span>
                            {log.userRole === "master" && (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">ADMIN</span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {log.ip && (
                              <span className="inline-flex items-center gap-1">
                                <Globe className="h-3 w-3" />
                                <span className="font-mono">{log.ip}</span>
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatRelativeTime(log.createdAt)}
                            </span>
                          </div>
                          <div className="mt-1.5">
<div className="break-words"><DescribeMetadata log={log} /></div>
                          </div>
                        </div>
                        <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 shrink-0 transition-transform", isExpanded && "rotate-180")} />
                      </div>
                    </div>

                    {/* Desktop Layout */}
                    <div className="hidden lg:grid grid-cols-[140px_1fr_160px_140px_160px_40px] items-center gap-3 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", config.bg)}>
                          <Icon className={cn("h-4 w-4", config.color)} />
                        </div>
                        <div>
                          <span className={cn("text-sm font-semibold", config.color)}>{config.label}</span>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/admin/users/${log.userId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-sm font-medium text-foreground truncate hover:underline"
                          >
                            {log.username}
                          </Link>
                          {log.userRole === "master" && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">ADMIN</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{log.email}</p>
                      </div>
                      <div>
                        {log.ip ? (
                          <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface border border-border/50 px-2.5 py-1 text-xs font-mono text-muted-foreground">
                            <Globe className="h-3 w-3 text-violet-400" />
                            {log.ip}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <DescribeMetadata log={log} />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-1.5 rounded-full bg-accent/40 animate-pulse shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground">{formatRelativeTime(log.createdAt)}</p>
                          <p className="text-[10px] text-muted-foreground/50">{formatAbsoluteTime(log.createdAt)}</p>
                        </div>
                      </div>
                      <div className="flex justify-center">
                        <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 transition-transform", isExpanded && "rotate-180")} />
                      </div>
                    </div>
                  </motion.div>

                  {/* Expanded Detail */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-border/30 bg-muted/20 px-4 py-4 lg:pl-[180px]">
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
                            <div>
                              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">Action</span>
                              <p className="mt-1 font-medium text-foreground">{config.label} — {config.description}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">User</span>
                              <p className="mt-1 font-medium text-foreground">
                                <Link href={`/admin/users/${log.userId}`} className="hover:underline">
                                  {log.username}
                                </Link>{" "}
                                ({log.email})
                              </p>
                              <p className="text-muted-foreground">
                                ID:{" "}
                                <Link href={`/admin/users/${log.userId}`} className="font-mono hover:underline">
                                  {log.userId.slice(0, 8)}...
                                </Link>
                                {" · "}
                                <Link
                                  href={`/admin/logs?user=${encodeURIComponent(log.username)}`}
                                  className="text-primary hover:underline"
                                >
                                  Filter logs
                                </Link>
                              </p>
                            </div>
                            <div>
                              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">Network</span>
                              <p className="mt-1 font-mono text-muted-foreground">{log.ip ?? "No IP recorded"}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">Timestamp</span>
                              <p className="mt-1 text-muted-foreground">{formatAbsoluteTime(log.createdAt)}</p>
                              <p className="text-muted-foreground/60">{formatRelativeTime(log.createdAt)}</p>
                            </div>
                          </div>
                          {log.metadata && Object.keys(log.metadata).length > 0 && (
                            <div className="mt-3 pt-3 border-t border-border/30">
                              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold text-xs">Metadata</span>
                              <pre className="mt-1.5 rounded-lg bg-background/50 border border-border/30 p-3 text-xs font-mono text-muted-foreground overflow-x-auto">
                                {JSON.stringify(log.metadata, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}