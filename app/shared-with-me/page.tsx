"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
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
import { apiFetch } from "@/shared/api/client";
import { useFormat, useT, type TranslationKey } from "@/shared/lib/i18n";
import { Button } from "@/ui/primitives/button";
import { EmptyState } from "@/ui/primitives/empty-state";

interface Invitation {
  id: string;
  folderId: string;
  folderName: string;
  role: "view" | "edit";
  invitedByUsername: string;
  createdAt: string;
}

interface SharedEntry {
  memberId: string;
  role: "view" | "edit";
  sharedAt: string;
  folderId: string;
  folderName: string;
  folderCreatedAt: string;
  ownerId: string;
  ownerUsername: string;
}

type SortKey = "recent" | "name" | "owner";

/**
 * One wording for each access level, used by both the invitation rows and the
 * folder cards — the old page said "Edit" in one place and "Can Edit" in the
 * other for the same permission. The words live in `common` so every
 * folder-permission surface reads the same in every locale.
 */
const ROLE = {
  edit: { labelKey: "common.canEdit", icon: Pencil },
  view: { labelKey: "common.viewOnly", icon: Eye },
} as const satisfies Record<"edit" | "view", { labelKey: TranslationKey; icon: LucideIcon }>;

function RoleChip({ role }: { role: "view" | "edit" }) {
  const t = useT();
  const { labelKey, icon: Icon } = ROLE[role];
  // Icon plus word, never colour alone: the accent tint on "Can edit" is a
  // second signal, not the only one.
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

export default function SharedWithMePage() {
  const t = useT();
  const { formatNumber } = useFormat();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");

  const invitationsQuery = useQuery({
    queryKey: ["invitations"],
    queryFn: async () => {
      const res = await apiFetch<{ invitations: Invitation[] }>("/api/invitations");
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load");
      return res.data;
    },
  });

  const sharedQuery = useQuery({
    queryKey: ["shared-with-me"],
    queryFn: async () => {
      const res = await apiFetch<{ shared: SharedEntry[] }>("/api/shared-with-me");
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load");
      return res.data;
    },
  });

  const respondMutation = useMutation({
    mutationFn: async ({ invitationId, action }: { invitationId: string; action: "accept" | "reject" }) => {
      const res = await apiFetch("/api/invitations", {
        method: "POST",
        body: JSON.stringify({ invitationId, action }),
      });
      if (!res.success) throw new Error(res.error ?? "Failed to respond");
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      queryClient.invalidateQueries({ queryKey: ["shared-with-me"] });
    },
  });

  // Memoised rather than derived inline: the filtered list below takes these as
  // dependencies, and a fresh array on every render defeats that memo (the
  // React Compiler lint treats it as a hard error, not a warning).
  const invitations = useMemo(() => invitationsQuery.data?.invitations ?? [], [invitationsQuery.data]);
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
    // Newest first — the API returns oldest first, which buries a folder that
    // was just accepted at the bottom of the grid.
    return rows.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
  }, [shared, query, sort]);

  const pendingCount = invitations.length;
  // The mutation is shared by every row, so the row being answered is read off
  // the in-flight variables instead of disabling the whole list.
  const busy = respondMutation.isPending ? respondMutation.variables : undefined;
  const showTools = shared.length > 3;

  return (
    <MotionConfig reducedMotion="user">
      <div className="shr-page">
        <header className="shr-header">
          <div className="shr-header__copy">
            <p className="shr-kicker"><span aria-hidden="true" /> {t("sharedWithMe.kicker")}</p>
            <h1>{t("sharedWithMe.title")}</h1>
            <p>{t("sharedWithMe.intro")}</p>
          </div>

          <div className="shr-tally">
            <div className="shr-tally__item">
              <span className="shr-tally__value">
                {sharedQuery.isLoading ? "—" : formatNumber(shared.length)}
              </span>
              <span className="shr-tally__label">{t("sharedWithMe.tallyFolders")}</span>
            </div>
            <div className="shr-tally__item" data-tone={pendingCount > 0 ? "accent" : undefined}>
              <span className="shr-tally__value">
                {invitationsQuery.isLoading ? "—" : formatNumber(pendingCount)}
              </span>
              <span className="shr-tally__label">{t("sharedWithMe.tallyPending")}</span>
            </div>
          </div>
        </header>

        {/* Only mounted when something is actually waiting — an "all caught up"
            panel would take permanent space to say nothing. */}
        <AnimatePresence initial={false}>
          {pendingCount > 0 && (
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
                  <h2 className="shr-panel__title" id="invitations-heading">
                    {t("sharedWithMe.pendingTitle")}
                  </h2>
                  <p className="shr-panel__sub">{t("sharedWithMe.pendingSub")}</p>
                </div>
                <span className="shr-count">{formatNumber(pendingCount)}</span>
              </div>

              <div className="shr-panel__body shr-panel__body--flush">
                {respondMutation.isError && (
                  <p className="shr-note" data-tone="danger" role="alert">
                    <AlertCircle aria-hidden="true" />
                    <span>
                      {t("sharedWithMe.respondError", {
                        reason:
                          respondMutation.error instanceof Error
                            ? respondMutation.error.message
                            : t("sharedWithMe.respondFailed"),
                      })}
                    </span>
                  </p>
                )}
                <ul className="list-none p-0 m-0">
                  {invitations.map((inv) => (
                    <InvitationRow
                      key={inv.id}
                      invitation={inv}
                      acting={busy?.invitationId === inv.id ? busy.action : null}
                      onRespond={(action) =>
                        respondMutation.mutate({ invitationId: inv.id, action })
                      }
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
            <h2 className="shr-panel__title" id="shared-heading">{t("sharedWithMe.sharedFolders")}</h2>
            {!sharedQuery.isLoading && shared.length > 0 && (
              <span className="shr-count">{formatNumber(shared.length)}</span>
            )}

            {showTools && (
              <div className="shr-panel__tools">
                <div className="shr-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("sharedWithMe.searchPlaceholder")}
                    aria-label={t("sharedWithMe.searchLabel")}
                  />
                </div>
                <select
                  className="shr-select"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                  aria-label={t("sharedWithMe.sortLabel")}
                >
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
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton shr-skel shr-skel--card" />
                ))}
              </div>
            ) : sharedQuery.isError ? (
              <div className="shr-empty" role="alert">
                <AlertCircle aria-hidden="true" />
                <p>{t("sharedWithMe.loadError")}</p>
                <span>{t("sharedWithMe.loadErrorHint")}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void sharedQuery.refetch()}
                  disabled={sharedQuery.isFetching}
                >
                  <RefreshCw className={sharedQuery.isFetching ? "animate-spin" : undefined} aria-hidden="true" />
                  {t("errorPages.tryAgain")}
                </Button>
              </div>
            ) : shared.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={t("sharedWithMe.emptyTitle")}
                description={t("sharedWithMe.emptyBody")}
                action={
                  <Button asChild variant="secondary">
                    <Link href="/files">{t("sharedWithMe.openMyFiles")}</Link>
                  </Button>
                }
              />
            ) : visible.length === 0 ? (
              <div className="shr-empty">
                <Search aria-hidden="true" />
                <p>{t("sharedWithMe.noMatch", { query: query.trim() })}</p>
                <span>{t("sharedWithMe.noMatchHint", { count: formatNumber(shared.length) })}</span>
                <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                  <X aria-hidden="true" />
                  {t("sharedWithMe.clearSearch")}
                </Button>
              </div>
            ) : (
              <div className="shr-grid">
                {visible.map((item) => (
                  <FolderCard key={item.memberId} item={item} />
                ))}
              </div>
            )}
          </div>
        </motion.section>
      </div>
    </MotionConfig>
  );
}

/**
 * One pending invitation. Both answers are on the row rather than behind a menu
 * or a popover — responding is the reason this page exists. Only the row being
 * answered goes busy, so a slow accept never freezes the others.
 */
function InvitationRow({
  invitation,
  acting,
  onRespond,
}: {
  invitation: Invitation;
  acting: "accept" | "reject" | null;
  onRespond: (action: "accept" | "reject") => void;
}) {
  const t = useT();
  const { formatDate } = useFormat();
  return (
    <li className="shr-invite">
      <span className="shr-invite__icon" aria-hidden="true"><Mail /></span>

      <div className="shr-invite__main">
        <p className="shr-invite__name" title={invitation.folderName}>
          {invitation.folderName}
        </p>
        <p className="shr-invite__meta">
          {/* The inviter's name is no longer bolded inside the sentence: the
              emphasis span cannot survive a clause that reorders in id/zh-CN. */}
          <span>{t("sharedWithMe.from", { user: invitation.invitedByUsername })}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDate(invitation.createdAt, "short")}</span>
        </p>
      </div>

      <RoleChip role={invitation.role} />

      <div className="shr-invite__actions">
        <Button
          size="sm"
          onClick={() => onRespond("accept")}
          disabled={acting !== null}
          aria-label={t("sharedWithMe.acceptLabel", { folder: invitation.folderName })}
        >
          {acting === "accept" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {t("sharedWithMe.accept")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onRespond("reject")}
          disabled={acting !== null}
          aria-label={t("sharedWithMe.declineLabel", { folder: invitation.folderName })}
        >
          {acting === "reject" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <X aria-hidden="true" />
          )}
          {t("sharedWithMe.decline")}
        </Button>
      </div>
    </li>
  );
}

/** A folder someone else owns. The whole card is the link; hover only changes colour. */
function FolderCard({ item }: { item: SharedEntry }) {
  const t = useT();
  const { formatDate } = useFormat();
  return (
    <Link href={`/shared-with-me/${item.folderId}`} className="shr-card">
      <div className="shr-card__top">
        <span className="shr-card__icon" aria-hidden="true"><Folder /></span>
        <div className="min-w-0 flex-1">
          <p className="shr-card__name" title={item.folderName}>{item.folderName}</p>
          <div className="mt-1.5">
            <RoleChip role={item.role} />
          </div>
        </div>
        <ArrowUpRight className="shr-card__go" aria-hidden="true" />
      </div>

      <div className="shr-card__meta">
        <span className="shr-card__owner" aria-hidden="true">{initial(item.ownerUsername)}</span>
        {/* The separating space stays in JSX rather than inside the dictionary
            value, where a trailing space is invisible and easily lost. */}
        <span className="shr-card__who">
          <span className="sr-only">{t("sharedWithMe.ownedBy")} </span>
          {item.ownerUsername}
        </span>
        <span className="shr-card__when">
          <span className="sr-only">{t("sharedWithMe.sharedOn")} </span>
          {formatDate(item.sharedAt, "short")}
        </span>
      </div>
    </Link>
  );
}
