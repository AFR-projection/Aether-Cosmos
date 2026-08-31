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
import { Button } from "@/ui/primitives/button";
import { apiFetch } from "@/shared/api/client";
import { APP_NAME } from "@/shared/lib/app-version";
import { cn } from "@/shared/lib/utils";
import { getAccentColor, getGradientFallback, getFileTypeIcon } from "@/shared/lib/file-type-utils";
import { useFormat, useT, type TranslationKey, type Translator } from "@/shared/lib/i18n";

const activityIcons: Record<string, LucideIcon> = {
  upload: Cloud,
  download: Download,
  delete: Archive,
  login: ShieldCheck,
  create: FileText,
  restore: RefreshCw,
};

function filePresentation(
  file: FileItem,
  t: Translator
): { icon: React.ElementType; label: string; tone: string } {
  if (file.isNote) return { icon: Activity, label: t("common.note"), tone: "note" };
  const Icon = getFileTypeIcon(file.mimeType ?? "");
  const accentClass = getAccentColor(file.mimeType ?? "");
  const tone = accentClass.replace("text-", "").replace("-500", "").replace("-400", "");
  // The MIME top-level type ("image", "video") is a protocol token, not prose.
  return { icon: Icon, label: file.mimeType?.split("/")[0] ?? t("common.file"), tone };
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


/** Activity `action` column → dictionary key. Typed, so a rename fails the build. */
const ACTION_KEYS: Record<string, TranslationKey> = {
  upload: "dashboard.action.upload",
  download: "dashboard.action.download",
  delete: "dashboard.action.delete",
  login: "dashboard.action.login",
  create: "dashboard.action.create",
  restore: "dashboard.action.restore",
};

function actionCopy(action: string, t: Translator) {
  const key = ACTION_KEYS[action];
  // An unmapped action falls back to its own de-underscored name: a technical
  // token, which reads the same in every locale.
  return key ? t(key) : action.replace(/[-_]/g, " ");
}

function metadataName(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return null;
  const name = (metadata as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

/** The label is returned as a key so the caller translates it in its own locale. */
function getStorageState(stats: DashboardStats): {
  pct: number;
  tone: string;
  labelKey: TranslationKey;
} {
  if (!stats.storageQuota)
    return { pct: 0, tone: "neutral", labelKey: "dashboard.quotaNotConfigured" };
  const pct = Math.max(0, Math.min(100, (stats.storageUsed / stats.storageQuota) * 100));
  const threshold = Math.min(100, Math.max(50, stats.storageWarningThreshold ?? 85));
  if (pct >= threshold) return { pct, tone: "critical", labelKey: "dashboard.capacityAttention" };
  if (pct >= threshold - 20)
    return { pct, tone: "warning", labelKey: "dashboard.capacityApproaching" };
  return { pct, tone: "healthy", labelKey: "dashboard.capacityHealthy" };
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
  const t = useT();
  return (
    <header className="dashboard-header">
      <div>
        <p className="dashboard-kicker"><span aria-hidden="true" /> {t("dashboard.kicker")}</p>
        <h1>{t("dashboard.title")}</h1>
        <p>{t("dashboard.subtitle")}</p>
      </div>

      <div className="dashboard-header__actions">
        <span className="dashboard-refresh" aria-live="polite">
          <RefreshCw className={cn(isRefreshing && "animate-spin")} aria-hidden="true" />
          {isRefreshing ? t("dashboard.refreshing") : t("dashboard.autoRefresh")}
        </span>
        <Button asChild size="lg" className="dashboard-open-files">
          <Link href="/files">
            {t("dashboard.openFiles")}
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </header>
  );
}

function StorageHero({ stats }: { stats: DashboardStats }) {
  const t = useT();
  const { formatBytes, formatNumber } = useFormat();
  const state = getStorageState(stats);
  const remaining = Math.max(0, stats.storageRemaining);

  return (
    <section className="dashboard-storage" data-tone={state.tone} aria-labelledby="storage-overview-heading">
      <div className="dashboard-storage__copy">
        <div className="dashboard-storage__eyebrow">
          <span className="dashboard-storage__signal" aria-hidden="true" />
          {t("dashboard.liveCapacity")}
        </div>
        <h2 id="storage-overview-heading">{t("dashboard.storageOverview")}</h2>
        <p>{t("dashboard.storageState", { state: t(state.labelKey) })}</p>

        <div className="dashboard-storage__value">
          <strong>{formatBytes(stats.storageUsed)}</strong>
          <span>
            {t("dashboard.usedOf", {
              total: stats.storageQuota ? formatBytes(stats.storageQuota) : t("dashboard.unlimited"),
            })}
          </span>
        </div>

        <div className="dashboard-storage__details">
          <div>
            <span>{t("dashboard.available")}</span>
            <strong>{stats.storageQuota ? formatBytes(remaining) : "—"}</strong>
          </div>
          <div>
            <span>{t("dashboard.threshold")}</span>
            <strong>{stats.storageQuota ? `${stats.storageWarningThreshold ?? 85}%` : "—"}</strong>
          </div>
        </div>

        {state.tone !== "healthy" && state.tone !== "neutral" && (
          <p className="dashboard-storage__notice" role="status">
            <TriangleAlert aria-hidden="true" />
            {state.tone === "critical"
              ? t("dashboard.noticeCritical")
              : t("dashboard.noticeWarning")}
          </p>
        )}
      </div>

      <div
        className="dashboard-capacity"
        role="img"
        aria-label={t("dashboard.capacityLabel", { percent: formatNumber(Math.round(state.pct)) })}
      >
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
          <strong>{formatNumber(Math.round(state.pct))}<span>%</span></strong>
          <span>{t("dashboard.inUse")}</span>
        </div>
      </div>
    </section>
  );
}

function InventoryPanel({ stats }: { stats: DashboardStats }) {
  const t = useT();
  const { formatNumber } = useFormat();
  const metrics = [
    {
      label: t("dashboard.metricFiles"),
      value: formatNumber(stats.totalFiles),
      icon: FileText,
      note: t("dashboard.metricFilesNote"),
    },
    {
      label: t("dashboard.metricFolders"),
      value: formatNumber(stats.totalFolders),
      icon: FolderOpen,
      note: t("dashboard.metricFoldersNote"),
    },
    {
      label: t("dashboard.metricCapacity"),
      value: stats.storageQuota
        ? `${formatNumber(Math.round((stats.storageUsed / stats.storageQuota) * 100))}%`
        : "—",
      icon: Gauge,
      note: t("dashboard.metricCapacityNote"),
    },
  ];

  return (
    <section className="dashboard-panel dashboard-inventory" aria-labelledby="inventory-heading">
      <PanelHeading id="inventory-heading" icon={LayoutGrid} title={t("dashboard.inventory")} />
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
  const t = useT();
  const { formatBytes, formatDate } = useFormat();
  return (
    <section className="dashboard-panel dashboard-files" aria-labelledby="recent-files-heading">
      <PanelHeading
        icon={FileText}
        id="recent-files-heading"
        title={t("dashboard.recentFiles")}
        action={
          <Link href="/files" className="dashboard-panel__link">
            {t("dashboard.viewAll")} <ArrowRight aria-hidden="true" />
          </Link>
        }
      />

      {files.length ? (
        <div className="dashboard-files__list">
          {files.slice(0, 6).map((file, index) => {
            const presentation = filePresentation(file, t);
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
        <EmptyPanel
          icon={Cloud}
          title={t("dashboard.noRecentFiles")}
          description={t("dashboard.noRecentFilesBody")}
          actionLabel={t("dashboard.goToFiles")}
        />
      )}
    </section>
  );
}

function ActivityPanel({ items }: { items: ActivityItem[] }) {
  const t = useT();
  const { formatDate } = useFormat();
  return (
    <section className="dashboard-panel dashboard-activity" aria-labelledby="activity-heading">
      <PanelHeading id="activity-heading" icon={Activity} title={t("dashboard.activityStream")} />

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
                    <strong>{actionCopy(item.action, t)}</strong>
                    {name && <small>{name}</small>}
                  </span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt, "short")}</time>
                </div>
              </motion.li>
            );
          })}
        </ol>
      ) : (
        <EmptyPanel
          icon={Sparkles}
          title={t("dashboard.noActivity")}
          description={t("dashboard.noActivityBody")}
        />
      )}
    </section>
  );
}

function SystemPulse({ stats }: { stats: NonNullable<DashboardData["globalStats"]> }) {
  const t = useT();
  const { formatBytes, formatNumber } = useFormat();
  const signals = [
    { label: t("dashboard.signalUsers"), value: formatNumber(stats.totalUsers), icon: Users },
    { label: t("dashboard.signalFiles"), value: formatNumber(stats.totalFiles), icon: FileText },
    { label: t("dashboard.signalStored"), value: formatBytes(stats.totalStorage), icon: HardDrive },
  ];

  return (
    <section className="dashboard-system" aria-labelledby="system-pulse-heading">
      <div>
        <p className="dashboard-kicker"><span aria-hidden="true" /> {t("dashboard.adminSignal")}</p>
        <h2 id="system-pulse-heading">{t("dashboard.systemPulse")}</h2>
        <p>{t("dashboard.systemPulseBody", { app: APP_NAME })}</p>
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
        <Link href="/admin">{t("dashboard.openAdmin")} <ArrowUpRight aria-hidden="true" /></Link>
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
  const t = useT();
  return (
    <div className="dashboard-page" aria-busy="true" aria-label={t("dashboard.loading")}>
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
  const t = useT();
  return (
    <div className="dashboard-page">
      <section className="dashboard-error" role="alert">
        <span aria-hidden="true"><TriangleAlert /></span>
        <div>
          <h1>{t("dashboard.errorTitle")}</h1>
          <p>{t("dashboard.errorBody")}</p>
          <Button type="button" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={cn(retrying && "animate-spin")} aria-hidden="true" />
            {t("errorPages.tryAgain")}
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
