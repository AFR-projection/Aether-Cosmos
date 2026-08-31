"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2 } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { apiFetch } from "@/shared/api/client";
import { notify } from "@/shared/lib/system/notify-store";
import { apiErrorMessage, useT } from "@/shared/lib/i18n";

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
  const t = useT();
  const { askConfirm, dialogs } = useDialogs();
  const [leaving, setLeaving] = useState(false);

  async function leave() {
    const ok = await askConfirm({
      title: t("sharedWithMe.leave.confirmTitle"),
      message: t("sharedWithMe.leave.confirmBody", { folder: folderName }),
      confirmText: t("sharedWithMe.leave.confirmAction"),
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
          title: t("sharedWithMe.leave.failed"),
          description: apiErrorMessage(res, t, "sharedWithMe.leave.failedHint"),
          tone: "error",
          duration: 5000,
        });
        return;
      }
      notify({
        title: t("sharedWithMe.leave.done"),
        description: t("sharedWithMe.leave.doneNote", { folder: folderName }),
        tone: "success",
        duration: 3500,
      });
      router.replace("/shared-with-me");
      router.refresh();
    } catch {
      notify({ title: t("errors.connectionFailed"), tone: "error", duration: 4000 });
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
        className="h-9 gap-1.5 px-2.5 text-muted-foreground hover:text-danger-ink"
        title={t("sharedWithMe.leave.action")}
        // The label collapses below `sm`, so without this the button is icon-only
        // there and a screen reader announces nothing but "button".
        aria-label={t("sharedWithMe.leave.action")}
        aria-busy={leaving}
      >
        {leaving ? (
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <LogOut aria-hidden className="h-3.5 w-3.5" />
        )}
        <span className="hidden text-xs sm:inline">
          {t(leaving ? "sharedWithMe.leave.leaving" : "sharedWithMe.leave.label")}
        </span>
      </Button>
      {dialogs}
    </>
  );
}
