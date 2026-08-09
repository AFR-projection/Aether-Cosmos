"use client";

import { useDroppable } from "@dnd-kit/core";
import { Download, Folder, MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FloatingActionMenu, useFloatingMenu, type FloatingMenuItem } from "@/components/ui/floating-action-menu";
import type { Folder as FolderRecord } from "@/lib/db/schema";

interface FolderCardProps {
  folder: FolderRecord;
  trash?: boolean;
  onRename: (folder: FolderRecord) => void;
  onDelete: (folder: FolderRecord) => void;
  onShare?: (folder: FolderRecord) => void;
  onDownload?: (folder: FolderRecord) => void;
}

export function FolderCard({
  folder,
  trash = false,
  onRename,
  onDelete,
  onShare,
  onDownload,
}: FolderCardProps) {
  const { isOver, setNodeRef } = useDroppable({ id: folder.id });
  const menu = useFloatingMenu();

  const menuItems: FloatingMenuItem[] = [];

  if (!trash && onShare) {
    menuItems.push({
      id: "share",
      label: "Share folder",
      icon: Users,
      onClick: () => onShare(folder),
    });
  }

  if (!trash && onDownload) {
    menuItems.push({
      id: "download",
      label: "Download folder",
      icon: Download,
      onClick: () => onDownload(folder),
    });
  }

  if (!trash) {
    menuItems.push({
      id: "rename",
      label: "Rename",
      icon: Pencil,
      onClick: () => onRename(folder),
    });
  }

  menuItems.push({
    id: "delete",
    label: trash ? "Delete permanently" : "Move to trash",
    icon: Trash2,
    danger: true,
    onClick: () => onDelete(folder),
  });

  return (
    <div className="relative group">
      <a
        ref={setNodeRef}
        href={trash ? undefined : `/files?folder=${folder.id}`}
        onClick={trash ? (e) => e.preventDefault() : undefined}
        className={cn(
          "flex items-center gap-2.5 rounded-xl border px-3 py-3 pr-11 text-sm transition-all duration-200 min-h-[48px]",
          isOver
            ? "border-accent bg-accent/10 scale-[1.02] shadow-md shadow-accent/10"
            : "border-border/60 bg-surface hover:border-accent/30 hover:bg-surface-hover hover:shadow-sm"
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
          <Folder className="h-4 w-4 text-accent" />
        </div>
        <span className="truncate font-medium leading-tight">{folder.name}</span>
      </a>

      <Button
        ref={menu.anchorRef}
        variant="ghost"
        size="icon"
        type="button"
        aria-label="Folder actions"
        aria-expanded={menu.isOpen(folder.id)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          menu.toggle(folder.id);
        }}
        className={cn(
          "absolute top-1.5 right-1.5 h-8 w-8 rounded-lg",
          "bg-surface/90 backdrop-blur-sm border border-border/40",
          "text-muted-foreground hover:text-foreground hover:bg-surface-elevated",
          "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
          "transition-opacity duration-150",
          menu.isOpen(folder.id) && "opacity-100 bg-surface-elevated border-accent/30"
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>

      <FloatingActionMenu
        open={menu.isOpen(folder.id)}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        items={menuItems}
        align="end"
      />
    </div>
  );
}
