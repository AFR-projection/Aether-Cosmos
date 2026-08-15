import { FileBrowser } from "@/components/files/file-browser";
import { requireAuth } from "@/lib/auth/session";
import { resolveFolderAccess } from "@/lib/auth/permissions";
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

  return (
    <FileBrowser
      folderId={folderId}
      selectedFileId={select ?? null}
      isSharedContext={true}
      sharedFolderName={access.folder.name}
    />
  );
}
