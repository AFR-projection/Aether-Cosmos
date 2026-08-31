"use client";

import { useCallback, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Download, Folder, MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/ui/primitives/button";
import { FloatingActionMenu, useFloatingMenu, type FloatingMenuItem } from "@/ui/primitives/floating-action-menu";
import { travelledAsDrag, type DragData, type PressPoint } from "@files/domain/services/drag-move";
import { useT } from "@/shared/lib/i18n";
import type { Folder as FolderRecord } from "@/shared/infrastructure/db/schema";

interface FolderCardProps {
  folder: FolderRecord;
  trash?: boolean;
  /** Where the card navigates. Defaults to the owner's own `/files` view. */
  href?: string;
  /**
   * Whether this card can be picked up and dropped into another folder. Off unless the
   * viewer may write, so a drag never ends in a refusal the card could have predicted.
   */
  canDrag?: boolean;
  /** Omit to hide the action — a `view` member may not rename or delete. */
  onRename?: (folder: FolderRecord) => void;
  onDelete?: (folder: FolderRecord) => void;
  onShare?: (folder: FolderRecord) => void;
  onDownload?: (folder: FolderRecord) => void;
}

export function FolderCard({
  folder,
  trash = false,
  href,
  canDrag = false,
  onRename,
  onDelete,
  onShare,
  onDownload,
}: FolderCardProps) {
  const t = useT();
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: folder.id });
  // Same node, two roles: a folder both receives what is dropped on it and can itself
  // be carried into another folder. `attributes` is left unused — see `useRowDrag` in
  // `file-grid.tsx` for why a `role="button"` here would cost more than it buys.
  const {
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: folder.id,
    disabled: !canDrag || trash,
    data: { kind: "folder", name: folder.name } satisfies DragData,
  });
  const menu = useFloatingMenu();
  const pressPoint = useRef<PressPoint | null>(null);

  // Both setters in one stable callback. An inline arrow would be a new ref every
  // render, and React would detach and re-register the droppable each time — enough to
  // lose the `isOver` highlight mid-drag.
  const setNodeRef = useCallback(
    (node: HTMLAnchorElement | null) => {
      setDropRef(node);
      setDragRef(node);
    },
    [setDropRef, setDragRef]
  );

  const menuItems: FloatingMenuItem[] = [];

  if (!trash && onShare) {
    menuItems.push({
      id: "share",
      label: t("files.folderShare.title"),
      icon: Users,
      onClick: () => onShare(folder),
    });
  }

  if (!trash && onDownload) {
    menuItems.push({
      id: "download",
      label: t("files.folderCard.download"),
      icon: Download,
      onClick: () => onDownload(folder),
    });
  }

  if (!trash && onRename) {
    menuItems.push({
      id: "rename",
      label: t("common.rename"),
      icon: Pencil,
      onClick: () => onRename(folder),
    });
  }

  if (onDelete) {
    menuItems.push({
      id: "delete",
      label: t(trash ? "files.list.deletePermanently" : "files.list.trash"),
      icon: Trash2,
      danger: true,
      onClick: () => onDelete(folder),
    });
  }

  return (
    <div className="relative group">
      <a
        ref={setNodeRef}
        href={trash ? undefined : (href ?? `/files?folder=${folder.id}`)}
        // A link is natively draggable, and that drag would be read as an incoming
        // upload by the page's drop zone. dnd-kit drives the gesture instead.
        draggable={false}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          pressPoint.current = { x: e.clientX, y: e.clientY };
          listeners?.onMouseDown?.(e);
        }}
        onClick={(e) => {
          if (trash) {
            e.preventDefault();
            return;
          }
          // Navigation is the browser's default action for a link, and dnd-kit only
          // stops the click from propagating — which never stops a default action. So
          // a press that travelled far enough to be a drag cancels the navigation
          // itself, or every completed drag would also open the folder it landed on.
          if (travelledAsDrag(pressPoint.current, { x: e.clientX, y: e.clientY })) {
            e.preventDefault();
          }
          pressPoint.current = null;
        }}
        className={cn(
          "flex items-center gap-2.5 rounded-xl border px-3 py-3 pr-11 text-sm transition-all duration-200 min-h-[48px]",
          // dnd-kit reports a card as "over" itself while it is the one being dragged;
          // highlighting then would promise a drop that the move rules refuse.
          isOver && !isDragging
            ? "border-accent bg-accent/10 scale-[1.02] shadow-md shadow-accent/10"
            : "border-border/60 bg-surface hover:border-accent/30 hover:bg-surface-hover hover:shadow-sm",
          // Held in place at reduced opacity while the overlay follows the pointer.
          isDragging && "opacity-40"
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
          <Folder className="h-4 w-4 text-accent-ink" />
        </div>
        <span className="truncate font-medium leading-tight">{folder.name}</span>
      </a>

      {/* No actions at all (a `view` member) → no menu affordance to click. */}
      {menuItems.length > 0 && (
        <>
          <Button
            ref={menu.anchorRef}
            variant="ghost"
            size="icon"
            type="button"
            aria-label={t("files.folderCard.actions")}
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
        </>
      )}
    </div>
  );
}
