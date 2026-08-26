"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { apiFetch } from "@/lib/api/client";
import { notify } from "@/lib/system/notify-store";

/**
 * A member's counterpart to "delete this folder".
 *
 * Deleting a folder someone shared with you would delete it from the OWNER's account — that
 * is the data loss this whole permission model exists to prevent — so a member gets this
 * instead: drop your own membership row, the folder disappears from your list, the owner's
 * files are untouched. Wired to `DELETE /api/folders/[id]/members` with the caller's own id,
 * which the route allows without `canManageMembers` precisely for this case.
 */
export function LeaveSharedFolderButton({
  folderId,
  folderName,
  selfUserId,
}: {
  folderId: string;
  folderName: string;
  selfUserId: string;
}) {
  const router = useRouter();
  const { askConfirm, dialogs } = useDialogs();
  const [leaving, setLeaving] = useState(false);

  async function leave() {
    const ok = await askConfirm({
      title: "Leave shared folder?",
      message: `"${folderName}" will disappear from your list. The owner's files aren't deleted, and you can be invited again later.`,
      confirmText: "Leave folder",
      danger: true,
    });
    if (!ok) return;

    setLeaving(true);
    try {
      const res = await apiFetch(`/api/folders/${folderId}/members`, {
        method: "DELETE",
        body: JSON.stringify({ userId: selfUserId }),
      });
      if (!res.success) {
        notify({
          title: "Couldn't leave the folder",
          description: res.error ?? "Please try again in a moment.",
          tone: "error",
          duration: 5000,
        });
        return;
      }
      notify({
        title: "Left the folder",
        description: `${folderName} is no longer in your list.`,
        tone: "success",
        duration: 3500,
      });
      router.replace("/shared-with-me");
      router.refresh();
    } catch {
      notify({ title: "Connection failed", tone: "error", duration: 4000 });
    } finally {
      setLeaving(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void leave()}
        disabled={leaving}
        className="h-9 gap-1.5 px-2.5 text-muted-foreground hover:text-danger"
        title="Leave shared folder"
        // The label collapses below `sm`, so without this the button is icon-only
        // there and a screen reader announces nothing but "button".
        aria-label="Leave shared folder"
        aria-busy={leaving}
      >
        {leaving ? (
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <LogOut aria-hidden className="h-3.5 w-3.5" />
        )}
        <span className="hidden text-xs sm:inline">{leaving ? "Leaving…" : "Leave"}</span>
      </Button>
      {dialogs}
    </>
  );
}
