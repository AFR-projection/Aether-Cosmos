"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, FolderIcon, Home, Loader2, Move, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Folder as FolderRecord } from "@/lib/db/schema";

type MoveToFolderDialogProps = {
  /** How many items are being moved (for the header). */
  count: number;
  /** Folder ids that must be disabled (e.g. moving a folder into itself). */
  disabledFolderIds?: string[];
  onCancel: () => void;
  onConfirm: (destinationFolderId: string | null) => void;
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
  const [loading, setLoading] = useState(false);

  const current = crumbs[crumbs.length - 1];
  const disabled = new Set(disabledFolderIds);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (current.id) params.set("parentId", current.id);
    apiFetch<{ folders: FolderRecord[] }>(`/api/folders?${params}`)
      .then((res) => {
        if (!alive) return;
        setFolders(res.data?.folders ?? []);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [current.id]);

  const openFolder = (f: FolderRecord) => setCrumbs((c) => [...c, { id: f.id, name: f.name }]);
  const jumpTo = (index: number) => setCrumbs((c) => c.slice(0, index + 1));

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="scrim fixed inset-0 z-[80] flex items-center justify-center p-4"
        onClick={onCancel}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.18 }}
          className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative border-b border-border bg-gradient-to-br from-accent/10 to-transparent px-5 py-4">
            <button
              onClick={onCancel}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15">
                <Move className="h-4 w-4 text-accent" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Move {count} item{count === 1 ? "" : "s"}</h2>
                <p className="text-[11px] text-muted-foreground">Pick a destination folder</p>
              </div>
            </div>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/20 px-4 py-2 text-xs no-scrollbar">
            {crumbs.map((crumb, i) => (
              <div key={`${crumb.id}-${i}`} className="flex shrink-0 items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
                <button
                  onClick={() => jumpTo(i)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-colors",
                    i === crumbs.length - 1
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {i === 0 && <Home className="h-3 w-3" />}
                  {crumb.name}
                </button>
              </div>
            ))}
          </div>

          {/* Folder list */}
          <div className="max-h-72 min-h-[9rem] overflow-y-auto p-2">
            {loading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : folders.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center text-center text-muted-foreground">
                <FolderIcon className="h-7 w-7 opacity-40" />
                <p className="mt-2 text-xs">No subfolders here</p>
                <p className="text-[11px] text-muted-foreground/70">
                  Move into &ldquo;{current.name}&rdquo; using the button below
                </p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {folders.map((f) => {
                  const isDisabled = disabled.has(f.id);
                  return (
                    <li key={f.id}>
                      <button
                        disabled={isDisabled}
                        onClick={() => openFolder(f)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                          isDisabled
                            ? "cursor-not-allowed opacity-40"
                            : "hover:bg-accent/10"
                        )}
                      >
                        <FolderIcon className="h-4 w-4 shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                        {!isDisabled && (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3.5">
            <p className="min-w-0 truncate text-[11px] text-muted-foreground">
              Into: <span className="font-medium text-foreground">{current.name}</span>
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={current.id !== null && disabled.has(current.id)}
                onClick={() => onConfirm(current.id)}
              >
                <Move className="h-3.5 w-3.5" /> Move here
              </Button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
