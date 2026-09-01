"use client";

import { Suspense, useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/shared/api/client";
import { useDebouncedValue } from "@/ui/hooks/use-debounced-value";
import { useAdminEvents } from "@admin/presentation/hooks/use-admin-events";
import { Button } from "@/ui/primitives/button";
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
} from "@admin/presentation/components/admin-ui";
import {
  AUDIT_GROUPS,
  auditAction,
  auditActionLabel,
  actionsInGroup,
  type AuditActionMeta,
} from "@admin/domain/services/audit-actions";
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
  AlertTriangle,
} from "lucide-react";
import { relativeTime, useFormat, useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";

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

type TimeWindow = "hour" | "day" | "week" | "all";

const ADMIN_LOGS_QUERY_KEY = ["admin-logs"] as const;
const LOG_EVENT_TYPES = ["activity_log_created"] as const;

function windowStart(window: TimeWindow): string | undefined {
  const duration = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    all: 0,
  }[window];
  return duration === 0 ? undefined : new Date(Date.now() - duration).toISOString();
}

/** Ticking clock so relative timestamps stay honest without an impure render. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
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
  const t = useT();
  const { formatBytes } = useFormat();
  const meta = log.metadata;
  if (!meta || Object.keys(meta).length === 0) {
    return <span className="adm-sub">—</span>;
  }

  const unknown = t("admin.logs.unknown");

  const detail = (() => {
    switch (log.action) {
      case "upload":
        return (
          <>
            <Val>{String(meta.fileName || unknown)}</Val>
            <span className="adm-sub">
              {" · "}
              {String(meta.mimeType || t("admin.logs.unknownType"))}
            </span>
            {meta.size != null && <span className="adm-sub"> · {formatBytes(Number(meta.size))}</span>}
          </>
        );
      case "download":
        return (
          <>
            <Val>{String(meta.fileName || unknown)}</Val>
            {meta.source ? (
              <span className="adm-sub">
                {` · ${t("admin.logs.via")} `}
                <Val tone="info">{String(meta.source)}</Val>
              </span>
            ) : null}
          </>
        );
      case "delete":
        return (
          <>
            <Val>{String(meta.fileName || unknown)}</Val>
            {meta.folder != null && (
              <span className="adm-sub">
                {" "}
                {t("admin.logs.inFolder", { folder: String(meta.folder) })}
              </span>
            )}
          </>
        );
      case "share":
        return (
          <>
            <Val>{String(meta.fileName || unknown)}</Val>
            {meta.permission ? (
              <span className="adm-sub">
                {` ${t("admin.logs.asRole")} `}
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
            <Val>{String(meta.username || unknown)}</Val>
            {meta.role ? (
              <span className="adm-sub">
                {` ${t("admin.logs.asRole")} `}
                <Val tone={meta.role === "master" ? "warning" : "success"}>{String(meta.role)}</Val>
              </span>
            ) : null}
          </>
        );
      case "update_user":
      case "suspend_user":
        return (
          <>
            <Val>{String(meta.username || meta.targetUserId || unknown)}</Val>
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
        return <Val>{String(meta.folderName || unknown)}</Val>;
      case "rename":
        return (
          <span className="adm-sub">
            {String(meta.oldName || unknown)} → <Val>{String(meta.newName || unknown)}</Val>
          </span>
        );
      case "move":
        return (
          <>
            <Val>{String(meta.fileName || unknown)}</Val>
            {meta.destination ? (
              <span className="adm-sub"> → /{String(meta.destination)}</span>
            ) : null}
          </>
        );
      case "impersonate":
        return (
          <span className="adm-sub">
            {`${t("admin.logs.target")} `}
            <Val>{String(meta.targetUserId || unknown)}</Val>
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

type GroupFilter = "all" | AuditActionMeta["group"];

function AdminLogsContent() {
  const searchParams = useSearchParams();
  const now = useNow();
  const t = useT();
  const { formatTimestamp } = useFormat();
  const [action, setAction] = useState(searchParams.get("action") ?? "");
  const [search, setSearch] = useState(
    searchParams.get("user") ?? searchParams.get("search") ?? ""
  );
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [group, setGroup] = useState<GroupFilter>(() => {
    const seeded = searchParams.get("action");
    return seeded ? auditAction(seeded).group : "all";
  });
  const [exporting, setExporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("day");
  const liveStatus = useAdminEvents(ADMIN_LOGS_QUERY_KEY, autoRefresh, LOG_EVENT_TYPES);

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

  const { data, refetch, isLoading, isFetching, isError, dataUpdatedAt } = useQuery({
    queryKey: [...ADMIN_LOGS_QUERY_KEY, action, debouncedSearch, timeWindow],
    queryFn: async () => {
      const res = await apiFetch<{ logs: Array<LogEntry>; serverTime: number }>(
        "/api/admin/monitoring",
        {
          method: "POST",
          body: JSON.stringify({
            action: action || undefined,
            search: debouncedSearch || undefined,
            since: windowStart(timeWindow),
            limit: 200,
          }),
        }
      );
      if (!res.success || !res.data) {
        throw new Error(res.error ?? "Failed to load activity logs");
      }
      return res.data;
    },
    // SSE is the fast path. Polling remains a safety net while it reconnects or
    // when a proxy/browser blocks the event stream.
    refetchInterval: autoRefresh ? (liveStatus === "live" ? 60_000 : 10_000) : false,
    refetchOnWindowFocus: autoRefresh,
  });

  const rows = useMemo(() => data?.logs ?? [], [data?.logs]);

  // Built in the component, not at module scope: the group labels are keys now, and
  // a module-level array would have frozen whichever language loaded first.
  const groupOptions = useMemo(
    () => [
      { value: "all" as const, label: t("admin.logs.areaAll") },
      ...AUDIT_GROUPS.map((entry) => ({
        value: entry.id,
        label: t(entry.labelKey),
        icon: entry.icon,
      })),
    ],
    [t]
  );

  const timeOptions = useMemo(
    () => [
      { value: "hour" as const, label: t("admin.logs.timeHour") },
      { value: "day" as const, label: t("admin.logs.timeDay") },
      { value: "week" as const, label: t("admin.logs.timeWeek") },
      { value: "all" as const, label: t("admin.logs.timeAll") },
    ],
    [t]
  );

  const liveLabel = !autoRefresh
    ? t("admin.logs.paused")
    : liveStatus === "live"
      ? t("admin.logs.live")
      : liveStatus === "connecting"
        ? t("admin.logs.connecting")
        : liveStatus === "reconnecting"
          ? t("admin.logs.reconnecting")
          : t("admin.logs.offlineFallback");
  const liveTone: Tone =
    liveStatus === "live" ? "success" : liveStatus === "offline" ? "danger" : "warning";

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
      const headers = [
        t("admin.logs.csvTimestamp"),
        t("admin.logs.csvAction"),
        t("admin.logs.csvUser"),
        t("admin.logs.csvEmail"),
        t("admin.logs.csvRole"),
        // The protocol name reads the same in all three languages.
        "IP",
        t("admin.logs.csvResource"),
        t("admin.logs.csvDetails"),
      ];
      const body = filtered.map((log) =>
        [
          formatTimestamp(log.createdAt),
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
        kicker={t("admin.logs.kicker")}
        title={t("admin.logs.title")}
        lede={t("admin.logs.lede")}
        live={autoRefresh}
        liveLabel={liveLabel}
        liveTone={liveTone}
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
              {autoRefresh ? t("admin.logs.pause") : t("admin.logs.auto")}
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
              {t("admin.logs.export")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} aria-hidden="true" />
              {t("common.refresh")}
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Activity}
          label={t("admin.logs.metricEvents")}
          value={stats.total}
          tone="accent"
          hint={
            group === "all"
              ? t("admin.logs.metricEventsHintAll")
              : t("admin.logs.metricEventsHintArea")
          }
        />
        <AdminMetric
          icon={Users}
          label={t("admin.logs.metricActors")}
          value={stats.uniqueUsers}
          tone="info"
          hint={t("admin.logs.metricActorsHint")}
        />
        <AdminMetric
          icon={Globe}
          label={t("admin.logs.metricAddresses")}
          value={stats.uniqueIPs}
          tone="success"
          hint={t("admin.logs.metricAddressesHint")}
        />
        <AdminMetric
          icon={Layers}
          label={t("admin.logs.metricKinds")}
          value={stats.actions}
          tone="muted"
          hint={t("admin.logs.metricKindsHint")}
        />
      </div>

      <div className="adm-toolbar">
        <SearchField
          icon={Search}
          value={search}
          onChange={setSearch}
          label={t("admin.logs.searchLabel")}
          placeholder={t("admin.logs.searchPlaceholder")}
        />
        <Segment
          value={group}
          onChange={setGroup}
          options={groupOptions}
          label={t("admin.logs.areaLabel")}
        />
        <Segment
          value={timeWindow}
          onChange={setTimeWindow}
          options={timeOptions}
          label={t("admin.logs.timeLabel")}
        />
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
              title={t("admin.logs.clearActionFilter")}
            >
              {auditActionLabel(action, t)}
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
                title={t(meta.descriptionKey)}
              >
                {t(meta.labelKey)}
              </FilterChip>
            );
          })}
        </div>
      )}
      <AdminPanel
        icon={ScrollText}
        title={t("admin.logs.panelTitle", { count: filtered.length })}
        sub={
          action
            ? t("admin.logs.filteredTo", { action: auditActionLabel(action, t) })
            : group === "all"
              ? t("admin.logs.allAreas")
              : t(
                  AUDIT_GROUPS.find((entry) => entry.id === group)?.labelKey ??
                    "admin.logs.allAreas"
                )
        }
        tools={
          dataUpdatedAt > 0 ? (
            <span className="adm-sub adm-num" aria-live="polite">
              {t("admin.logs.lastUpdated", {
                time: relativeTime(new Date(dataUpdatedAt).toISOString(), now, t),
              })}
            </span>
          ) : undefined
        }
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-14 w-full" rows={7} />
          </div>
        ) : isError ? (
          <AdminEmpty
            icon={AlertTriangle}
            title={t("admin.logs.loadFailed")}
            body={t("admin.logs.loadFailedBody")}
            action={
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t("common.retry")}
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={ScrollText}
            title={
              rows.length === 0
                ? t("admin.logs.emptyTitle")
                : t("admin.logs.noneInAreaTitle")
            }
            body={
              rows.length === 0
                ? t("admin.logs.emptyBody")
                : t("admin.logs.noneInAreaBody")
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
                  {t("admin.ui.clearFilters")}
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
            {auditActionLabel(log.action, t)}
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
              title={formatTimestamp(log.createdAt)}
            >
              {relativeTime(log.createdAt, now, t)}
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
                      {t("admin.logs.when")}
                    </dt>
                    <dd className="adm-num">{formatTimestamp(log.createdAt)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="adm-sub w-20 shrink-0">{t("admin.logs.account")}</dt>
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
                    <dt className="adm-sub w-20 shrink-0">{t("admin.logs.resource")}</dt>
                    <dd className="adm-num break-all">
                      {log.resourceType
                        ? `${log.resourceType}${log.resourceId ? `:${log.resourceId}` : ""}`
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="adm-sub w-20 shrink-0">{t("admin.logs.meaning")}</dt>
                    <dd className="adm-sub">{t(meta.descriptionKey)}</dd>
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
