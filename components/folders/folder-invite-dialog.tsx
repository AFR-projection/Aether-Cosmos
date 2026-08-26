"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Eye, Loader2, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { apiFetch } from "@/lib/api/client";

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
  view: { label: "View only", icon: Eye, tone: "warning" },
  edit: { label: "Can edit", icon: Pencil, tone: "success" },
} as const;

type Notice = { tone: "success" | "danger"; text: string } | null;

export function FolderInviteDialog({ folderId, folderName, onClose }: FolderInviteDialogProps) {
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
      setNotice({ tone: "danger", text: res.error ?? "Failed to load members" });
      setLoading(false);
      return;
    }
    setMembers(res.data.members);
    setCanManage(res.data.canManage);
    setLoading(false);
  }, [folderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setNotice(null);
    const res = await apiFetch(`/api/folders/${folderId}/members`, {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), role }),
    });
    setBusy(false);
    if (!res.success) {
      setNotice({ tone: "danger", text: res.error ?? "Invite failed" });
      return;
    }
    setUsername("");
    const message = (res.data as { message?: string } | undefined)?.message ?? "Invitation sent";
    setNotice({ tone: "success", text: `${message} — they will get a notification.` });
    await load();
  }

  async function handleRemove(member: Member) {
    const ok = await askConfirm({
      title: `Remove ${member.username}?`,
      message: "They lose access to this folder and everything inside it.",
      confirmText: "Remove",
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
      setNotice({ tone: "danger", text: res.error ?? "Remove failed" });
      return;
    }
    setNotice({ tone: "success", text: `${member.username} no longer has access.` });
    await load();
  }

  return (
    <Modal open onClose={onClose} icon={Users} title="Share folder" description={folderName}>
      {canManage && (
        <form onSubmit={handleInvite} className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label="Username" className="flex-1">
              {(field) => (
                <Input
                  {...field}
                  placeholder="Who should get access?"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Access">
              {(field) => (
                <select
                  {...field}
                  value={role}
                  onChange={(e) => setRole(e.target.value as "view" | "edit")}
                  className="h-10 rounded-xl border border-border/60 bg-surface px-2 text-sm text-foreground transition-all duration-200 focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
                >
                  <option value="view">View only</option>
                  <option value="edit">Can edit</option>
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
            Send invitation
          </Button>
        </form>
      )}

      {notice && (
        <p
          role="status"
          className={
            notice.tone === "success"
              ? "mt-3 flex items-start gap-1.5 text-xs text-success"
              : "mt-3 flex items-start gap-1.5 text-xs text-danger"
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
          People with access
        </h3>
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading members…
          </p>
        ) : members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {canManage
              ? "Nobody else yet — invite someone by username above."
              : "Nobody else has been given access to this folder."}
          </p>
        ) : (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto">
            {members.map((m) => {
              const { label, icon: RoleIcon, tone } = ROLE[m.role];
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 rounded-xl bg-surface-hover/50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{m.username}</p>
                    <Badge tone={tone} className="mt-1">
                      <RoleIcon className="h-3 w-3" aria-hidden="true" />
                      {label}
                    </Badge>
                  </div>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                      aria-label={`Remove ${m.username}`}
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
