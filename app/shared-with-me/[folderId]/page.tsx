import { FileBrowser, type BrowserCaps } from "@/components/files/file-browser";
import { LeaveSharedFolderButton } from "@/components/folders/leave-shared-folder-button";
import { requireAuth } from "@/lib/auth/session";
import { getEffectiveUserId, resolveFolderAccess } from "@/lib/auth/permissions";
import { notFound } from "next/navigation";

export default async function SharedFolderPage({
  params,
  searchParams,
}: {
  params: Promise<{ folderId: string }>;
  searchParams: Promise<{ select?: string }>;
}) {
  const user = await requireAuth();
  const { folderId } = await params;
  const { select } = await searchParams;

  // Verify user has access to this shared folder
  const access = await resolveFolderAccess(user, folderId);
  if (!access?.canView) {
    notFound();
  }

  // The browser used to be handed no capabilities at all, so it rendered the full owner
  // toolbar to a `view` member — every button ending in a 403 that looked like a bug.
  // The server stays the authority; this only keeps the UI honest about it.
  const caps: BrowserCaps = {
    role: access.role,
    canEdit: access.canEdit,
    canOwnerOnlyFlags: access.canOwnerOnlyFlags,
    canPurge: access.canPurge,
    canManageMembers: access.canManageMembers,
  };

  return (
    <FileBrowser
      folderId={folderId}
      selectedFileId={select ?? null}
      isSharedContext={true}
      sharedFolderName={access.folder.name}
      caps={caps}
      sharedAction={
        // Only a real membership can be left; a master looking in via override has nothing
        // to give up, and the owner is not a member of their own folder.
        access.viaMembership ? (
          <LeaveSharedFolderButton
            folderId={access.shareRootId ?? folderId}
            folderName={access.folder.name}
            selfUserId={getEffectiveUserId(user)}
          />
        ) : null
      }
    />
  );
}
