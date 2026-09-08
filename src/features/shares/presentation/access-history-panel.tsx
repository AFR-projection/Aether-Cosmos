"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  Clock,
  ExternalLink,
  Globe,
  Loader2,
  MapPin,
  Monitor,
  RefreshCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import { buildGoogleMapsUrl } from "@shares/domain/access-history-map";
import { apiFetch } from "@/shared/api/client";
import { useFormat, useT } from "@/shared/lib/i18n";
import { Button } from "@/ui/primitives/button";
import type { AccessLog, AccessLogLocation } from "./sharing-types";

const INITIAL_LOG_LIMIT = 5;

function getDeviceIcon(device?: string) {
  if (device === "Mobile") return Smartphone;
  if (device === "Tablet") return Tablet;
  return Monitor;
}

function getGoogleMapsUrl(
  location: AccessLogLocation | null | undefined
): string | null {
  return location ? buildGoogleMapsUrl(location.lat, location.lon) : null;
}

export function AccessHistoryPanel({ shareId }: { shareId: string }) {
  const t = useT();
  const { formatDate } = useFormat();
  const [showAll, setShowAll] = useState(false);
  const logsQuery = useQuery({
    queryKey: ["access-logs", shareId],
    queryFn: async () => {
      const res = await apiFetch<{ logs: AccessLog[] }>(`/api/shares/${shareId}/access-logs`);
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load access history");
      return res.data.logs;
    },
  });
  const logs = logsQuery.data ?? [];
  const visible = showAll ? logs : logs.slice(0, INITIAL_LOG_LIMIT);

  return (
    <div className="shr-history" aria-busy={logsQuery.isFetching}>
      <div className="shr-history__head">
        <h3><Activity aria-hidden="true" />{t("shares.accessHistory")}</h3>
      </div>
      {logsQuery.isLoading ? (
        <div className="shr-history__state"><Loader2 className="animate-spin" aria-hidden="true" /><span>{t("shares.historyLoading")}</span></div>
      ) : logsQuery.isError ? (
        <div className="shr-history__state" role="alert">
          <Globe aria-hidden="true" />
          <strong>{t("shares.historyError")}</strong>
          <span>{t("shares.historyErrorHint")}</span>
          <Button variant="secondary" size="sm" onClick={() => void logsQuery.refetch()} disabled={logsQuery.isFetching}>
            <RefreshCw className={logsQuery.isFetching ? "animate-spin" : undefined} aria-hidden="true" />{t("errorPages.tryAgain")}
          </Button>
        </div>
      ) : logs.length === 0 ? (
        <div className="shr-history__state"><Globe aria-hidden="true" /><strong>{t("shares.noAccessData")}</strong><span>{t("shares.noAccessDataHint")}</span></div>
      ) : (
        <>
          <ol className="shr-history__list">
            {visible.map((log, index) => {
              const DeviceIcon = getDeviceIcon(log.metadata?.device);
              const location = log.metadata?.location;
              const googleMapsUrl = getGoogleMapsUrl(location);
              return (
                <motion.li key={log.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: index * 0.025 }} className="shr-history__event">
                  <span className="shr-history__device" aria-hidden="true"><DeviceIcon /></span>
                  <div className="shr-history__details">
                    <p><strong>{log.metadata?.device ?? t("shares.unknownDevice")}</strong><span>{log.metadata?.browser ?? t("shares.unknown")}</span><span>{log.metadata?.os ?? t("shares.unknown")}</span></p>
                    <p className="shr-history__meta">
                      <span><Globe aria-hidden="true" />{log.ip}</span>
                      {location && <span><MapPin aria-hidden="true" />{[location.city, location.region, location.country].filter(Boolean).join(", ")}</span>}
                      <span><Clock aria-hidden="true" />{formatDate(log.createdAt, "short")}</span>
                      {googleMapsUrl && (
                        <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer" aria-label={t("shares.openMapLabel")}>
                          {t("shares.openMap")}<ExternalLink aria-hidden="true" />
                        </a>
                      )}
                    </p>
                  </div>
                </motion.li>
              );
            })}
          </ol>
          {!showAll && logs.length > INITIAL_LOG_LIMIT && (
            <Button variant="ghost" size="sm" className="shr-history__more" onClick={() => setShowAll(true)}>
              {t("shares.showAll", { count: logs.length })}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
