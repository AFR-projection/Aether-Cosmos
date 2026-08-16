"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { apiFetch } from "@/lib/api/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { formatBytes, formatDate } from "@/lib/utils";
import {
  Users, FileText, HardDrive, Share2, Activity, Upload,
  Download, Shield, TrendingUp,
  CheckCircle, XCircle, BarChart3, Zap, Database, Server, Cpu,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import Link from "next/link";

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

const actionIcons: Record<string, typeof Upload> = {
  upload: Upload,
  download: Download,
  delete: XCircle,
  login: Shield,
  create: FileText,
  restore: CheckCircle,
  share: Share2,
  impersonate: Users,
};

const actionColors: Record<string, string> = {
  upload: "bg-emerald-500/10 text-emerald-500",
  download: "bg-blue-500/10 text-blue-500",
  delete: "bg-red-500/10 text-red-500",
  login: "bg-violet-500/10 text-violet-500",
  create: "bg-cyan-500/10 text-cyan-500",
  restore: "bg-amber-500/10 text-amber-500",
  share: "bg-pink-500/10 text-pink-500",
  impersonate: "bg-orange-500/10 text-orange-500",
};

// Categorical palette — validated colorblind-safe (ΔE) in both light & dark,
// contrast ≥ 3:1 vs surface. Paired with a legend + direct labels (identity is
// never color-alone). Do not reorder: colors follow entity slots, not rank.
const MIME_COLORS = ["#059669", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#0891b2"];

export default function AdminOverviewPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: async () => {
      const res = await apiFetch<AdminStats>("/api/admin/stats");
      return res.data;
    },
    refetchInterval: 15000, // Live — auto-refresh every 15 seconds
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-28 skeleton rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const storagePct = stats?.storage.quota
    ? Math.min((stats.storage.used / stats.storage.quota) * 100, 100)
    : 0;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="System Overview"
        subtitle="Real-time platform statistics and health monitoring"
        live
        liveLabel="Live • auto-refreshes every 15s"
      />

      {/* System Health */}
      {stats?.system && <SystemHealth system={stats.system} />}

      {/* Primary Stats */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          label="Total Users"
          value={stats?.users.total ?? 0}
          icon={Users}
          gradient="from-violet-500 to-fuchsia-500"
          iconBg="bg-violet-500/10 text-violet-500"
          subtitle={`${stats?.users.active ?? 0} active, ${stats?.users.suspended ?? 0} suspended`}
          delay={0}
        />
        <AdminStatCard
          label="Total Files"
          value={stats?.files.total ?? 0}
          icon={FileText}
          gradient="from-blue-500 to-cyan-500"
          iconBg="bg-blue-500/10 text-blue-500"
          subtitle={`${stats?.files.notes ?? 0} notes, ${stats?.folders ?? 0} folders`}
          delay={0.06}
        />
        <AdminStatCard
          label="Storage Used"
          value={formatBytes(stats?.storage.used ?? 0)}
          icon={HardDrive}
          gradient="from-emerald-500 to-teal-500"
          iconBg="bg-emerald-500/10 text-emerald-500"
          subtitle={`${storagePct.toFixed(1)}% of ${formatBytes(stats?.storage.quota ?? 0)}`}
          delay={0.12}
        />
        <AdminStatCard
          label="Shared Links"
          value={stats?.shares ?? 0}
          icon={Share2}
          gradient="from-amber-500 to-orange-500"
          iconBg="bg-amber-500/10 text-amber-500"
          subtitle={`${stats?.sessions ?? 0} active sessions`}
          delay={0.18}
        />
      </div>

      {/* Activity Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <ActivityCard
          label="Logins (7d)"
          value={stats?.activity.logins ?? 0}
          icon={Shield}
          color="bg-violet-500/10 text-violet-500"
          delay={0.24}
        />
        <ActivityCard
          label="Uploads (7d)"
          value={stats?.activity.uploads ?? 0}
          icon={Upload}
          color="bg-emerald-500/10 text-emerald-500"
          delay={0.3}
        />
        <ActivityCard
          label="Downloads (7d)"
          value={stats?.activity.downloads ?? 0}
          icon={Download}
          color="bg-blue-500/10 text-blue-500"
          delay={0.36}
        />
      </div>

      {/* Storage Overview */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
      >
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              Storage Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex justify-between text-sm">
              <span className="font-semibold">{formatBytes(stats?.storage.used ?? 0)}</span>
              <span className="text-muted-foreground">of {formatBytes(stats?.storage.quota ?? 0)}</span>
            </div>
            <div className="h-4 overflow-hidden rounded-full bg-muted/50">
              <motion.div
                className="h-full rounded-full bg-accent-gradient"
                initial={{ width: 0 }}
                animate={{ width: `${storagePct}%` }}
                transition={{ duration: 1.2, ease: "easeOut" }}
              />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold">{formatBytes(stats?.storage.used ?? 0)}</p>
                <p className="text-xs text-muted-foreground">Used</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{formatBytes((stats?.storage.quota ?? 0) - (stats?.storage.used ?? 0))}</p>
                <p className="text-xs text-muted-foreground">Free</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{storagePct.toFixed(1)}%</p>
                <p className="text-xs text-muted-foreground">Utilization</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Growth 30d + MIME breakdown */}
      <div className="grid gap-6 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.42 }}
        >
          <Card className="border-border/50 h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                Upload growth (30 days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(stats?.storageGrowth?.length ?? 0) > 0 ? (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={stats!.storageGrowth} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                      <defs>
                        <linearGradient id="uploadFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--border)"
                        vertical={false}
                      />
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
                <p className="py-12 text-center text-sm text-muted-foreground">No upload activity yet</p>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.44 }}
        >
          <Card className="border-border/50 h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4 text-muted-foreground" />
                Storage by type
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(stats?.byCategory?.length ?? 0) > 0 ? (
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <div className="h-48 w-full sm:w-1/2">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={stats!.byCategory}
                          dataKey="bytes"
                          nameKey="category"
                          innerRadius={48}
                          outerRadius={72}
                          paddingAngle={2}
                        >
                          {stats!.byCategory!.map((_, i) => (
                            <Cell
                              key={i}
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
                  <div className="flex-1 space-y-2 w-full">
                    {stats!.byCategory!.map((c, i) => (
                      <div key={c.category} className="flex items-center justify-between text-sm gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ background: MIME_COLORS[i % MIME_COLORS.length] }}
                          />
                          <span className="truncate">{c.category}</span>
                          <span className="text-xs text-muted-foreground">({c.count})</span>
                        </div>
                        <span className="text-muted-foreground shrink-0">{formatBytes(c.bytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">No files yet</p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Top Users & Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top Users */}
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.45 }}
        >
          <Card className="h-full border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                Top Users by Storage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {(stats?.topUsers ?? []).map((user, idx) => {
                  const pct = user.quotaBytes > 0 ? (user.usedBytes / user.quotaBytes) * 100 : 0;
                  return (
                    <motion.div
                      key={user.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.5 + idx * 0.05 }}
                      className="flex items-center gap-3"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-bold text-accent">
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <Link
                            href={`/admin/users/${user.id}`}
                            className="text-sm font-medium truncate hover:underline"
                          >
                            {user.username}
                          </Link>
                          <span className="text-xs text-muted-foreground">{formatBytes(user.usedBytes)}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted/50">
                          <div
                            className="h-full rounded-full bg-accent-gradient"
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
                {(stats?.topUsers ?? []).length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">No users yet</p>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Recent Activity */}
        <motion.div
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.5 }}
        >
          <Card className="h-full border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {(stats?.recentActivity ?? []).slice(0, 8).map((log, idx) => {
                  const Icon = actionIcons[log.action] ?? Activity;
                  const colorClass = actionColors[log.action] ?? "bg-gray-500/10 text-gray-500";
                  return (
                    <motion.div
                      key={log.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.55 + idx * 0.03 }}
                      className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-accent/5 transition-colors"
                    >
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${colorClass}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium capitalize">{log.action.replace(/_/g, " ")}</span>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        {formatDate(log.createdAt, "short")}
                      </span>
                    </motion.div>
                  );
                })}
                {(stats?.recentActivity ?? []).length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No recent activity</p>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Activity Breakdown */}
      {stats?.activity.byType && stats.activity.byType.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
        >
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Activity Breakdown (7 days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {stats.activity.byType.map((item, idx) => {
                  const Icon = actionIcons[item.action] ?? Activity;
                  const colorClass = actionColors[item.action] ?? "bg-gray-500/10 text-gray-500";
                  return (
                    <motion.div
                      key={item.action}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.65 + idx * 0.05 }}
                      className="flex items-center gap-3 rounded-xl border border-border/40 p-3"
                    >
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${colorClass}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-lg font-bold">{item.count}</p>
                        <p className="text-xs text-muted-foreground capitalize">{item.action.replace(/_/g, " ")}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

/** "2026-07-13" → "Jul 13" for compact, readable axis ticks. */
function formatChartDay(value: unknown): string {
  const s = String(value);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(5);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
    <div
      className="rounded-xl border px-3 py-2 shadow-lg"
      style={{
        background: "var(--surface-elevated)",
        borderColor: "var(--border)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      }}
    >
      <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {formatChartDay(label)}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold" style={{ color: "var(--foreground)" }}>
        <span className="inline-block h-2 w-4 rounded-full" style={{ background: "var(--accent)" }} />
        {value} upload{value === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
    <div
      className="rounded-xl border px-3 py-2 shadow-lg"
      style={{
        background: "var(--surface-elevated)",
        borderColor: "var(--border)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      }}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold capitalize" style={{ color: "var(--foreground)" }}>
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: item.payload?.fill }} />
        {item.name}
      </p>
      <p className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
        {formatBytes(Number(item.value ?? 0))}
      </p>
    </div>
  );
}

function SystemHealth({ system }: { system: NonNullable<AdminStats["system"]> }) {
  const services = [
    {
      label: "Database",
      icon: Database,
      ok: system.database === "connected",
      neutral: false,
      value: system.database === "connected" ? "Connected" : "Down",
    },
    {
      label: "Cache (Redis)",
      icon: Zap,
      ok: system.redis === "connected",
      neutral: system.redis === "disabled",
      value:
        system.redis === "connected" ? "Connected" : system.redis === "disabled" ? "Disabled" : "Down",
    },
    {
      label: "Web Server",
      icon: Server,
      ok: true,
      neutral: false,
      value: `Up ${formatUptime(system.uptimeSeconds)}`,
    },
    {
      label: "Memory",
      icon: Cpu,
      ok: true,
      neutral: false,
      value: `${system.memoryUsedMB} MB`,
    },
  ];

  const allOk = services.every((s) => s.ok || s.neutral);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              System Health
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                allOk ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${allOk ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`}
              />
              {allOk ? "All systems operational" : "Attention needed"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {services.map((s) => {
              const Icon = s.icon;
              const tone = s.neutral
                ? "text-muted-foreground"
                : s.ok
                  ? "text-emerald-500"
                  : "text-red-500";
              return (
                <div
                  key={s.label}
                  className="flex items-center gap-3 rounded-xl border border-border/40 bg-surface/40 p-3"
                >
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/40 ${tone}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground/70">{s.label}</p>
                    <p className={`truncate text-sm font-semibold ${tone}`}>{s.value}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/60">
            <span>Node {system.nodeVersion}</span>
            <span>Env: {system.env}</span>
            <span>Heap: {system.memoryHeapMB} MB</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function ActivityCard({
  label,
  value,
  icon: Icon,
  color,
  delay,
}: {
  label: string;
  value: number;
  icon: typeof Upload;
  color: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
    >
      <Card className="border-border/50 hover:border-accent/20 transition-colors">
        <CardContent className="flex items-center gap-4 p-5">
          <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${color}`}>
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <p className="text-3xl font-bold">{value}</p>
            <p className="text-sm text-muted-foreground">{label}</p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}