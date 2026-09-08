"use client";

import React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, MotionConfig } from "framer-motion";
import { FolderOpen, Link2, Mail, Share2, type LucideIcon } from "lucide-react";
import {
  SHARING_LINKS_HREF,
  SHARING_RECEIVED_HREF,
  type SharingView,
} from "@shares/domain/sharing-view";
import { isPublicLinkActive } from "@shares/domain/public-link-status";
import { apiFetch } from "@/shared/api/client";
import { useFormat, useT } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { PublicLinksView } from "./public-links-view";
import {
  ReceivedSharesView,
  type InvitationResponse,
} from "./received-shares-view";
import type { Invitation, ShareEntry, SharedEntry } from "./sharing-types";

async function fetchInvitations() {
  const result = await apiFetch<{ invitations: Invitation[] }>("/api/invitations");
  if (!result.success || !result.data) {
    throw new Error(result.error ?? "Failed to load invitations");
  }
  return result.data;
}

async function fetchSharedFolders() {
  const result = await apiFetch<{ shared: SharedEntry[] }>("/api/shared-with-me");
  if (!result.success || !result.data) {
    throw new Error(result.error ?? "Failed to load shared folders");
  }
  return result.data;
}

async function fetchPublicLinks() {
  const result = await apiFetch<{ shares: ShareEntry[] }>("/api/shares");
  if (!result.success || !result.data) {
    throw new Error(result.error ?? "Failed to load public links");
  }
  return result.data.shares;
}

export function SharingHub({ initialView }: { initialView: SharingView }) {
  const t = useT();
  const { formatNumber } = useFormat();
  const queryClient = useQueryClient();
  const { askConfirm, dialogs } = useDialogs();
  const invitationsQuery = useQuery({ queryKey: ["invitations"], queryFn: fetchInvitations });
  const sharedQuery = useQuery({ queryKey: ["shared-with-me"], queryFn: fetchSharedFolders });
  const sharesQuery = useQuery({ queryKey: ["shares"], queryFn: fetchPublicLinks });
  const [expandedShareId, setExpandedShareId] = React.useState<string | null>(null);

  const invitationMutation = useMutation({
    mutationFn: async (response: InvitationResponse) => {
      const result = await apiFetch<{ message: string }>("/api/invitations", {
        method: "POST",
        body: JSON.stringify(response),
      });
      if (!result.success) throw new Error(result.error ?? t("sharedWithMe.respondFailed"));
      return response;
    },
    onSuccess: async (response) => {
      notify({
        title: response.action === "accept" ? t("sharing.invitationAccepted") : t("sharing.invitationDeclined"),
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["invitations"] }),
        queryClient.invalidateQueries({ queryKey: ["shared-with-me"] }),
      ]);
    },
    onError: (error) => {
      notify({ title: t("sharedWithMe.respondFailed"), description: error.message, tone: "error" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (entry: ShareEntry) => {
      const result = await apiFetch("/api/shares", {
        method: "DELETE",
        body: JSON.stringify({ id: entry.share.id }),
      });
      if (!result.success) throw new Error(result.error ?? t("shares.deleteFailed"));
      return entry;
    },
    onSuccess: async (entry) => {
      if (expandedShareId === entry.share.id) setExpandedShareId(null);
      notify({ title: t("shares.deleted"), tone: "success" });
      await queryClient.invalidateQueries({ queryKey: ["shares"] });
    },
    onError: (error) => {
      notify({ title: t("shares.deleteFailed"), description: error.message, tone: "error" });
    },
  });

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/shared/${token}`);
      notify({ title: t("shares.linkCopied"), tone: "success" });
    } catch {
      notify({ title: t("shares.copyFailed"), tone: "error" });
    }
  }

  async function requestRevoke(entry: ShareEntry) {
    const confirmed = await askConfirm({
      title: t("shares.revokeConfirmTitle"),
      message: t("shares.revokeConfirmBody", { file: entry.file.name }),
      confirmText: t("shares.revoke"),
      danger: true,
    });
    if (confirmed) revokeMutation.mutate(entry);
  }

  const acceptedValue = sharedQuery.isSuccess
    ? formatNumber(sharedQuery.data.shared.length)
    : "—";
  const pendingValue = invitationsQuery.isSuccess
    ? formatNumber(invitationsQuery.data.invitations.length)
    : "—";
  const activeValue = sharesQuery.isSuccess
    ? formatNumber(sharesQuery.data.filter((entry) => isPublicLinkActive(entry.share)).length)
    : "—";
  const busyInvitation = invitationMutation.isPending ? invitationMutation.variables : undefined;
  const revokingShareId = revokeMutation.isPending ? revokeMutation.variables.share.id : null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="shr-shell">
        <motion.header className="shr-hero" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
          <div className="shr-hero__copy">
            <p className="shr-kicker"><Share2 aria-hidden="true" />{t("sharing.kicker")}</p>
            <h1>{t("sharing.title")}</h1>
            <p>{t("sharing.intro")}</p>
          </div>
          <nav className="shr-switcher" aria-label={t("sharing.viewLabel")}>
            <Link href={SHARING_RECEIVED_HREF} aria-current={initialView === "received" ? "page" : undefined} data-active={initialView === "received" || undefined}><FolderOpen aria-hidden="true" />{t("sharing.receivedView")}</Link>
            <Link href={SHARING_LINKS_HREF} aria-current={initialView === "links" ? "page" : undefined} data-active={initialView === "links" || undefined}><Link2 aria-hidden="true" />{t("sharing.linksView")}</Link>
          </nav>
        </motion.header>

        <section className="shr-summary" aria-label={t("sharing.summaryLabel")}>
          <SummaryTile icon={FolderOpen} label={t("sharing.acceptedFolders")} value={acceptedValue} busy={sharedQuery.isLoading} />
          <SummaryTile icon={Mail} label={t("sharing.pendingInvitations")} value={pendingValue} busy={invitationsQuery.isLoading} />
          <SummaryTile icon={Link2} label={t("sharing.activeLinks")} value={activeValue} busy={sharesQuery.isLoading} />
        </section>

        {initialView === "received" ? (
          <ReceivedSharesView
            invitationsQuery={invitationsQuery}
            sharedQuery={sharedQuery}
            busy={busyInvitation}
            responseError={invitationMutation.error}
            onRespond={(response) => invitationMutation.mutate(response)}
          />
        ) : (
          <PublicLinksView
            sharesQuery={sharesQuery}
            expandedShareId={expandedShareId}
            revokingShareId={revokingShareId}
            onCopy={(token) => void copyLink(token)}
            onToggleHistory={(shareId) => setExpandedShareId((current) => current === shareId ? null : shareId)}
            onRevoke={(entry) => void requestRevoke(entry)}
          />
        )}
        {dialogs}
      </div>
    </MotionConfig>
  );
}

function SummaryTile({ icon: Icon, label, value, busy }: { icon: LucideIcon; label: string; value: string; busy: boolean }) {
  return (
    <div className="shr-summary__tile" aria-busy={busy}>
      <span className="shr-summary__icon" aria-hidden="true"><Icon /></span>
      <span className="shr-summary__text"><strong>{value}</strong><span>{label}</span></span>
    </div>
  );
}
