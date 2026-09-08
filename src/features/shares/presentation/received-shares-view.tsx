"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Eye,
  Folder,
  FolderOpen,
  Inbox,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useFormat, useT, type TranslationKey } from "@/shared/lib/i18n";
import { Button } from "@/ui/primitives/button";
import { EmptyState } from "@/ui/primitives/empty-state";
import type { Invitation, SharedEntry } from "./sharing-types";

export type InvitationAction = "accept" | "reject";
export type InvitationResponse = { invitationId: string; action: InvitationAction };

type SortKey = "recent" | "name" | "owner";

const ROLE = {
  edit: { labelKey: "common.canEdit", icon: Pencil },
  view: { labelKey: "common.viewOnly", icon: Eye },
} as const satisfies Record<"edit" | "view", { labelKey: TranslationKey; icon: LucideIcon }>;

function RoleChip({ role }: { role: "view" | "edit" }) {
  const t = useT();
  const { labelKey, icon: Icon } = ROLE[role];
  return (
    <span className="shr-role" data-role={role}>
      <Icon aria-hidden="true" />
      {t(labelKey)}
    </span>
  );
}

function initial(name: string) {
  return name.trim().charAt(0) || "?";
}

export function ReceivedSharesView({
  invitationsQuery,
  sharedQuery,
  busy,
  responseError,
  onRespond,
}: {
  invitationsQuery: UseQueryResult<{ invitations: Invitation[] }, Error>;
  sharedQuery: UseQueryResult<{ shared: SharedEntry[] }, Error>;
  busy?: InvitationResponse;
  responseError?: Error | null;
  onRespond: (response: InvitationResponse) => void;
}) {
  const t = useT();
  const { formatNumber } = useFormat();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const invitations = useMemo(
    () => invitationsQuery.data?.invitations ?? [],
    [invitationsQuery.data]
  );
  const shared = useMemo(() => sharedQuery.data?.shared ?? [], [sharedQuery.data]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = needle
      ? shared.filter(
          (item) =>
            item.folderName.toLowerCase().includes(needle) ||
            item.ownerUsername.toLowerCase().includes(needle)
        )
      : [...shared];
    if (sort === "name") return rows.sort((a, b) => a.folderName.localeCompare(b.folderName));
    if (sort === "owner") return rows.sort((a, b) => a.ownerUsername.localeCompare(b.ownerUsername));
    return rows.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
  }, [shared, query, sort]);

  const showTools = shared.length > 3;

  return (
    <div className="shr-view" aria-busy={invitationsQuery.isFetching || sharedQuery.isFetching}>
      {invitationsQuery.isError && (
        <div className="shr-note shr-note--retry" data-tone="danger" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{t("sharedWithMe.invitationLoadError")}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void invitationsQuery.refetch()}
            disabled={invitationsQuery.isFetching}
          >
            <RefreshCw className={invitationsQuery.isFetching ? "animate-spin" : undefined} aria-hidden="true" />
            {t("errorPages.tryAgain")}
          </Button>
        </div>
      )}

      <AnimatePresence initial={false}>
        {invitations.length > 0 && (
          <motion.section
            key="invitations"
            className="shr-panel shr-panel--action"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            aria-labelledby="invitations-heading"
          >
            <div className="shr-panel__head">
              <span className="shr-panel__icon" aria-hidden="true"><Mail /></span>
              <div>
                <h2 className="shr-panel__title" id="invitations-heading">{t("sharedWithMe.pendingTitle")}</h2>
                <p className="shr-panel__sub">{t("sharedWithMe.pendingSub")}</p>
              </div>
              <span className="shr-count">{formatNumber(invitations.length)}</span>
            </div>
            <div className="shr-panel__body shr-panel__body--flush">
              {responseError && (
                <p className="shr-note" data-tone="danger" role="alert">
                  <AlertCircle aria-hidden="true" />
                  <span>{t("sharedWithMe.respondError", { reason: responseError.message || t("sharedWithMe.respondFailed") })}</span>
                </p>
              )}
              <ul className="list-none p-0 m-0">
                {invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    acting={busy?.invitationId === invitation.id ? busy.action : null}
                    onRespond={(action) => onRespond({ invitationId: invitation.id, action })}
                  />
                ))}
              </ul>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <motion.section
        className="shr-panel"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        aria-labelledby="shared-heading"
      >
        <div className="shr-panel__head">
          <span className="shr-panel__icon" aria-hidden="true"><FolderOpen /></span>
          <div>
            <h2 className="shr-panel__title" id="shared-heading">{t("sharedWithMe.sharedFolders")}</h2>
            <p className="shr-panel__sub">{t("sharedWithMe.sharedFoldersSub")}</p>
          </div>
          {!sharedQuery.isLoading && shared.length > 0 && <span className="shr-count">{formatNumber(shared.length)}</span>}
          {showTools && (
            <div className="shr-panel__tools">
              <div className="shr-search">
                <Search aria-hidden="true" />
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("sharedWithMe.searchPlaceholder")} aria-label={t("sharedWithMe.searchLabel")} />
              </div>
              <select className="shr-select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label={t("sharedWithMe.sortLabel")}>
                <option value="recent">{t("sharedWithMe.sortRecent")}</option>
                <option value="name">{t("sharedWithMe.sortName")}</option>
                <option value="owner">{t("sharedWithMe.sortOwner")}</option>
              </select>
            </div>
          )}
        </div>
        <div className="shr-panel__body">
          {sharedQuery.isLoading ? (
            <div className="shr-grid" aria-busy="true" aria-label={t("sharedWithMe.loadingFolders")}>
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton shr-skel shr-skel--card" />)}
            </div>
          ) : sharedQuery.isError ? (
            <div className="shr-empty" role="alert">
              <AlertCircle aria-hidden="true" />
              <p>{t("sharedWithMe.loadError")}</p>
              <span>{t("sharedWithMe.loadErrorHint")}</span>
              <Button variant="secondary" size="sm" onClick={() => void sharedQuery.refetch()} disabled={sharedQuery.isFetching}>
                <RefreshCw className={sharedQuery.isFetching ? "animate-spin" : undefined} aria-hidden="true" />
                {t("errorPages.tryAgain")}
              </Button>
            </div>
          ) : shared.length === 0 ? (
            <EmptyState icon={Inbox} title={t("sharedWithMe.emptyTitle")} description={t("sharedWithMe.emptyBody")} action={<Button asChild variant="secondary"><Link href="/files">{t("sharedWithMe.openMyFiles")}</Link></Button>} />
          ) : visible.length === 0 ? (
            <div className="shr-empty">
              <Search aria-hidden="true" />
              <p>{t("sharedWithMe.noMatch", { query: query.trim() })}</p>
              <span>{t("sharedWithMe.noMatchHint", { count: formatNumber(shared.length) })}</span>
              <Button variant="secondary" size="sm" onClick={() => setQuery("")}><X aria-hidden="true" />{t("sharedWithMe.clearSearch")}</Button>
            </div>
          ) : (
            <div className="shr-grid">{visible.map((item) => <FolderCard key={item.memberId} item={item} />)}</div>
          )}
        </div>
      </motion.section>
    </div>
  );
}

function InvitationRow({ invitation, acting, onRespond }: { invitation: Invitation; acting: InvitationAction | null; onRespond: (action: InvitationAction) => void }) {
  const t = useT();
  const { formatDate } = useFormat();
  return (
    <li className="shr-invite" aria-busy={acting !== null}>
      <span className="shr-invite__icon" aria-hidden="true"><Mail /></span>
      <div className="shr-invite__main">
        <p className="shr-invite__name" title={invitation.folderName}>{invitation.folderName}</p>
        <p className="shr-invite__meta"><span>{t("sharedWithMe.from", { user: invitation.invitedByUsername })}</span><span aria-hidden="true">·</span><span>{formatDate(invitation.createdAt, "short")}</span></p>
      </div>
      <RoleChip role={invitation.role} />
      <div className="shr-invite__actions">
        <Button size="sm" onClick={() => onRespond("accept")} disabled={acting !== null} aria-label={t("sharedWithMe.acceptLabel", { folder: invitation.folderName })}>
          {acting === "accept" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{t("sharedWithMe.accept")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onRespond("reject")} disabled={acting !== null} aria-label={t("sharedWithMe.declineLabel", { folder: invitation.folderName })}>
          {acting === "reject" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <X aria-hidden="true" />}{t("sharedWithMe.decline")}
        </Button>
      </div>
    </li>
  );
}

function FolderCard({ item }: { item: SharedEntry }) {
  const t = useT();
  const { formatDate } = useFormat();
  return (
    <Link href={`/shared-with-me/${item.folderId}`} className="shr-card">
      <div className="shr-card__top">
        <span className="shr-card__icon" aria-hidden="true"><Folder /></span>
        <div className="min-w-0 flex-1"><p className="shr-card__name" title={item.folderName}>{item.folderName}</p><div className="mt-1.5"><RoleChip role={item.role} /></div></div>
        <ArrowUpRight className="shr-card__go" aria-hidden="true" />
      </div>
      <div className="shr-card__meta">
        <span className="shr-card__owner" aria-hidden="true">{initial(item.ownerUsername)}</span>
        <span className="shr-card__who"><span className="sr-only">{t("sharedWithMe.ownedBy")} </span>{item.ownerUsername}</span>
        <span className="shr-card__when"><span className="sr-only">{t("sharedWithMe.sharedOn")} </span>{formatDate(item.sharedAt, "short")}</span>
      </div>
    </Link>
  );
}
