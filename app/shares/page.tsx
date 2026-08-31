"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { apiFetch } from "@/shared/api/client";
import { Button } from "@/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { apiErrorMessage, useFormat, useT } from "@/shared/lib/i18n";
import {
  Share2, Copy, Trash2, Loader2, CheckCircle,
  Link, Clock, Shield, Globe, MapPin, Smartphone,
  Monitor, Tablet, Eye, History, ChevronDown, ChevronUp,
  Activity,
} from "lucide-react";

interface ShareEntry {
  share: {
    id: string;
    token: string;
    permission: string;
    expiresAt: string | null;
    createdAt: string;
    accessCount: number;
    maxAccessCount: number | null;
    lastAccessedAt: string | null;
  };
  file: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  };
}

interface AccessLog {
  id: string;
  ip: string;
  createdAt: string;
  metadata: {
    token?: string;
    fileName?: string;
    accessCount?: number;
    maxAccessCount?: number;
    userAgent?: string;
    device?: string;
    browser?: string;
    os?: string;
    location?: {
      city: string;
      country: string;
      region: string;
      lat: number;
      lon: number;
      isp: string;
      org: string;
      timezone: string;
      asn: string;
      zip: string;
    } | null;
  } | null;
}

function getDeviceIcon(device?: string) {
  if (device === "Mobile") return Smartphone;
  if (device === "Tablet") return Tablet;
  return Monitor;
}

export default function SharesPage() {
  const t = useT();
  const { formatDate } = useFormat();
  const queryClient = useQueryClient();
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [historyShare, setHistoryShare] = useState<string | null>(null);
  const [expandedHistory, setExpandedHistory] = useState(false);

  const { data: shares, isLoading } = useQuery({
    queryKey: ["shares"],
    queryFn: async () => {
      const res = await apiFetch<{ shares: ShareEntry[] }>("/api/shares");
      return res.data?.shares ?? [];
    },
  });

  const { data: accessLogs, isLoading: logsLoading } = useQuery({
    queryKey: ["access-logs", historyShare],
    queryFn: async () => {
      if (!historyShare) return [];
      const res = await apiFetch<{ logs: AccessLog[] }>(`/api/shares/${historyShare}/access-logs`);
      return res.data?.logs ?? [];
    },
    enabled: !!historyShare,
  });

  function showMsg(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(""), 3000);
  }

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/shared/${token}`);
      setCopiedId(token);
      setTimeout(() => setCopiedId(null), 2000);
      showMsg(t("shares.linkCopied"));
    } catch {
      showMsg(t("shares.copyFailed"));
    }
  }

  async function deleteShare(id: string) {
    setLoadingId(id);
    try {
      const res = await apiFetch("/api/shares", { method: "DELETE", body: JSON.stringify({ id }) });
      if (!res.success) { showMsg(apiErrorMessage(res, t, "shares.deleteFailed")); return; }
      showMsg(t("shares.deleted"));
      if (historyShare === id) setHistoryShare(null);
      queryClient.invalidateQueries({ queryKey: ["shares"] });
    } catch {
      showMsg(t("shares.connectionFailed"));
    } finally {
      setLoadingId(null);
    }
  }

  if (isLoading) {
    return (
      <div>
        <PageHeader />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-20 skeleton rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader />

      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400"
        >
          <CheckCircle className="h-4 w-4 shrink-0" />
          {message}
        </motion.div>
      )}

      {!shares || shares.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-24 text-muted-foreground"
        >
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-accent/5 border border-accent/10">
            <Share2 className="h-10 w-10 text-accent-ink/40" />
          </div>
          <p className="text-lg font-semibold">{t("shares.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground/70">{t("shares.emptyHint")}</p>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {(shares ?? []).map(({ share, file }, idx) => (
            <div key={share.token}>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.04 }}
                className={cn(
                  "group flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-border/50 bg-surface p-4 sm:p-5 transition-all hover:shadow-md",
                  historyShare === share.id ? "border-accent/30 shadow-md" : "hover:border-accent/20"
                )}
              >
                <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
                  <div className="flex h-11 w-11 sm:h-12 sm:w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10">
                    <Link className="h-5 w-5 text-accent-ink" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{file.name}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-0.5 text-[10px] font-semibold text-accent-ink uppercase">
                        <Shield className="h-2.5 w-2.5" />
                        {share.permission === "edit"
                          ? t("shares.permission.edit")
                          : t("shares.permission.view")}
                      </span>
                      <span className="text-xs text-muted-foreground/60">
                        {t("shares.sharedOn", { date: formatDate(share.createdAt, "short") })}
                      </span>
                      {share.expiresAt && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-500">
                          <Clock className="h-3 w-3" />
                          {t("shares.expiresOn", { date: formatDate(share.expiresAt, "short") })}
                        </span>
                      )}
                      {share.accessCount > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
                          <Eye className="h-3 w-3" />
                          {share.maxAccessCount
                            ? t("shares.viewCountCapped", {
                                count: share.accessCount,
                                max: share.maxAccessCount,
                              })
                            : t("shares.viewCount", { count: share.accessCount })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 sm:ml-4 max-sm:border-t max-sm:border-border/40 max-sm:pt-3 max-sm:justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-10 min-h-[44px] sm:h-9 gap-1.5 max-sm:flex-1"
                    onClick={() => copyLink(share.token)}
                  >
                    {copiedId === share.token ? (
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedId === share.token ? t("shares.copied") : t("shares.copyLink")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-10 w-10 min-h-[44px] min-w-[44px] sm:h-9 sm:w-9",
                      historyShare === share.id
                        ? "text-accent-ink bg-accent/10"
                        : "text-muted-foreground/60 hover:text-accent-ink hover:bg-accent/10"
                    )}
                    onClick={() => setHistoryShare(historyShare === share.id ? null : share.id)}
                    title={t("shares.viewAccessHistory")}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 min-h-[44px] min-w-[44px] sm:h-9 sm:w-9 text-muted-foreground/60 hover:text-danger-ink hover:bg-danger/10"
                    disabled={loadingId === share.id}
                    onClick={() => deleteShare(share.id)}
                    title={t("shares.deleteShare")}
                  >
                    {loadingId === share.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </motion.div>

              {/* Access History Panel */}
              <AnimatePresence>
                {historyShare === share.id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 rounded-2xl border border-border/40 bg-muted/20 p-5">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                          <Activity className="h-4 w-4 text-accent-ink" />
                          {t("shares.accessHistory")}
                          <span className="text-xs font-normal text-muted-foreground/60">
                            ({t("shares.accessCount", { count: share.accessCount })})
                          </span>
                        </h3>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setExpandedHistory(!expandedHistory)}
                        >
                          {expandedHistory ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </Button>
                      </div>

                      {logsLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="h-5 w-5 animate-spin text-accent-ink" />
                        </div>
                      ) : !accessLogs || accessLogs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                          <Globe className="h-8 w-8 mb-2 opacity-30" />
                          <p className="text-sm font-medium">{t("shares.noAccessData")}</p>
                          <p className="text-xs text-muted-foreground/60 mt-1">{t("shares.noAccessDataHint")}</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {(expandedHistory ? accessLogs : accessLogs.slice(0, 5)).map((log, logIdx) => {
                            const DeviceIcon = getDeviceIcon(log.metadata?.device);
                            const location = log.metadata?.location;
                            return (
                              <motion.div
                                key={log.id}
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: logIdx * 0.03 }}
                                className="flex items-start gap-3 rounded-xl bg-surface border border-border/30 p-3.5 hover:border-accent/20 transition-all"
                              >
                                {/* Device Icon */}
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 mt-0.5">
                                  <DeviceIcon className="h-4 w-4 text-accent-ink" />
                                </div>

                                {/* Details */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-semibold">
                                      {log.metadata?.device ?? t("shares.unknownDevice")}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/50">•</span>
                                    <span className="text-[11px] text-muted-foreground/70">
                                      {log.metadata?.browser ?? t("shares.unknown")}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/50">•</span>
                                    <span className="text-[11px] text-muted-foreground/70">
                                      {log.metadata?.os ?? t("shares.unknown")}
                                    </span>
                                  </div>

                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px] text-muted-foreground/60">
                                    <span className="inline-flex items-center gap-1 font-mono">
                                      <Globe className="h-3 w-3" />
                                      {log.ip}
                                    </span>
                                    {location && (
                                      <>
                                        <span className="inline-flex items-center gap-1" title={t("shares.location")}>
                                          <MapPin className="h-3 w-3" />
                                          {[location.city, location.region, location.country].filter(Boolean).join(", ")}
                                        </span>
                                        {location.isp && (
                                          <span className="inline-flex items-center gap-1" title={t("shares.isp")}>
                                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                                            {location.isp}
                                          </span>
                                        )}
                                        {location.timezone && (
                                          <span className="inline-flex items-center gap-1" title={t("shares.timezone")}>
                                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                            {location.timezone}
                                          </span>
                                        )}
                                        {location.asn && (
                                          <span className="inline-flex items-center gap-1 font-mono" title="ASN">
                                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
                                            {location.asn}
                                          </span>
                                        )}
                                      </>
                                    )}
                                    <span className="inline-flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {formatDate(log.createdAt, "short")}
                                    </span>
                                  </div>
                                </div>

                                {/* Mini Map */}
                                {location && (
                                  <div className="hidden sm:block shrink-0">
                                    <a
                                      href={`https://www.google.com/maps?q=${location.lat},${location.lon}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block h-10 w-14 rounded-lg bg-muted/30 border border-border/30 overflow-hidden hover:border-accent/30 transition-all group/map"
                                    >
                                      <img
                                        src={`https://api.mapbox.com/styles/v1/mapbox/light-v11/static/pin-l+6366f1(${location.lon},${location.lat})/${location.lon},${location.lat},10,0/80x60@2x?access_token=pk.eyJ1IjoiYnlhZnIiLCJhIjoiY2x5MnF3dmdmMDdqYjJrc2NpYzBkOHlwdyJ9.abc123`}
                                        alt={t("shares.mapAlt")}
                                        className="h-full w-full object-cover"
                                        onError={(e) => {
                                          (e.target as HTMLImageElement).style.display = "none";
                                        }}
                                      />
                                    </a>
                                  </div>
                                )}
                              </motion.div>
                            );
                          })}

                          {!expandedHistory && accessLogs.length > 5 && (
                            <button
                              onClick={() => setExpandedHistory(true)}
                              className="w-full py-2 text-xs text-accent-ink hover:text-foreground transition-colors flex items-center justify-center gap-1"
                            >
                              <ChevronDown className="h-3 w-3" />
                              {t("shares.showAll", { count: accessLogs.length })}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PageHeader() {
  const t = useT();
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6"
    >
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("shares.title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground/70">{t("shares.subtitle")}</p>
    </motion.div>
  );
}
