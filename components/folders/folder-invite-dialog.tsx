"use client";

import { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, Trash2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";

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

export function FolderInviteDialog({ folderId, folderName, onClose }: FolderInviteDialogProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<{
      members: Member[];
      canManage: boolean;
    }>(`/api/folders/${folderId}/members`);
    if (!res.success || !res.data) {
      setError(res.error ?? "Failed to load members");
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
    setError(null);
    const res = await apiFetch(`/api/folders/${folderId}/members`, {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), role }),
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error ?? "Invite failed");
      return;
    }
    setUsername("");
    setError(null);
    // Show success message
    const successMsg = (res.data as { message?: string } | undefined)?.message ?? "Invitation sent";
    setError(`✓ ${successMsg} — User will receive notification`);
    setTimeout(() => setError(null), 3000);
    await load();
  }

  async function handleRemove(userId: string) {
    if (!confirm("Remove this member?")) return;
    setBusy(true);
    const res = await apiFetch(`/api/folders/${folderId}/members`, {
      method: "DELETE",
      body: JSON.stringify({ userId }),
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error ?? "Remove failed");
      return;
    }
    await load();
  }

  return (
    <div
      className="scrim fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Users className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold">Share folder</h3>
            </div>
            <p className="text-xs text-muted-foreground">{folderName}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {canManage && (
          <form onSubmit={handleInvite} className="mb-4 space-y-2">
            <div className="flex gap-2">
              <Input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="flex-1"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "view" | "edit")}
                className="rounded-lg border border-border bg-background px-2 text-sm"
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
              </select>
            </div>
            <Button type="submit" disabled={busy || !username.trim()} className="w-full">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
              Invite
            </Button>
          </form>
        )}

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading members…
          </div>
        ) : (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto">
            {members.length === 0 && (
              <li className="text-xs text-muted-foreground/70">No collaborators yet.</li>
            )}
            {members.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "flex items-center justify-between rounded-lg bg-surface-hover/40 px-3 py-2"
                )}
              >
                <div>
                  <p className="text-sm font-medium">{m.username}</p>
                  <p className="text-xs capitalize text-muted-foreground">{m.role}</p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-danger"
                    disabled={busy}
                    onClick={() => handleRemove(m.userId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
