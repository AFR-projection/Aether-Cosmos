"use client";

import { useDroppable } from "@dnd-kit/core";
import { FolderPlus } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { Folder as FolderRecord } from "@/shared/infrastructure/db/schema";

interface DroppableFolderProps {
  folder: FolderRecord;
  onDrop?: (folderId: string) => void;
}

export function DroppableFolder({ folder }: DroppableFolderProps) {
  const { isOver, setNodeRef } = useDroppable({ id: folder.id });

  return (
    <a
      ref={setNodeRef}
      href={`/files?folder=${folder.id}`}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all duration-200",
        isOver
          ? "border-accent bg-accent/10 scale-105"
          : "border-border bg-surface hover:bg-surface-hover"
      )}
    >
      <FolderPlus className="h-4 w-4 text-accent-ink" />
      <span className="truncate">{folder.name}</span>
    </a>
  );
}
