import type { FileFilter } from "./file-filter";

type FilesListRequest = {
  filter: FileFilter;
  folderId: string | null;
  search: string;
  limit: number;
  cursor?: string | null;
  page?: number | null;
  trash?: boolean;
};

export function buildFilesListRequest({
  filter,
  folderId,
  search,
  limit,
  cursor,
  page,
  trash = false,
}: FilesListRequest): string {
  const params = new URLSearchParams();
  const trimmedSearch = search.trim();

  if (trimmedSearch) params.set("q", trimmedSearch);
  params.set("limit", String(limit));
  if (folderId) params.set("folderId", folderId);
  if (filter === "favorites") params.set("favorites", "true");

  if (trimmedSearch) {
    if (page !== undefined && page !== null) params.set("page", String(page));
    return `/api/search?${params}`;
  }

  if (cursor) params.set("cursor", cursor);
  if (trash) params.set("trash", "true");
  return `/api/files?${params}`;
}
