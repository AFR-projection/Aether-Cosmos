"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence, MotionConfig } from "framer-motion";
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
import { apiFetch } from "@/lib/api/client";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

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
 * other for the same permission.
 */
const ROLE = {
  edit: { label: "Can edit", icon: Pencil },
  view: { label: "View only", icon: Eye },
} as const;

function RoleChip({ role }: { role: "view" | "edit" }) {
  const { label, icon: Icon } = ROLE[role];
  // Icon plus word, never colour alone: the accent tint on "Can edit" is a
  // second signal, not the only one.
  return (
    <span className="shr-role" data-role={role}>
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
}

function initial(name: string) {
  return name.trim().charAt(0) || "?";
}

export default function SharedWithMePage() {
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
            <p className="shr-kicker"><span aria-hidden="true" /> Collaboration</p>
            <h1>Shared with me</h1>
            <p>
              Folders other people have given you access to. Invitations arrive here first — accept
              one and the folder joins the list below.
            </p>
          </div>

          <div className="shr-tally">
            <div className="shr-tally__item">
              <span className="shr-tally__value">{sharedQuery.isLoading ? "—" : shared.length}</span>
              <span className="shr-tally__label">Folders</span>
            </div>
            <div className="shr-tally__item" data-tone={pendingCount > 0 ? "accent" : undefined}>
              <span className="shr-tally__value">
                {invitationsQuery.isLoading ? "—" : pendingCount}
              </span>
              <span className="shr-tally__label">Pending</span>
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
                    Pending invitations
                  </h2>
                  <p className="shr-panel__sub">Accept to add the folder, decline to remove it.</p>
                </div>
                <span className="shr-count">{pendingCount}</span>
              </div>

              <div className="shr-panel__body shr-panel__body--flush">
                {respondMutation.isError && (
                  <p className="shr-note" data-tone="danger" role="alert">
                    <AlertCircle aria-hidden="true" />
                    <span>
                      {respondMutation.error instanceof Error
                        ? respondMutation.error.message
                        : "Could not respond to that invitation."}{" "}
                      Nothing changed — try again.
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
            <h2 className="shr-panel__title" id="shared-heading">Shared folders</h2>
            {!sharedQuery.isLoading && shared.length > 0 && (
              <span className="shr-count">{shared.length}</span>
            )}

            {showTools && (
              <div className="shr-panel__tools">
                <div className="shr-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Folder or owner…"
                    aria-label="Search shared folders"
                  />
                </div>
                <select
                  className="shr-select"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                  aria-label="Sort shared folders"
                >
                  <option value="recent">Recently shared</option>
                  <option value="name">Folder name</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
            )}
          </div>

          <div className="shr-panel__body">
            {sharedQuery.isLoading ? (
              <div className="shr-grid" aria-busy="true" aria-label="Loading shared folders">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton shr-skel shr-skel--card" />
                ))}
              </div>
            ) : sharedQuery.isError ? (
              <div className="shr-empty" role="alert">
                <AlertCircle aria-hidden="true" />
                <p>Could not load your shared folders</p>
                <span>The list is still there — this was a problem fetching it.</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void sharedQuery.refetch()}
                  disabled={sharedQuery.isFetching}
                >
                  <RefreshCw className={sharedQuery.isFetching ? "animate-spin" : undefined} aria-hidden="true" />
                  Try again
                </Button>
              </div>
            ) : shared.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Nothing shared with you"
                description="When a teammate shares a folder, the invitation shows up above. Accepted folders then live here."
                action={
                  <Button asChild variant="secondary">
                    <Link href="/files">Open my files</Link>
                  </Button>
                }
              />
            ) : visible.length === 0 ? (
              <div className="shr-empty">
                <Search aria-hidden="true" />
                <p>No folder matches “{query.trim()}”</p>
                <span>Try the owner’s name, or clear the search to see all {shared.length}.</span>
                <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                  <X aria-hidden="true" />
                  Clear search
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
  return (
    <li className="shr-invite">
      <span className="shr-invite__icon" aria-hidden="true"><Mail /></span>

      <div className="shr-invite__main">
        <p className="shr-invite__name" title={invitation.folderName}>
          {invitation.folderName}
        </p>
        <p className="shr-invite__meta">
          <span>
            From <strong>{invitation.invitedByUsername}</strong>
          </span>
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
          aria-label={`Accept invitation to ${invitation.folderName}`}
        >
          {acting === "accept" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          Accept
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onRespond("reject")}
          disabled={acting !== null}
          aria-label={`Decline invitation to ${invitation.folderName}`}
        >
          {acting === "reject" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <X aria-hidden="true" />
          )}
          Decline
        </Button>
      </div>
    </li>
  );
}

/** A folder someone else owns. The whole card is the link; hover only changes colour. */
function FolderCard({ item }: { item: SharedEntry }) {
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
        <span className="shr-card__who">
          <span className="sr-only">Owned by </span>
          {item.ownerUsername}
        </span>
        <span className="shr-card__when">
          <span className="sr-only">shared </span>
          {formatDate(item.sharedAt, "short")}
        </span>
      </div>
    </Link>
  );
}
