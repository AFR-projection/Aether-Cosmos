"use client";

import { useEffect, useState } from "react";
import { ChevronRight, FolderIcon, Home, Loader2, Move, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Folder as FolderRecord } from "@/lib/db/schema";

type MoveToFolderDialogProps = {
  /** How many items are being moved (for the header). */
  count: number;
  /**
   * Folders that are not valid destinations — in practice the folder the items are
   * already in. They stay open-able (their subfolders are fine destinations); it is
   * only "Move here" that is refused while one of them is the current folder.
   */
  disabledFolderIds?: string[];
  onCancel: () => void;
  onConfirm: (dest: { folderId: string | null; folderName: string }) => void;
};

type Crumb = { id: string | null; name: string };

export function MoveToFolderDialog({
  count,
  disabledFolderIds = [],
  onCancel,
  onConfirm,
}: MoveToFolderDialogProps) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: "My Files" }]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  // Starts true: the first paint happens before the request resolves, and a
  // spinner is honest there where "No subfolders" would be a guess.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const current = crumbs[crumbs.length - 1];
  const disabled = new Set(disabledFolderIds);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (current.id) params.set("parentId", current.id);
    apiFetch<{ folders: FolderRecord[] }>(`/api/folders?${params}`)
      .then((res) => {
        if (!alive) return;
        // A request that failed is not an empty folder. Rendering the empty state
        // here would invite someone to drop files into a folder we never read.
        if (!res.success || !res.data) {
          setFolders([]);
          setError(res.error ?? "Could not load folders");
          return;
        }
        setFolders(res.data.folders);
      })
      .catch(() => {
        if (!alive) return;
        setFolders([]);
        setError("Could not load folders");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [current.id, reloadKey]);

  // Both navigations flip to loading in the same commit as the crumb change, so the
  // list never shows the folder you just left as if it were the one you opened.
  const openFolder = (f: FolderRecord) => {
    setLoading(true);
    setCrumbs((c) => [...c, { id: f.id, name: f.name }]);
  };
  const jumpTo = (index: number) => {
    setLoading(true);
    setCrumbs((c) => c.slice(0, index + 1));
  };

  const destinationBlocked = current.id !== null && disabled.has(current.id);

  return (
    <Modal
      open
      onClose={onCancel}
      icon={Move}
      title={`Move ${count} item${count === 1 ? "" : "s"}`}
      description="Open a folder to go deeper, then move into the folder you are viewing."
      bodyClassName="flex min-h-0 flex-col overflow-y-hidden p-0"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {/* Says why "Move here" is refused, rather than leaving a dead button. */}
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {destinationBlocked ? (
              <span className="text-warning-ink">Already in {current.name}</span>
            ) : (
              <>
                Into <span className="font-medium text-foreground">{current.name}</span>
              </>
            )}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={destinationBlocked}
              onClick={() => onConfirm({ folderId: current.id, folderName: current.name })}
            >
              <Move className="h-3.5 w-3.5" aria-hidden="true" /> Move here
            </Button>
          </div>
        </div>
      }
    >
      <nav
        aria-label="Destination path"
        className="no-scrollbar flex shrink-0 items-center overflow-x-auto border-b border-border/50 bg-background/40 px-4 py-2 text-xs"
      >
        <ol className="flex items-center gap-1">
          {crumbs.map((crumb, i) => {
            const isCurrent = i === crumbs.length - 1;
            return (
              <li key={`${crumb.id}-${i}`} className="flex shrink-0 items-center gap-1">
                {i > 0 && (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                )}
                <button
                  type="button"
                  onClick={() => jumpTo(i)}
                  aria-current={isCurrent ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 py-1 font-medium transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                    isCurrent ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {i === 0 && <Home className="h-3 w-3" aria-hidden="true" />}
                  {crumb.name}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="min-h-[9rem] flex-1 overflow-y-auto p-2" aria-busy={loading}>
        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span role="status">Loading folders…</span>
          </div>
        ) : error ? (
          <div className="flex h-32 flex-col items-center justify-center px-6 text-center">
            <TriangleAlert className="h-7 w-7 text-danger-ink" aria-hidden="true" />
            <p className="mt-2 text-xs font-medium" role="alert">
              {error}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Try again
            </Button>
          </div>
        ) : folders.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center px-6 text-center">
            <FolderIcon className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-medium">
              No subfolders in &ldquo;{current.name}&rdquo;
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {destinationBlocked
                ? "The items are already here — go up a level to pick a different folder."
                : "This is as deep as it goes — use Move here to drop the items in this folder."}
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {folders.map((f) => {
              // Not a valid destination, still worth opening: its subfolders are.
              const isSource = disabled.has(f.id);
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => openFolder(f)}
                    title={isSource ? "The items are already in this folder" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-accent/10",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                      isSource && "text-muted-foreground"
                    )}
                  >
                    <FolderIcon
                      className={cn("h-4 w-4 shrink-0", isSource ? "text-muted-foreground" : "text-accent-ink")}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                    {isSource && <span className="shrink-0 text-xs">Current</span>}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
