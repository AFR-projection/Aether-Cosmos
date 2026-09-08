import { resolveFilesFilter } from "@files/domain/services/file-filter";
import { FileBrowser } from "@files/presentation/components/files/file-browser";

type FilesSearchParams = {
  folder?: string;
  select?: string;
  filter?: string | readonly string[];
};

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<FilesSearchParams>;
}) {
  const { folder, select, filter } = await searchParams;
  return (
    <FileBrowser
      folderId={folder ?? null}
      selectedFileId={select ?? null}
      filter={resolveFilesFilter(filter)}
    />
  );
}
