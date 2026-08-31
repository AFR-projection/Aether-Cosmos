"use client";

import { useEffect, useState } from "react";
import { ChevronRight, FolderIcon, Home, Loader2, Move, TriangleAlert } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Modal } from "@/ui/primitives/modal";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { apiErrorMessage, useT } from "@/shared/lib/i18n";
import type { Folder as FolderRecord } from "@/shared/infrastructure/db/schema";

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

/** `name: null` is the viewer's own root, whose label is translated at render. */
type Crumb = { id: string | null; name: string | null };

export function MoveToFolderDialog({
  count,
  disabledFolderIds = [],
  onCancel,
  onConfirm,
}: MoveToFolderDialogProps) {
  const t = useT();
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: null }]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  // Starts true: the first paint happens before the request resolves, and a
  // spinner is honest there where "No subfolders" would be a guess.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const current = crumbs[crumbs.length - 1];
  const currentName = current.name ?? t("files.myFiles");
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
          setError(apiErrorMessage(res, t, "files.move.loadFailed"));
          return;
        }
        setFolders(res.data.folders);
      })
      .catch(() => {
        if (!alive) return;
        setFolders([]);
        setError(t("files.move.loadFailed"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `t` is a dependency because the stored error is already translated.
  }, [current.id, reloadKey, t]);

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
      title={t("files.move.title", { count })}
      description={t("files.move.description")}
      bodyClassName="flex min-h-0 flex-col overflow-y-hidden p-0"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {/* Says why "Move here" is refused, rather than leaving a dead button.
              The folder name is interpolated into one sentence: an emphasis span
              cannot survive a clause that reorders between languages. */}
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {destinationBlocked ? (
              <span className="text-warning-ink">
                {t("files.move.alreadyIn", { folder: currentName })}
              </span>
            ) : (
              t("files.move.into", { folder: currentName })
            )}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={destinationBlocked}
              onClick={() => onConfirm({ folderId: current.id, folderName: currentName })}
            >
              <Move className="h-3.5 w-3.5" aria-hidden="true" /> {t("files.move.confirm")}
            </Button>
          </div>
        </div>
      }
    >
      <nav
        aria-label={t("files.move.pathLabel")}
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
                  {crumb.name ?? t("files.myFiles")}
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
            <span role="status">{t("files.move.loading")}</span>
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
              {t("errorPages.tryAgain")}
            </Button>
          </div>
        ) : folders.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center px-6 text-center">
            <FolderIcon className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-xs font-medium">
              {t("files.move.noSubfolders", { folder: currentName })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {destinationBlocked
                ? t("files.move.noSubfoldersBlocked")
                : t("files.move.noSubfoldersHint")}
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
                    title={isSource ? t("files.move.sourceTitle") : undefined}
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
                    {isSource && <span className="shrink-0 text-xs">{t("files.move.sourceBadge")}</span>}
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
