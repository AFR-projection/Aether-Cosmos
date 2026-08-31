import type { File as FileRecord } from "@/shared/infrastructure/db/schema";

/** Single source of truth for how files are sorted, shared by grid + browser. */
export function getSortValue(file: FileRecord, sortBy: string): string | number {
  switch (sortBy) {
    case "name": return file.name.toLowerCase();
    case "size": return Number(file.sizeBytes);
    case "date": return new Date(file.updatedAt).getTime();
    case "type": return file.mimeType;
    default: return file.name.toLowerCase();
  }
}

export function sortFiles(
  files: FileRecord[],
  sortBy: string,
  sortOrder: "asc" | "desc"
): FileRecord[] {
  if (!files.length) return files;
  return [...files].sort((a, b) => {
    const va = getSortValue(a, sortBy);
    const vb = getSortValue(b, sortBy);
    if (typeof va === "string" && typeof vb === "string") {
      return sortOrder === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return sortOrder === "asc"
      ? (va as number) - (vb as number)
      : (vb as number) - (va as number);
  });
}
