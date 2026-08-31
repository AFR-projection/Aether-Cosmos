import { FileBrowser } from "@files/presentation/components/files/file-browser";

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string; select?: string }>;
}) {
  const { folder, select } = await searchParams;
  return <FileBrowser folderId={folder ?? null} selectedFileId={select ?? null} />;
}
