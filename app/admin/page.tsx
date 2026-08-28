"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Cpu,
  Database,
  Download,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  Server,
  Share2,
  Shield,
  TrendingUp,
  Upload,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  AdminEmpty,
  AdminHeader,
  AdminMetric,
  AdminPanel,
  Chip,
  Meter,
  Skeleton,
  StatusDot,
  type Tone,
} from "@/components/admin/admin-ui";
import { auditAction } from "@/lib/admin/audit-actions";
import { apiFetch } from "@/lib/api/client";
import { formatBytes, formatDate } from "@/lib/utils";

interface AdminStats {
  users: { total: number; active: number; suspended: number };
  files: { total: number; notes: number };
  storage: { used: number; quota: number };
  folders: number;
  shares: number;
  activity: {
    logins: number;
    uploads: number;
    downloads: number;
    byType: Array<{ action: string; count: number }>;
  };
  sessions: number;
  topUsers: Array<{
    id: string;
    username: string;
    usedBytes: number;
    quotaBytes: number;
    fileCount: number;
  }>;
  recentActivity: Array<{
    id: string;
    action: string;
    createdAt: string;
    metadata: unknown;
  }>;
  storageGrowth?: Array<{ day: string; uploads: number; bytes: number }>;
  byMime?: Array<{ mimeType: string; category: string; count: number; bytes: number }>;
  byCategory?: Array<{ category: string; count: number; bytes: number }>;
  system?: {
    database: string;
    redis: "connected" | "disabled" | "down";
    uptimeSeconds: number;
    nodeVersion: string;
    memoryUsedMB: number;
    memoryHeapMB: number;
    env: string;
  };
}

// Categorical palette — validated colorblind-safe (ΔE) in both light & dark,
// contrast ≥ 3:1 vs surface. Paired with a legend + direct labels (identity is
// never color-alone). Do not reorder: colors follow entity slots, not rank.
const MIME_COLORS = ["#059669", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

/** Storage capacity reads danger past 90% and warning past 75% of the pool. */
function capacityTone(ratio: number): Tone {
  if (ratio >= 0.9) return "danger";
  if (ratio >= 0.75) return "warning";
  return "success";
}

export default function AdminOverviewPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await apiFetch<AdminStats>("/api/admin/stats");
      return res.data;
    },
    refetchInterval: 15000, // Live — auto-refresh every 15 seconds
  });

  if (isLoading && !stats) return <OverviewSkeleton />;

  const used = stats?.storage.used ?? 0;
  const quota = stats?.storage.quota ?? 0;
  const ratio = quota > 0 ? Math.min(used / quota, 1) : 0;
  const storagePct = ratio * 100;
  const free = Math.max(quota - used, 0);
  const growth = stats?.storageGrowth ?? [];
  const categories = stats?.byCategory ?? [];
  const topUsers = stats?.topUsers ?? [];
  const recent = stats?.recentActivity ?? [];
  const byType = stats?.activity.byType ?? [];

  return (
    <div className="space-y-5">
      <AdminHeader
        icon={Gauge}
        kicker="Overview"
        title="System overview"
        lede="What the platform is doing right now — accounts, storage, traffic, and the services behind them. Every figure refreshes on its own every 15 seconds."
        live
        liveLabel="Live · 15s"
      />

      {stats?.system && <SystemHealth system={stats.system} />}

      {/* Two rows of four: what exists, then what happened. Keeping them the same
          shape means the eye can compare down a column instead of re-learning a
          new card for every number. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Users}
          label="Users"
          value={stats?.users.total ?? 0}
          tone="accent"
          hint={`${stats?.users.active ?? 0} active · ${stats?.users.suspended ?? 0} suspended`}
        />
        <AdminMetric
          icon={FileText}
          label="Files"
          value={stats?.files.total ?? 0}
          tone="info"
          hint={`${stats?.files.notes ?? 0} notes · ${stats?.folders ?? 0} folders`}
        />
        <AdminMetric
          icon={HardDrive}
          label="Storage used"
          value={formatBytes(used)}
          tone={capacityTone(ratio)}
          hint={`${storagePct.toFixed(1)}% of ${formatBytes(quota)} allocated`}
        />
        <AdminMetric
          icon={Share2}
          label="Share links"
          value={stats?.shares ?? 0}
          tone="warning"
          hint="Public links in circulation"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Shield}
          label="Logins"
          value={stats?.activity.logins ?? 0}
          tone="success"
          hint="Last 7 days"
        />
        <AdminMetric
          icon={Upload}
          label="Uploads"
          value={stats?.activity.uploads ?? 0}
          tone="info"
          hint="Last 7 days"
        />
        <AdminMetric
          icon={Download}
          label="Downloads"
          value={stats?.activity.downloads ?? 0}
          tone="accent"
          hint="Last 7 days"
        />
        <AdminMetric
          icon={KeyRound}
          label="Sessions"
          value={stats?.sessions ?? 0}
          tone="muted"
          hint="Signed in right now"
        />
      </div>

      <AdminPanel
        icon={HardDrive}
        title="Storage pool"
        sub="Bytes stored against the total quota handed out to accounts"
        tone={capacityTone(ratio)}
        tools={
          <Chip tone={capacityTone(ratio)} mono>
            {storagePct.toFixed(1)}%
          </Chip>
        }
      >
        <Meter value={ratio} tone={ratio >= 0.9 ? "danger" : "accent"} />
        <div className="mt-3 grid grid-cols-3 gap-3">
          <Figure label="Used" value={formatBytes(used)} />
          <Figure label="Free" value={formatBytes(free)} />
          <Figure label="Utilisation" value={`${storagePct.toFixed(1)}%`} />
        </div>
      </AdminPanel>

      <div className="grid gap-4 lg:grid-cols-2">
        <AdminPanel
          icon={TrendingUp}
          title="Upload growth"
          sub="Files added per day over the last 30 days"
        >
          {growth.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growth} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="uploadFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={formatChartDay}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    width={32}
                  />
                  <Tooltip
                    cursor={{ stroke: "var(--accent)", strokeWidth: 1, strokeDasharray: "4 4" }}
                    content={<UploadTooltip />}
                  />
                  <Area
                    type="monotone"
                    dataKey="uploads"
                    stroke="var(--accent)"
                    fill="url(#uploadFill)"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{
                      r: 5,
                      fill: "var(--accent)",
                      stroke: "var(--surface)",
                      strokeWidth: 2,
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <AdminEmpty
              icon={TrendingUp}
              title="No uploads in the last 30 days"
              body="The curve draws itself as soon as files start arriving."
            />
          )}
        </AdminPanel>

        <AdminPanel icon={Database} title="Storage by type" sub="Where the bytes actually sit">
          {categories.length > 0 ? (
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <div className="h-48 w-full sm:w-1/2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categories}
                      dataKey="bytes"
                      nameKey="category"
                      innerRadius={48}
                      outerRadius={72}
                      paddingAngle={2}
                    >
                      {categories.map((c, i) => (
                        <Cell
                          key={c.category}
                          fill={MIME_COLORS[i % MIME_COLORS.length]}
                          stroke="var(--surface)"
                          strokeWidth={2}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<CategoryTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* Direct labels next to the swatches: the slice colour is a
                  shortcut, never the only way to read the chart. */}
              <ul className="w-full flex-1 space-y-1.5">
                {categories.map((c, i) => (
                  <li key={c.category} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: MIME_COLORS[i % MIME_COLORS.length] }}
                      />
                      <span className="truncate text-[0.78rem] capitalize">{c.category}</span>
                      <span className="adm-num text-[var(--adm-muted)]">{c.count}</span>
                    </span>
                    <span className="adm-num shrink-0 text-[var(--adm-muted)]">
                      {formatBytes(c.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <AdminEmpty
              icon={Database}
              title="No files"
              body="Uploads split the pool by file category here."
            />
          )}
        </AdminPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <AdminPanel
          icon={TrendingUp}
          title="Heaviest accounts"
          sub="Ranked by bytes stored, not by file count"
          tools={<PanelLink href="/admin/users">All users</PanelLink>}
        >
          {topUsers.length > 0 ? (
            <ol className="space-y-2.5">
              {topUsers.map((user, idx) => {
                const share = user.quotaBytes > 0 ? Math.min(user.usedBytes / user.quotaBytes, 1) : 0;
                return (
                  <li key={user.id} className="flex items-center gap-3">
                    <span className="adm-num grid h-7 w-7 shrink-0 place-items-center rounded-[0.55rem] bg-[var(--adm-soft)] font-semibold">
                      {idx + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mb-1 flex items-center justify-between gap-2">
                        <Link
                          href={`/admin/users/${user.id}`}
                          className="truncate text-[0.8rem] font-medium hover:text-accent-ink hover:underline"
                        >
                          {user.username}
                        </Link>
                        <span className="adm-num shrink-0 text-[var(--adm-muted)]">
                          {formatBytes(user.usedBytes)}
                          {user.quotaBytes > 0 && ` / ${formatBytes(user.quotaBytes)}`}
                        </span>
                      </span>
                      <Meter value={share} tone={capacityTone(share)} />
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <AdminEmpty
              icon={Users}
              title="No accounts"
              body="Accounts that store data rank here by bytes used."
            />
          )}
        </AdminPanel>

        <AdminPanel
          icon={Activity}
          title="Latest events"
          sub="The eight most recent entries in the audit log"
          tools={<PanelLink href="/admin/logs">Full log</PanelLink>}
          flush
        >
          {recent.length > 0 ? (
            <ul>
              {recent.slice(0, 8).map((log) => {
                const meta = auditAction(log.action);
                return (
                  <li key={log.id}>
                    {/* Each event is a way into the filtered log, so a suspicious
                        line is one click from its full history. */}
                    <Link
                      href={`/admin/logs?action=${encodeURIComponent(log.action)}`}
                      className="adm-row adm-row--flat flex items-center gap-2.5 px-3 py-2"
                      data-tone={meta.tone}
                    >
                      <span className="adm-tile__icon">
                        <meta.icon aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.78rem] font-medium">
                          {meta.label}
                        </span>
                        <span className="adm-sub block truncate">{meta.description}</span>
                      </span>
                      <span className="adm-num shrink-0 text-[var(--adm-muted)]">
                        {formatDate(log.createdAt, "short")}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-4">
              <AdminEmpty
                icon={Activity}
                title="No logs"
                body="Sign-ins, uploads and administrative changes land here."
              />
            </div>
          )}
        </AdminPanel>
      </div>

      {byType.length > 0 && (
        <AdminPanel
          icon={BarChart3}
          title="Activity breakdown"
          sub="Every logged action type over the last 7 days"
        >
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
            {byType.map((item) => {
              const meta = auditAction(item.action);
              return (
                <Link
                  key={item.action}
                  href={`/admin/logs?action=${encodeURIComponent(item.action)}`}
                  className="adm-tile"
                  data-tone={meta.tone}
                  title={meta.description}
                >
                  <span className="adm-tile__icon">
                    <meta.icon aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="adm-tile__value adm-num">{item.count}</span>
                    <span className="adm-tile__label block truncate">{meta.label}</span>
                  </span>
                  <ArrowUpRight
                    className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--adm-muted)]"
                    aria-hidden="true"
                  />
                </Link>
              );
            })}
          </div>
        </AdminPanel>
      )}
    </div>
  );
}

/* ── Small pieces ───────────────────────────────────────────────────────────── */

/** One number in a three-up summary strip. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[0.7rem] bg-[var(--adm-inset)] px-2.5 py-2">
      <p className="adm-num text-[0.9rem] font-semibold">{value}</p>
      <p className="adm-tile__label">{label}</p>
    </div>
  );
}

/** "See everything" link in a panel header. */
function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-[0.72rem] font-medium text-accent-ink hover:underline"
    >
      {children}
      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
    </Link>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {["a", "b", "c", "d"].map((k) => (
          <Skeleton key={k} className="h-20 w-full" />
        ))}
      </div>
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

/* ── System health ──────────────────────────────────────────────────────────── */

/**
 * Four services, one verdict. The previous version painted each tile with its own
 * hue; here colour only ever means state — green up, red down, grey deliberately
 * off — so "something is wrong" is visible without reading a word.
 */
function SystemHealth({ system }: { system: NonNullable<AdminStats["system"]> }) {
  const services: { label: string; icon: LucideIcon; tone: Tone; value: string; note?: string }[] = [
    {
      label: "Database",
      icon: Database,
      tone: system.database === "connected" ? "success" : "danger",
      value: system.database === "connected" ? "Connected" : "Down",
    },
    {
      label: "Cache",
      icon: Zap,
      tone:
        system.redis === "connected" ? "success" : system.redis === "disabled" ? "muted" : "danger",
      value:
        system.redis === "connected" ? "Connected" : system.redis === "disabled" ? "Disabled" : "Down",
      note: system.redis === "disabled" ? "Jobs run in-process" : undefined,
    },
    {
      label: "Web server",
      icon: Server,
      tone: "success",
      value: `Up ${formatUptime(system.uptimeSeconds)}`,
      note: `Node ${system.nodeVersion}`,
    },
    {
      label: "Memory",
      icon: Cpu,
      tone: "info",
      value: `${system.memoryUsedMB} MB`,
      note: `Heap ${system.memoryHeapMB} MB`,
    },
  ];

  const down = services.filter((s) => s.tone === "danger");
  const healthy = down.length === 0;

  return (
    <AdminPanel
      icon={Server}
      title="System health"
      sub={`Environment: ${system.env}`}
      tone={healthy ? "success" : "danger"}
      variant={healthy ? undefined : "danger"}
      tools={
        <Chip tone={healthy ? "success" : "danger"}>
          <StatusDot tone={healthy ? "success" : "danger"} ring={healthy} />
          {healthy ? "All systems operational" : `${down.length} service down`}
        </Chip>
      }
    >
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {services.map((s) => (
          <div key={s.label} className="adm-tile" data-tone={s.tone}>
            <span className="adm-tile__icon">
              <s.icon aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="adm-tile__label block">{s.label}</span>
              <span className="adm-tile__value truncate">{s.value}</span>
              {s.note && <span className="adm-sub block truncate">{s.note}</span>}
            </span>
          </div>
        ))}
      </div>
    </AdminPanel>
  );
}

/* ── Chart helpers ──────────────────────────────────────────────────────────── */

/** "2026-07-13" → "Jul 13" for compact, readable axis ticks. */
function formatChartDay(value: unknown): string {
  const s = String(value);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(5);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Theme-aware tooltip — reads surface/border/ink tokens so it's legible in
 *  both light and dark mode (the old Recharts default rendered white-on-white). */
function UploadTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value ?? 0;
  return (
    <div className="adm-tooltip">
      <p className="adm-sub">{formatChartDay(label)}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[0.8rem] font-semibold">
        <span
          className="inline-block h-2 w-4 rounded-full"
          style={{ background: "var(--accent)" }}
        />
        <span className="adm-num">{value}</span> upload{value === 1 ? "" : "s"}
      </p>
    </div>
  );
}
/** Theme-aware tooltip for the storage-by-type pie. */
function CategoryTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: { fill?: string } }>;
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  return (
    <div className="adm-tooltip">
      <p className="flex items-center gap-1.5 text-[0.8rem] font-semibold capitalize">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: item.payload?.fill }}
        />
        {item.name}
      </p>
      <p className="adm-num mt-0.5 text-[var(--adm-muted)]">
        {formatBytes(Number(item.value ?? 0))}
      </p>
    </div>
  );
}
