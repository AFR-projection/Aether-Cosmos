/**
 * Turning a dropped/picked directory into a folder tree on the server.
 *
 * Uploading a real project used to arrive flat: every file landed in one folder and
 * the nested structure was gone, even though the upload "succeeded". Three separate
 * causes, all fixed by using this module from a single place:
 *
 *  1. `POST /api/folders/batch` accepts a bounded number of paths per call, and the
 *     client sent the whole tree in ONE request. This repository alone has 1,193
 *     directories without `node_modules`, so the request was rejected outright.
 *  2. `apiFetch` resolves — it does not throw — on a 4xx. The rejection above was
 *     read as "no folders came back", every file fell through to the `?? rootId`
 *     fallback, and the flattening was silent.
 *  3. The drag-and-drop path never told the server which folder it was dropping
 *     into, so a tree dropped inside a folder was created at the account root.
 *
 * Everything here is pure: paths in, paths out. The network call lives in the
 * caller so this can be tested without a DOM or a server.
 */

/** Batch size per `POST /api/folders/batch` call. Must stay ≤ the route's own cap. */
export const FOLDER_BATCH_SIZE = 500;

export type UploadEntry = { file: File; relativePath: string };

/** Normalize one upload path: `\` → `/`, no leading/trailing or doubled slashes. */
export function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

/**
 * Every directory path implied by a set of file paths, parents before children.
 *
 * `a/b/c.ts` implies `a` and `a/b` — both are returned, because the server creates
 * a chain per path and the caller needs a map entry for each level it may reference.
 * Shallow-first ordering keeps a chunked upload sane to reason about: a parent is
 * always requested no later than its children.
 */
export function collectFolderPaths(relativePaths: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of relativePaths) {
    const parts = normalizeRelativePath(raw).split("/").filter(Boolean);
    // The last segment is the file itself.
    for (let i = 1; i < parts.length; i++) {
      seen.add(parts.slice(0, i).join("/"));
    }
  }
  return [...seen].sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    return depthA === depthB ? a.localeCompare(b) : depthA - depthB;
  });
}

/** Split a list into fixed-size chunks, preserving order. */
export function chunkPaths(paths: string[], size: number = FOLDER_BATCH_SIZE): string[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    chunks.push(paths.slice(i, i + size));
  }
  return chunks;
}

/**
 * The directory part of a file path, or `""` for a file at the top level.
 * Used to look the file's destination up in the map returned by the batch API.
 */
export function parentPathOf(relativePath: string): string {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

/**
 * Attach a destination folder id to every file.
 *
 * A file whose directory is missing from the map is a bug, not something to paper
 * over: the previous `?? rootId` fallback is exactly how a nested project became a
 * flat pile. Callers get the list of unresolved paths and can refuse the upload.
 */
export function resolveFileFolderIds(
  entries: UploadEntry[],
  folderIds: Map<string, string>,
  rootFolderId: string | null
): {
  items: { file: File; relativePath: string; folderId: string | null }[];
  unresolved: string[];
} {
  const items: { file: File; relativePath: string; folderId: string | null }[] = [];
  const unresolved: string[] = [];

  for (const entry of entries) {
    const relativePath = normalizeRelativePath(entry.relativePath);
    const parent = parentPathOf(relativePath);
    if (parent === "") {
      items.push({ file: entry.file, relativePath, folderId: rootFolderId });
      continue;
    }
    const folderId = folderIds.get(parent);
    if (!folderId) {
      unresolved.push(parent);
      continue;
    }
    items.push({ file: entry.file, relativePath, folderId });
  }

  return { items, unresolved: [...new Set(unresolved)] };
}

/**
 * `webkitdirectory` reports paths that already start with the chosen directory's
 * name (`myproject/src/index.ts`), while `showDirectoryPicker` hands the name over
 * separately and reports paths relative to it. Feeding the first kind into the
 * second kind's code path created `Upload 2026-08-26 14.02/myproject/...` — a
 * timestamp folder wrapping the real one, because the code believed the name was
 * unavailable. It is available: it is the first segment.
 *
 * Returns the common root name plus the paths with that segment removed. When the
 * entries do not share a single root (a multi-select, or a browser that reports no
 * relative path at all), `rootName` is null and paths are left untouched.
 */
export function splitCommonRoot(entries: UploadEntry[]): {
  rootName: string | null;
  entries: UploadEntry[];
} {
  const normalized = entries.map((entry) => ({
    file: entry.file,
    relativePath: normalizeRelativePath(entry.relativePath),
  }));

  const roots = new Set<string>();
  for (const entry of normalized) {
    const parts = entry.relativePath.split("/").filter(Boolean);
    // A bare filename means this entry has no root directory to share.
    if (parts.length < 2) return { rootName: null, entries: normalized };
    roots.add(parts[0]);
  }

  if (roots.size !== 1) return { rootName: null, entries: normalized };
  const rootName = [...roots][0];

  return {
    rootName,
    entries: normalized.map((entry) => ({
      file: entry.file,
      relativePath: entry.relativePath.split("/").slice(1).join("/"),
    })),
  };
}
