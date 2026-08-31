"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Eye, Loader2, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Badge } from "@/ui/primitives/badge";
import { Field } from "@/ui/primitives/field";
import { Modal } from "@/ui/primitives/modal";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { apiFetch } from "@/shared/api/client";
import { apiErrorMessage, useT, type TranslationKey } from "@/shared/lib/i18n";

type Member = {
  id: string;
  userId: string;
  username: string;
  role: "view" | "edit";
  createdAt: string | Date;
};

interface FolderInviteDialogProps {
  folderId: string;
  folderName: string;
  onClose: () => void;
}

/** Same wording and tones as the browser's own role badge, so a collaborator
 *  list and a shared folder header never disagree about what "edit" means. */
const ROLE = {
  view: { labelKey: "common.viewOnly", icon: Eye, tone: "warning" },
  edit: { labelKey: "common.canEdit", icon: Pencil, tone: "success" },
} as const satisfies Record<
  "view" | "edit",
  { labelKey: TranslationKey; icon: typeof Eye; tone: "warning" | "success" }
>;

type Notice = { tone: "success" | "danger"; text: string } | null;

export function FolderInviteDialog({ folderId, folderName, onClose }: FolderInviteDialogProps) {
  const t = useT();
  const [members, setMembers] = useState<Member[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  // Success and failure are different states, not one string in the error slot.
  const [notice, setNotice] = useState<Notice>(null);
  const { askConfirm, dialogs } = useDialogs();

  const load = useCallback(async () => {
    // Deliberately no `setLoading(true)` on refresh: the list starts in its
    // loading state, and reloads after an invite or a removal are covered by
    // `busy` — so the member list never blanks out under the user.
    const res = await apiFetch<{
      members: Member[];
      canManage: boolean;
    }>(`/api/folders/${folderId}/members`);
    if (!res.success || !res.data) {
      setNotice({
        tone: "danger",
        text: apiErrorMessage(res, t, "files.folderShare.loadMembersFailed"),
      });
      setLoading(false);
      return;
    }
    setMembers(res.data.members);
    setCanManage(res.data.canManage);
    setLoading(false);
  }, [folderId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setNotice(null);
    const res = await apiFetch<{ updated?: boolean }>(`/api/folders/${folderId}/members`, {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), role }),
    });
    setBusy(false);
    if (!res.success) {
      setNotice({ tone: "danger", text: apiErrorMessage(res, t, "files.folderShare.inviteFailed") });
      return;
    }
    setUsername("");
    // The route's `updated` flag rather than its English `message`: same fact,
    // said here so the confirmation follows the viewer's language.
    setNotice({
      tone: "success",
      text: t(res.data?.updated ? "files.folderShare.resent" : "files.folderShare.sent"),
    });
    await load();
  }

  async function handleRemove(member: Member) {
    const ok = await askConfirm({
      title: t("files.folderShare.removeTitle", { user: member.username }),
      message: t("files.folderShare.removeBody"),
      confirmText: t("common.remove"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const res = await apiFetch(`/api/folders/${folderId}/members`, {
      method: "DELETE",
      body: JSON.stringify({ userId: member.userId }),
    });
    setBusy(false);
    if (!res.success) {
      setNotice({ tone: "danger", text: apiErrorMessage(res, t, "files.folderShare.removeFailed") });
      return;
    }
    setNotice({
      tone: "success",
      text: t("files.folderShare.removed", { user: member.username }),
    });
    await load();
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={Users}
      title={t("files.folderShare.title")}
      description={folderName}
    >
      {canManage && (
        <form onSubmit={handleInvite} className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label={t("files.folderShare.username")} className="flex-1">
              {(field) => (
                <Input
                  {...field}
                  placeholder={t("files.folderShare.usernamePlaceholder")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label={t("files.folderShare.access")}>
              {(field) => (
                <select
                  {...field}
                  value={role}
                  onChange={(e) => setRole(e.target.value as "view" | "edit")}
                  className="h-10 rounded-xl border border-border/60 bg-surface px-2 text-sm text-foreground transition-all duration-200 focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
                >
                  <option value="view">{t("common.viewOnly")}</option>
                  <option value="edit">{t("common.canEdit")}</option>
                </select>
              )}
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={busy || !username.trim()} className="w-full">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden="true" />
            )}
            {t("files.folderShare.send")}
          </Button>
        </form>
      )}

      {notice && (
        <p
          role="status"
          className={
            notice.tone === "success"
              ? "mt-3 flex items-start gap-1.5 text-xs text-success-ink"
              : "mt-3 flex items-start gap-1.5 text-xs text-danger-ink"
          }
        >
          {notice.tone === "success" && (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span>{notice.text}</span>
        </p>
      )}

      <div className="mt-4 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("files.folderShare.peopleWithAccess")}
        </h3>
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{" "}
            {t("files.folderShare.loadingMembers")}
          </p>
        ) : members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {canManage
              ? t("files.folderShare.emptyManage")
              : t("files.folderShare.empty")}
          </p>
        ) : (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto">
            {members.map((m) => {
              const { labelKey, icon: RoleIcon, tone } = ROLE[m.role];
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 rounded-xl bg-surface-hover/50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{m.username}</p>
                    <Badge tone={tone} className="mt-1">
                      <RoleIcon className="h-3 w-3" aria-hidden="true" />
                      {t(labelKey)}
                    </Badge>
                  </div>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-danger-ink hover:bg-danger/10 hover:text-danger-ink"
                      aria-label={t("files.folderShare.removeMember", { user: m.username })}
                      disabled={busy}
                      onClick={() => void handleRemove(m)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {dialogs}
    </Modal>
  );
}
