"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { MotionConfig, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Archive,
  ArrowRight,
  ArrowUpRight,
  Cloud,
  Download,
  FileText,
  FolderOpen,
  Gauge,
  HardDrive,
  LayoutGrid,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { APP_NAME } from "@/lib/app-version";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import { getAccentColor, getGradientFallback, getFileTypeIcon } from "@/lib/file-type-utils";

const activityIcons: Record<string, LucideIcon> = {
  upload: Cloud,
  download: Download,
  delete: Archive,
  login: ShieldCheck,
  create: FileText,
  restore: RefreshCw,
};

function filePresentation(file: FileItem): { icon: React.ElementType; label: string; tone: string } {
  if (file.isNote) return { icon: Activity, label: "Note", tone: "note" };
  const Icon = getFileTypeIcon(file.mimeType ?? "");
  const accentClass = getAccentColor(file.mimeType ?? "");
  const tone = accentClass.replace("text-", "").replace("-500", "").replace("-400", "");
  return { icon: Icon, label: file.mimeType?.split("/")[0] ?? "File", tone };
}

interface DashboardStats {
  totalFiles: number;
  totalFolders: number;
  storageUsed: number;
  storageQuota: number;
  storageRemaining: number;
  storageWarningThreshold?: number;
}

interface ActivityItem {
  id: string;
  action: string;
  createdAt: string;
  metadata: unknown;
}

interface FileItem {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  updatedAt: string;
  isNote?: boolean;
}

interface DashboardData {
  stats: DashboardStats;
  recentFiles: FileItem[];
  recentActivity: ActivityItem[];
  globalStats?: {
    totalUsers: number;
    totalFiles: number;
    totalStorage: number;
  } | null;
}


function actionCopy(action: string) {
  const copy: Record<string, string> = {
    upload: "Uploaded a file",
    download: "Downloaded a file",
    delete: "Moved a file to recycle bin",
    login: "Signed in to the workspace",
    create: "Created a new item",
    restore: "Restored a file",
  };
  return copy[action] ?? action.replace(/[-_]/g, " ");
}

function metadataName(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return null;
  const name = (metadata as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function getStorageState(stats: DashboardStats) {
  if (!stats.storageQuota) return { pct: 0, tone: "neutral", label: "Quota not configured" };
  const pct = Math.max(0, Math.min(100, (stats.storageUsed / stats.storageQuota) * 100));
  const threshold = Math.min(100, Math.max(50, stats.storageWarningThreshold ?? 85));
  if (pct >= threshold) return { pct, tone: "critical", label: "Capacity needs attention" };
  if (pct >= threshold - 20) return { pct, tone: "warning", label: "Approaching capacity threshold" };
  return { pct, tone: "healthy", label: "Capacity is healthy" };
}

function PanelHeading({
  icon: Icon,
  title,
  action,
  id,
}: {
  icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="dashboard-panel__heading">
      <span className="dashboard-panel__icon" aria-hidden="true"><Icon /></span>
      <h2 id={id}>{title}</h2>
      {action && <div className="dashboard-panel__action">{action}</div>}
    </div>
  );
}

function DashboardHeader({ isRefreshing }: { isRefreshing: boolean }) {
  return (
    <header className="dashboard-header">
      <div>
        <p className="dashboard-kicker"><span aria-hidden="true" /> Workspace overview</p>
        <h1>Your storage, in focus.</h1>
        <p>Everything important—capacity, recent work, and activity—in one calm view.</p>
      </div>

      <div className="dashboard-header__actions">
        <span className="dashboard-refresh" aria-live="polite">
          <RefreshCw className={cn(isRefreshing && "animate-spin")} aria-hidden="true" />
          {isRefreshing ? "Refreshing" : "Auto-refreshes every 30s"}
        </span>
        <Button asChild size="lg" className="dashboard-open-files">
          <Link href="/files">
            Open files
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </header>
  );
}

function StorageHero({ stats }: { stats: DashboardStats }) {
  const state = getStorageState(stats);
  const remaining = Math.max(0, stats.storageRemaining);

  return (
    <section className="dashboard-storage" data-tone={state.tone} aria-labelledby="storage-overview-heading">
      <div className="dashboard-storage__copy">
        <div className="dashboard-storage__eyebrow">
          <span className="dashboard-storage__signal" aria-hidden="true" />
          Live capacity
        </div>
        <h2 id="storage-overview-heading">Storage overview</h2>
        <p>{state.label}. Your workspace updates automatically as files change.</p>

        <div className="dashboard-storage__value">
          <strong>{formatBytes(stats.storageUsed)}</strong>
          <span>used of {stats.storageQuota ? formatBytes(stats.storageQuota) : "unlimited storage"}</span>
        </div>

        <div className="dashboard-storage__details">
          <div>
            <span>Available</span>
            <strong>{stats.storageQuota ? formatBytes(remaining) : "—"}</strong>
          </div>
          <div>
            <span>Threshold</span>
            <strong>{stats.storageQuota ? `${stats.storageWarningThreshold ?? 85}%` : "—"}</strong>
          </div>
        </div>

        {state.tone !== "healthy" && state.tone !== "neutral" && (
          <p className="dashboard-storage__notice" role="status">
            <TriangleAlert aria-hidden="true" />
            {state.tone === "critical"
              ? "Storage is at or over the configured warning threshold."
              : "You are getting closer to the configured storage threshold."}
          </p>
        )}
      </div>

      <div className="dashboard-capacity" role="img" aria-label={`${Math.round(state.pct)} percent of storage capacity used`}>
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="dashboard-capacity__track" cx="60" cy="60" r="48" pathLength="1" />
          <motion.circle
            className="dashboard-capacity__value"
            cx="60"
            cy="60"
            r="48"
            pathLength="1"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: state.pct / 100 }}
            transition={{ duration: 0.85, ease: [0.16, 1, 0.3, 1] }}
          />
        </svg>
        <div className="dashboard-capacity__center">
          <strong>{Math.round(state.pct)}<span>%</span></strong>
          <span>in use</span>
        </div>
      </div>
    </section>
  );
}

function InventoryPanel({ stats }: { stats: DashboardStats }) {
  const metrics = [
    { label: "Files", value: stats.totalFiles.toLocaleString(), icon: FileText, note: "Across your workspace" },
    { label: "Folders", value: stats.totalFolders.toLocaleString(), icon: FolderOpen, note: "Organized spaces" },
    { label: "Capacity", value: stats.storageQuota ? `${Math.round((stats.storageUsed / stats.storageQuota) * 100)}%` : "—", icon: Gauge, note: "Current use" },
  ];

  return (
    <section className="dashboard-panel dashboard-inventory" aria-labelledby="inventory-heading">
      <PanelHeading id="inventory-heading" icon={LayoutGrid} title="Workspace inventory" />
      <div className="dashboard-inventory__grid">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div className="dashboard-inventory__metric" key={metric.label}>
              <span className="dashboard-inventory__icon" aria-hidden="true"><Icon /></span>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.note}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RecentFilesPanel({ files }: { files: FileItem[] }) {
  return (
    <section className="dashboard-panel dashboard-files" aria-labelledby="recent-files-heading">
      <PanelHeading
        icon={FileText}
        id="recent-files-heading"
        title="Recent files"
        action={<Link href="/files" className="dashboard-panel__link">View all <ArrowRight aria-hidden="true" /></Link>}
      />

      {files.length ? (
        <div className="dashboard-files__list">
          {files.slice(0, 6).map((file, index) => {
            const presentation = filePresentation(file);
            const Icon = presentation.icon;
            return (
              <motion.div
                key={file.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.035, duration: 0.22 }}
              >
                <Link href={`/files?select=${encodeURIComponent(file.id)}`} className="dashboard-file-row">
                  <span className="dashboard-file-row__icon" data-kind={presentation.tone} aria-hidden="true"><Icon /></span>
                  <span className="dashboard-file-row__content">
                    <strong>{file.name}</strong>
                    <small>{presentation.label} · {formatDate(file.updatedAt, "short")}</small>
                  </span>
                  <span className="dashboard-file-row__size">{formatBytes(file.sizeBytes)}</span>
                  <ArrowUpRight className="dashboard-file-row__arrow" aria-hidden="true" />
                </Link>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <EmptyPanel icon={Cloud} title="Nothing here yet" description="Upload your first file to start building your workspace." actionLabel="Go to files" />
      )}
    </section>
  );
}

function ActivityPanel({ items }: { items: ActivityItem[] }) {
  return (
    <section className="dashboard-panel dashboard-activity" aria-labelledby="activity-heading">
      <PanelHeading id="activity-heading" icon={Activity} title="Activity stream" />

      {items.length ? (
        <ol className="dashboard-activity__list">
          {items.slice(0, 7).map((item, index) => {
            const Icon = activityIcons[item.action] ?? Activity;
            const name = metadataName(item.metadata);
            return (
              <motion.li
                key={item.id}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.035, duration: 0.22 }}
              >
                <div className="dashboard-activity__item">
                  <span className="dashboard-activity__icon" aria-hidden="true"><Icon /></span>
                  <span className="dashboard-activity__content">
                    <strong>{actionCopy(item.action)}</strong>
                    {name && <small>{name}</small>}
                  </span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt, "short")}</time>
                </div>
              </motion.li>
            );
          })}
        </ol>
      ) : (
        <EmptyPanel icon={Sparkles} title="Your activity will appear here" description="Uploads, downloads, and file changes become a readable timeline." />
      )}
    </section>
  );
}

function SystemPulse({ stats }: { stats: NonNullable<DashboardData["globalStats"]> }) {
  const signals = [
    { label: "Users", value: stats.totalUsers.toLocaleString(), icon: Users },
    { label: "Files", value: stats.totalFiles.toLocaleString(), icon: FileText },
    { label: "Stored", value: formatBytes(stats.totalStorage), icon: HardDrive },
  ];

  return (
    <section className="dashboard-system" aria-labelledby="system-pulse-heading">
      <div>
        <p className="dashboard-kicker"><span aria-hidden="true" /> Admin signal</p>
        <h2 id="system-pulse-heading">System pulse</h2>
        <p>A quick view of the whole {APP_NAME} workspace.</p>
      </div>
      <div className="dashboard-system__metrics">
        {signals.map((signal) => {
          const Icon = signal.icon;
          return (
            <div key={signal.label}>
              <span><Icon aria-hidden="true" /> {signal.label}</span>
              <strong>{signal.value}</strong>
            </div>
          );
        })}
      </div>
      <Button asChild variant="secondary" size="sm">
        <Link href="/admin">Open admin <ArrowUpRight aria-hidden="true" /></Link>
      </Button>
    </section>
  );
}

function EmptyPanel({
  icon: Icon,
  title,
  description,
  actionLabel,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
}) {
  return (
    <div className="dashboard-empty">
      <span className="dashboard-empty__icon" aria-hidden="true"><Icon /></span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
        {actionLabel && <Link href="/files">{actionLabel} <ArrowRight aria-hidden="true" /></Link>}
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-page" aria-busy="true" aria-label="Loading dashboard">
      <div className="dashboard-skeleton dashboard-skeleton--header" />
      <div className="dashboard-skeleton-grid">
        <div className="dashboard-skeleton dashboard-skeleton--hero" />
        <div className="dashboard-skeleton dashboard-skeleton--inventory" />
      </div>
      <div className="dashboard-skeleton-grid dashboard-skeleton-grid--bottom">
        <div className="dashboard-skeleton dashboard-skeleton--panel" />
        <div className="dashboard-skeleton dashboard-skeleton--panel" />
      </div>
    </div>
  );
}

function DashboardError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <div className="dashboard-page">
      <section className="dashboard-error" role="alert">
        <span aria-hidden="true"><TriangleAlert /></span>
        <div>
          <h1>Dashboard is taking a moment.</h1>
          <p>We could not load your latest workspace overview. Your files are safe—try refreshing the view.</p>
          <Button type="button" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={cn(retrying && "animate-spin")} aria-hidden="true" />
            Try again
          </Button>
        </div>
      </section>
    </div>
  );
}

export default function DashboardPage() {
  const { data, isError, isFetching, isLoading, refetch } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const res = await apiFetch<DashboardData>("/api/dashboard");
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load dashboard");
      return res.data;
    },
    refetchInterval: 30_000,
  });

  if (isLoading) return <DashboardSkeleton />;
  if (isError || !data?.stats) return <DashboardError retrying={isFetching} onRetry={() => void refetch()} />;

  return (
    <MotionConfig reducedMotion="user">
      <div className="dashboard-page">
        <DashboardHeader isRefreshing={isFetching} />

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          className="dashboard-grid dashboard-grid--top"
        >
          <StorageHero stats={data.stats} />
          <InventoryPanel stats={data.stats} />
        </motion.div>

        <div className="dashboard-grid dashboard-grid--bottom">
          <RecentFilesPanel files={data.recentFiles ?? []} />
          <ActivityPanel items={data.recentActivity ?? []} />
        </div>

        {data.globalStats && <SystemPulse stats={data.globalStats} />}
      </div>
    </MotionConfig>
  );
}
