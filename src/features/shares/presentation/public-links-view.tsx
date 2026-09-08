"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  Copy,
  Eye,
  History,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { derivePublicLinkStatus, type PublicLinkStatus } from "@shares/domain/public-link-status";
import { useFormat, useT } from "@/shared/lib/i18n";
import { Button } from "@/ui/primitives/button";
import type { ShareEntry } from "./sharing-types";
import { AccessHistoryPanel } from "./access-history-panel";

type LinkSort = "recent" | "name" | "status";

const STATUS_KEYS: Record<PublicLinkStatus, "shares.status.active" | "shares.status.expired" | "shares.status.limitReached"> = {
  active: "shares.status.active",
  expired: "shares.status.expired",
  "limit-reached": "shares.status.limitReached",
};

export function PublicLinksView({
  sharesQuery,
  expandedShareId,
  revokingShareId,
  onCopy,
  onToggleHistory,
  onRevoke,
}: {
  sharesQuery: UseQueryResult<ShareEntry[], Error>;
  expandedShareId: string | null;
  revokingShareId: string | null;
  onCopy: (token: string) => void;
  onToggleHistory: (shareId: string) => void;
  onRevoke: (share: ShareEntry) => void;
}) {
  const t = useT();
  const { formatDate, formatNumber } = useFormat();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LinkSort>("recent");
  const shares = useMemo(() => sharesQuery.data ?? [], [sharesQuery.data]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = needle ? shares.filter(({ file }) => file.name.toLowerCase().includes(needle)) : [...shares];
    if (sort === "name") return rows.sort((a, b) => a.file.name.localeCompare(b.file.name));
    if (sort === "status") return rows.sort((a, b) => derivePublicLinkStatus(a.share).localeCompare(derivePublicLinkStatus(b.share)));
    return rows.sort((a, b) => b.share.createdAt.localeCompare(a.share.createdAt));
  }, [shares, query, sort]);

  return (
    <motion.section className="shr-panel" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }} aria-labelledby="links-heading">
      <div className="shr-panel__head">
        <span className="shr-panel__icon" aria-hidden="true"><Link2 /></span>
        <div><h2 className="shr-panel__title" id="links-heading">{t("shares.managedLinks")}</h2><p className="shr-panel__sub">{t("shares.managedLinksSub")}</p></div>
        {!sharesQuery.isLoading && shares.length > 0 && <span className="shr-count">{formatNumber(shares.length)}</span>}
        {shares.length > 3 && (
          <div className="shr-panel__tools">
            <div className="shr-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("shares.searchPlaceholder")} aria-label={t("shares.searchLabel")} /></div>
            <select className="shr-select" value={sort} onChange={(event) => setSort(event.target.value as LinkSort)} aria-label={t("shares.sortLabel")}>
              <option value="recent">{t("shares.sortRecent")}</option><option value="name">{t("shares.sortName")}</option><option value="status">{t("shares.sortStatus")}</option>
            </select>
          </div>
        )}
      </div>
      <div className="shr-panel__body shr-panel__body--links" aria-busy={sharesQuery.isFetching}>
        {sharesQuery.isLoading ? (
          <div className="shr-links" aria-label={t("shares.loading")}>
            {[0, 1, 2].map((i) => <div key={i} className="skeleton shr-skel shr-skel--link" />)}
          </div>
        ) : sharesQuery.isError ? (
          <div className="shr-empty" role="alert"><AlertCircle aria-hidden="true" /><p>{t("shares.loadError")}</p><span>{t("shares.loadErrorHint")}</span><Button variant="secondary" size="sm" onClick={() => void sharesQuery.refetch()} disabled={sharesQuery.isFetching}><RefreshCw className={sharesQuery.isFetching ? "animate-spin" : undefined} aria-hidden="true" />{t("errorPages.tryAgain")}</Button></div>
        ) : shares.length === 0 ? (
          <div className="shr-empty"><Link2 aria-hidden="true" /><p>{t("shares.empty")}</p><span>{t("shares.emptyHint")}</span><Button asChild variant="secondary" size="sm"><a href="/files">{t("shares.openFiles")}</a></Button></div>
        ) : visible.length === 0 ? (
          <div className="shr-empty"><Search aria-hidden="true" /><p>{t("shares.noMatch", { query: query.trim() })}</p><span>{t("shares.noMatchHint")}</span><Button variant="secondary" size="sm" onClick={() => setQuery("")}><X aria-hidden="true" />{t("sharedWithMe.clearSearch")}</Button></div>
        ) : (
          <div className="shr-links">
            {visible.map((entry) => {
              const { share, file } = entry;
              const status = derivePublicLinkStatus(share);
              const expanded = expandedShareId === share.id;
              const panelId = `share-history-${share.id}`;
              return (
                <div className="shr-link" data-expanded={expanded || undefined} key={share.id}>
                  <div className="shr-link__row">
                    <span className="shr-link__icon" aria-hidden="true"><Link2 /></span>
                    <div className="shr-link__main">
                      <p className="shr-link__name" title={file.name}>{file.name}</p>
                      <div className="shr-link__meta">
                        <span className="shr-role" data-role={share.permission === "edit" ? "edit" : "view"}><Shield aria-hidden="true" />{share.permission === "edit" ? t("shares.permission.edit") : t("shares.permission.view")}</span>
                        <span>{t("shares.sharedOn", { date: formatDate(share.createdAt, "short") })}</span>
                        {share.expiresAt && <span>{t("shares.expiresOn", { date: formatDate(share.expiresAt, "short") })}</span>}
                        <span><Eye aria-hidden="true" />{share.maxAccessCount === null ? t("shares.viewCount", { count: share.accessCount }) : t("shares.viewCountCapped", { count: share.accessCount, max: share.maxAccessCount })}</span>
                        <span className="shr-status" data-status={status}>{status === "active" ? <CheckCircle aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}{t(STATUS_KEYS[status])}</span>
                      </div>
                    </div>
                    <div className="shr-link__actions">
                      <Button variant="ghost" size="sm" onClick={() => onCopy(share.token)} aria-label={t("shares.copyLinkLabel", { file: file.name })}><Copy aria-hidden="true" />{t("shares.copyLink")}</Button>
                      <Button variant="ghost" size="sm" onClick={() => onToggleHistory(share.id)} aria-expanded={expanded} aria-controls={panelId} aria-label={expanded ? t("shares.hideAccessHistoryLabel", { file: file.name }) : t("shares.viewAccessHistoryLabel", { file: file.name })}><History aria-hidden="true" />{t("shares.accessHistory")}<ChevronDown className="shr-disclosure" aria-hidden="true" /></Button>
                      <Button variant="ghost" size="sm" data-danger="true" disabled={revokingShareId === share.id} onClick={() => onRevoke(entry)} aria-label={t("shares.revokeLabel", { file: file.name })}>{revokingShareId === share.id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}{t("shares.revoke")}</Button>
                    </div>
                  </div>
                  <AnimatePresence initial={false}>{expanded && <motion.div id={panelId} role="region" aria-label={t("shares.historyRegionLabel", { file: file.name })} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="shr-link__history"><AccessHistoryPanel shareId={share.id} /></motion.div>}</AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.section>
  );
}
