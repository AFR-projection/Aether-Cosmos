"use client";

import { Suspense, useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  AdminEmpty,
  AdminHeader,
  AdminMetric,
  AdminPanel,
  Chip,
  FilterChip,
  SearchField,
  Segment,
  Skeleton,
  type Tone,
} from "@/components/admin/admin-ui";
import {
  AUDIT_GROUPS,
  auditAction,
  actionsInGroup,
  type AuditActionMeta,
} from "@/lib/admin/audit-actions";
import {
  ScrollText,
  Search,
  RefreshCw,
  Activity,
  Loader2,
  FileDown,
  ChevronDown,
  Clock,
  Globe,
  Users,
  Layers,
  Play,
  Pause,
  X,
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

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

/** Ticking clock so relative timestamps stay honest without an impure render. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatRelativeTime(dateStr: string, now: number): string {
  const diffSec = Math.floor((now - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return `${Math.floor(diffDay / 30)}mo ago`;
}

function formatAbsoluteTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("id-ID", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A value inside a log summary that carries a tone (a role, a status, a mode). */
function Val({ tone, children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn("font-medium", !tone && "text-foreground")}
      data-tone={tone}
      style={tone ? { color: "var(--tone)" } : undefined}
    >
      {children}
    </span>
  );
}

/**
 * Turns a metadata blob into a sentence an operator can read at a glance. The raw
 * JSON is still one click away in the expanded row, so this is allowed to omit
 * anything that does not help while scanning.
 */
function DescribeMetadata({ log }: { log: LogEntry }) {
  const meta = log.metadata;
  if (!meta || Object.keys(meta).length === 0) {
    return <span className="adm-sub">—</span>;
  }

  const detail = (() => {
    switch (log.action) {
      case "upload":
        return (
          <>
            <Val>{String(meta.fileName || "Unknown")}</Val>
            <span className="adm-sub"> · {String(meta.mimeType || "unknown type")}</span>
            {meta.size != null && <span className="adm-sub"> · {formatBytes(Number(meta.size))}</span>}
          </>
        );
      case "download":
        return (
          <>
            <Val>{String(meta.fileName || "Unknown")}</Val>
            {meta.source ? (
              <span className="adm-sub">
                {" "}
                · via <Val tone="info">{String(meta.source)}</Val>
              </span>
            ) : null}
          </>
        );
      case "delete":
        return (
          <>
            <Val>{String(meta.fileName || "Unknown")}</Val>
            {meta.folder != null && <span className="adm-sub"> in /{String(meta.folder)}</span>}
          </>
        );
      case "share":
        return (
          <>
            <Val>{String(meta.fileName || "Unknown")}</Val>
            {meta.permission ? (
              <span className="adm-sub">
                {" "}
                as{" "}
                <Val tone={meta.permission === "edit" ? "warning" : "info"}>
                  {String(meta.permission)}
                </Val>
              </span>
            ) : null}
            {meta.phone ? <span className="adm-sub"> → {String(meta.phone)}</span> : null}
          </>
        );
      case "login":
        return meta.userAgent ? (
          <span className="adm-sub line-clamp-1">{String(meta.userAgent)}</span>
        ) : null;
      case "create_user":
        return (
          <>
            <Val>{String(meta.username || "Unknown")}</Val>
            {meta.role ? (
              <span className="adm-sub">
                {" "}
                as <Val tone={meta.role === "master" ? "warning" : "success"}>{String(meta.role)}</Val>
              </span>
            ) : null}
          </>
        );
      case "update_user":
      case "suspend_user":
        return (
          <>
            <Val>{String(meta.username || meta.targetUserId || "Unknown")}</Val>
            {meta.status ? (
              <span className="adm-sub">
                {" "}
                → <Val tone={meta.status === "active" ? "success" : "danger"}>{String(meta.status)}</Val>
              </span>
            ) : null}
          </>
        );
      case "create_folder":
      case "delete_folder":
        return <Val>{String(meta.folderName || "Unknown")}</Val>;
      case "rename":
        return (
          <span className="adm-sub">
            {String(meta.oldName || "Unknown")} → <Val>{String(meta.newName || "Unknown")}</Val>
          </span>
        );
      case "move":
        return (
          <>
            <Val>{String(meta.fileName || "Unknown")}</Val>
            {meta.destination ? (
              <span className="adm-sub"> → /{String(meta.destination)}</span>
            ) : null}
          </>
        );
      case "impersonate":
        return (
          <span className="adm-sub">
            Target: <Val>{String(meta.targetUserId || "Unknown")}</Val>
          </span>
        );
      default:
        return <span className="adm-num adm-sub">{JSON.stringify(meta)}</span>;
    }
  })();

  return <span className="text-[0.76rem] leading-relaxed">{detail}</span>;
}

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function AdminLogsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-14 w-full" rows={8} />
        </div>
      }
    >
      <AdminLogsContent />
    </Suspense>
  );
}

const GROUP_OPTIONS = [
  { value: "all" as const, label: "All" },
  ...AUDIT_GROUPS.map((group) => ({ value: group.id, label: group.label, icon: group.icon })),
];

type GroupFilter = "all" | AuditActionMeta["group"];

function AdminLogsContent() {
  const searchParams = useSearchParams();
  const now = useNow();
  const [action, setAction] = useState(searchParams.get("action") ?? "");
  const [search, setSearch] = useState(
    searchParams.get("user") ?? searchParams.get("search") ?? ""
  );
  const [group, setGroup] = useState<GroupFilter>(() => {
    const seeded = searchParams.get("action");
    return seeded ? auditAction(seeded).group : "all";
  });
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Other pages deep-link in here ("view all logins", a user's action count), so a
  // new query string has to win over whatever is currently in the boxes. Adopting
  // it during render rather than in an effect means the table paints once instead
  // of painting the old filter and then correcting itself.
  const paramKey = searchParams.toString();
  const [seededFrom, setSeededFrom] = useState(paramKey);
  if (paramKey !== seededFrom) {
    setSeededFrom(paramKey);
    const a = searchParams.get("action");
    const u = searchParams.get("user") ?? searchParams.get("search");
    // Arriving with ?action= should also open the group that owns it, otherwise the
    // chip that is doing the filtering is hidden behind a segment nobody selected.
    if (a) {
      setAction(a);
      setGroup(auditAction(a).group);
    }
    if (u) setSearch(u);
  }

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

  const rows = useMemo(() => logs ?? [], [logs]);

  /** Chips are gated behind the group segment — 21 of them at once is a wall. */
  const chipActions = useMemo(() => (group === "all" ? [] : actionsInGroup(group)), [group]);

  const filtered = useMemo(() => {
    if (group === "all") return rows;
    const allowed = new Set(actionsInGroup(group));
    return rows.filter((log) => allowed.has(log.action));
  }, [rows, group]);

  const stats = useMemo(() => {
    const actions = new Set<string>();
    const users = new Set<string>();
    const ips = new Set<string>();
    for (const log of filtered) {
      actions.add(log.action);
      users.add(log.userId);
      if (log.ip) ips.add(log.ip);
    }
    return {
      total: filtered.length,
      actions: actions.size,
      uniqueUsers: users.size,
      uniqueIPs: ips.size,
    };
  }, [filtered]);

  function exportToCSV() {
    setExporting(true);
    try {
      const headers = ["Timestamp", "Action", "User", "Email", "Role", "IP", "Resource", "Details"];
      const body = filtered.map((log) =>
        [
          formatAbsoluteTime(log.createdAt),
          log.action,
          log.username,
          log.email ?? "",
          log.userRole,
          log.ip ?? "",
          log.resourceType ? `${log.resourceType}:${log.resourceId ?? ""}` : "",
          log.metadata ? JSON.stringify(log.metadata) : "",
        ]
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(",")
      );
      const blob = new Blob([[headers.join(","), ...body].join("\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `activity-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-5">
      <AdminHeader
        icon={ScrollText}
        kicker="Audit trail"
        title="Activity logs"
        lede="Every privileged action, newest first. Pick an area, then narrow to a single kind of event — the raw payload is one click away on any row."
        live={autoRefresh}
        liveLabel="Polling 10s"
        actions={
          <>
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh((v) => !v)}
              aria-pressed={autoRefresh}
            >
              {autoRefresh ? (
                <Pause className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
              {autoRefresh ? "Pause" : "Auto"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              disabled={exporting || filtered.length === 0}
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileDown className="h-4 w-4" aria-hidden="true" />
              )}
              Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Activity}
          label="Events"
          value={stats.total}
          tone="accent"
          hint={group === "all" ? "Latest 200" : "In this area"}
        />
        <AdminMetric
          icon={Users}
          label="Actors"
          value={stats.uniqueUsers}
          tone="info"
          hint="Distinct accounts"
        />
        <AdminMetric
          icon={Globe}
          label="Addresses"
          value={stats.uniqueIPs}
          tone="success"
          hint="Distinct IPs"
        />
        <AdminMetric
          icon={Layers}
          label="Event kinds"
          value={stats.actions}
          tone="muted"
          hint="Different actions seen"
        />
      </div>

      <div className="adm-toolbar">
        <SearchField
          icon={Search}
          value={search}
          onChange={setSearch}
          label="Search logs"
          placeholder="User, email, or IP…"
        />
        <Segment value={group} onChange={setGroup} options={GROUP_OPTIONS} label="Log area" />
      </div>
      {/* Second tier of the filter: only the actions that live in the chosen area,
          plus an escape hatch for an action that arrived by query string. */}
      {(chipActions.length > 0 || action) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {action && !chipActions.includes(action) && (
            <FilterChip
              icon={X}
              active
              onClick={() => setAction("")}
              title="Clear the action filter"
            >
              {auditAction(action).label}
            </FilterChip>
          )}
          {chipActions.map((key) => {
            const meta = auditAction(key);
            const active = action === key;
            return (
              <FilterChip
                key={key}
                icon={meta.icon}
                tone={meta.tone}
                active={active}
                onClick={() => setAction(active ? "" : key)}
                title={meta.description}
              >
                {meta.label}
              </FilterChip>
            );
          })}
        </div>
      )}
      <AdminPanel
        icon={ScrollText}
        title={`${filtered.length} event${filtered.length !== 1 ? "s" : ""}`}
        sub={
          action
            ? `Filtered to ${auditAction(action).label}`
            : group === "all"
              ? "All areas"
              : AUDIT_GROUPS.find((g) => g.id === group)?.label
        }
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-14 w-full" rows={7} />
          </div>
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={ScrollText}
            title={rows.length === 0 ? "Nothing logged yet" : "Nothing in this area"}
            body={
              rows.length === 0
                ? "Sign-ins, uploads, shares and account changes all land here the moment they happen."
                : "Widen the area segment or clear the action chip to see the rest of the trail."
            }
            action={
              rows.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setGroup("all");
                    setAction("");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="divide-y divide-[var(--adm-hairline)]">
            {filtered.map((log) => renderRow(log))}
          </div>
        )}
      </AdminPanel>
    </div>
  );
  function renderRow(log: LogEntry) {
    const meta = auditAction(log.action);
    const open = expandedId === log.id;
    return (
      <div key={log.id} className="adm-row adm-row--flat" data-open={open || undefined}>
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left"
          onClick={() => setExpandedId(open ? null : log.id)}
          aria-expanded={open}
        >
          <Chip icon={meta.icon} tone={meta.tone} className="mt-px shrink-0">
            {meta.label}
          </Chip>

          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[0.82rem] font-medium">{log.username}</span>
              {log.userRole === "master" && <Chip tone="warning">master</Chip>}
              {log.ip && (
                <span className="adm-sub adm-num inline-flex items-center gap-1">
                  <Globe className="h-3 w-3" aria-hidden="true" />
                  {log.ip}
                </span>
              )}
            </span>
            <span className="mt-0.5 block">
              <DescribeMetadata log={log} />
            </span>
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-2">
            <span
              className="adm-sub adm-num whitespace-nowrap"
              title={formatAbsoluteTime(log.createdAt)}
            >
              {formatRelativeTime(log.createdAt, now)}
            </span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="grid gap-3 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <dl className="space-y-1.5 text-[0.78rem]">
                  <div className="flex gap-2">
                    <dt className="adm-sub inline-flex w-20 shrink-0 items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden="true" />
                      When
                    </dt>
                    <dd className="adm-num">{formatAbsoluteTime(log.createdAt)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="adm-sub w-20 shrink-0">Account</dt>
                    <dd>
                      <Link
                        href={`/admin/users/${log.userId}`}
                        className="font-medium text-accent-ink hover:underline"
                      >
                        {log.username}
                      </Link>
                      {log.email && <span className="adm-sub"> · {log.email}</span>}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="adm-sub w-20 shrink-0">Resource</dt>
                    <dd className="adm-num break-all">
                      {log.resourceType
                        ? `${log.resourceType}${log.resourceId ? `:${log.resourceId}` : ""}`
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="adm-sub w-20 shrink-0">Meaning</dt>
                    <dd className="adm-sub">{meta.description}</dd>
                  </div>
                </dl>
                <pre className="adm-code">{JSON.stringify(log.metadata ?? {}, null, 2)}</pre>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }
}
