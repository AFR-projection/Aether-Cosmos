"use client";

import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import type { Folder as FolderRecord } from "@/lib/db/schema";

/**
 * The children of one folder, as query options rather than a hook.
 *
 * The grid asks for one folder; the tree pane asks for dozens at once through
 * `useQueries`. Both have to land on the SAME cache entry, or the tree would
 * re-fetch what the grid already has and the two could disagree about what is
 * inside a folder. Sharing the options — not just the key — also keeps the
 * existing `invalidateQueries({ queryKey: ["folders"] })` calls after a rename,
 * move or delete refreshing both surfaces at once.
 */
export function folderChildrenQuery(parentId: string | null, trash = false) {
  return queryOptions({
    queryKey: ["folders", parentId, trash] as const,
    queryFn: async (): Promise<FolderRecord[]> => {
      const params = new URLSearchParams();
      if (parentId) params.set("parentId", parentId);
      if (trash) params.set("trash", "true");
      const res = await apiFetch<{ folders: FolderRecord[] }>(`/api/folders?${params}`);
      return res.data?.folders ?? [];
    },
  });
}
