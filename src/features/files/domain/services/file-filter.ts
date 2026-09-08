export const FILES_FAVORITES_HREF = "/files?filter=favorites";

export const FILE_FILTERS = [
  "all",
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "favorites",
] as const;

export type FileFilter = (typeof FILE_FILTERS)[number];

export function buildFilesFilterHref(filter: FileFilter): string {
  return filter === "all" ? "/files" : `/files?filter=${filter}`;
}

const FILTER_MIME_MAP: Partial<Record<FileFilter, readonly string[]>> = {
  image: ["image/"],
  video: ["video/"],
  audio: ["audio/"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument",
    "text/",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
  ],
  archive: [
    "application/zip",
    "application/x-rar",
    "application/x-7z",
    "application/gzip",
    "application/x-tar",
  ],
};

export function resolveFilesFilter(
  value: string | readonly string[] | null | undefined
): FileFilter {
  return typeof value === "string" && FILE_FILTERS.includes(value as FileFilter)
    ? (value as FileFilter)
    : "all";
}

export function matchesFileFilter(
  file: { mimeType: string; isFavorite: boolean },
  filter: FileFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "favorites") return file.isFavorite;
  return (FILTER_MIME_MAP[filter] ?? []).some((prefix) =>
    file.mimeType.startsWith(prefix)
  );
}
