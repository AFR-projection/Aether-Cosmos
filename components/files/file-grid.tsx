"use client";

import { useCallback, useRef, useState, useEffect, useMemo, memo, useSyncExternalStore } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useDraggable } from "@dnd-kit/core";
import { useReducedMotion } from "framer-motion";
import {
  File as FileIcon2,
  Star, Trash2, Copy, CopyPlus, Scissors, RotateCcw, Pencil, MoreHorizontal, Download,
  Play, Share2, Check, Lock, FolderInput, Music,
  ArrowUpDown, ArrowUp, ArrowDown, SearchX, Filter,
} from "lucide-react";
import { cn, formatBytes, formatDate, getMimeCategory } from "@/lib/utils";
import { FileTypeIcon, getAccentColor, getGradientFallback, getTypeLabel } from "@/lib/file-type-utils";
import { sortFiles } from "@/lib/files/sort";
import type { DragData } from "@/lib/files/drag-move";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FloatingActionMenu, useFloatingMenu, type FloatingMenuItem } from "@/components/ui/floating-action-menu";
import type { File as FileRecord } from "@/lib/db/schema";
import { Spinner } from "@/components/system/spinner";
import { isLiteMode } from "@/lib/system/lite-mode";

const ROW_HEIGHT = 56;
const OVERSCAN = 8;

/**
 * Where the list's sticky column header parks.
 *
 * Both views scroll with the document, so the header has to clear the mobile app
 * chrome — a fixed bar of `3.5rem` plus the notch inset — and sits flush at the top
 * from `lg` up, where that bar is hidden and the sidebar takes over.
 */
const STICKY_HEADER_TOP = "top-[calc(3.5rem+var(--safe-top))] lg:top-0";

// ─── Grid virtualization metrics ────────────────────────────────────────────
// The grid scrolls with the page (no inner scroll container), so it uses the
// window virtualizer. Only the visible band of rows is mounted — on a 200-file
// folder that is ~3 rows instead of 200 cards, which is the difference between
// a smooth and an unusable scroll on a low-end phone.

/** Column counts must mirror the Tailwind classes on the grid container. */
const GRID_BREAKPOINTS = [
  { min: 1536, cols: 6 },
  { min: 1280, cols: 5 },
  { min: 1024, cols: 4 },
  { min: 640, cols: 3 },
  { min: 0, cols: 2 },
] as const;

/** Height of the name/size block under each thumbnail (pt-2 + name + pb-2.5).
 *  Only the first estimate — `measureElement` corrects each row once it mounts. */
const CARD_META_HEIGHT = 62;
const GRID_OVERSCAN = 3;

function readColumns(): number {
  if (typeof window === "undefined") return 2;
  const w = window.innerWidth;
  return GRID_BREAKPOINTS.find((b) => w >= b.min)?.cols ?? 2;
}

function subscribeColumns(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const queries = GRID_BREAKPOINTS.filter((b) => b.min > 0).map((b) =>
    window.matchMedia(`(min-width:${b.min}px)`)
  );
  queries.forEach((q) => q.addEventListener("change", onChange));
  return () => queries.forEach((q) => q.removeEventListener("change", onChange));
}

/**
 * Column count derived from breakpoint crossings only — not from a continuous
 * width value — so scrolling and resizing never re-render on every pixel.
 */
function useGridColumns(): number {
  return useSyncExternalStore(subscribeColumns, readColumns, () => 2);
}

/**
 * Where a virtualized container starts in the document, and how wide it is.
 *
 * Neither view owns a scroll box — both scroll with the page — so each virtualizer
 * needs its container's distance from the top of the document as `scrollMargin`, and
 * the grid needs the width to estimate a card's height. Measured against the parent
 * too, so the offset follows content above it (folders, filter chips) appearing.
 *
 * The setter compares before committing: a ResizeObserver fires on every layout pass,
 * and an unconditional `setState` there would re-render the whole listing each time.
 *
 * Returned as a tuple, not an object: bundling the ref together with the measurements
 * would make every read of `.offset` during render look like a ref access.
 */
function useContainerMetrics(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ offset: 0, width: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;

    const measure = () => {
      const offset = el.getBoundingClientRect().top + window.scrollY;
      const width = el.clientWidth;
      setMetrics((prev) =>
        prev.offset === offset && prev.width === width ? prev : { offset, width }
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.parentElement) observer.observe(el.parentElement);
    // Anything growing ABOVE the container (folders arriving, filter chips wrapping)
    // moves it down the document without resizing it, which would leave `scrollMargin`
    // stale and draw every row at the wrong offset. A body resize covers that.
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [active]);

  return [ref, metrics] as const;
}

// ─── Right-click context menu hook ────────────────────────────────────────────
// Keeps the pointer in viewport coordinates so the menu stays correct inside
// transformed and virtualized grid/list rows.
function useContextMenu() {
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPoint({ x: e.clientX, y: e.clientY });
    setOpen(true);
  };

  return { open, point, close: () => setOpen(false), onContextMenu };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  return <FileTypeIcon mimeType={mimeType} className={className} />;
}

// ─── Thumbnail lazy loader ──────────────────────────────────────────────────

/** Sizes the thumbnail endpoint can actually serve. */
const THUMB_SIZES = [150, 300, 600, 1200] as const;

/**
 * Picks the smallest served size that still covers the box the image is painted
 * into. Device pixel ratio is capped at 2 — a 3x panel on a budget phone gains
 * nothing visible from a 3x image but pays for every extra pixel in download,
 * decode and memory. Lite mode caps harder still.
 */
function pickThumbnailSize(cssWidth: number, lite: boolean): number {
  const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2);
  const needed = Math.ceil((cssWidth || 160) * dpr);
  const cap = lite ? 300 : 1200;
  return THUMB_SIZES.find((s) => s >= needed && s <= cap) ?? cap;
}

function useThumbnail(fileId: string, hasThumb: boolean) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [currentSrc, setCurrentSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasThumb) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          const size = pickThumbnailSize(el.clientWidth, isLiteMode());
          setCurrentSrc(`/api/files/${fileId}/thumbnail?size=${size}`);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [fileId, hasThumb]);

  return { containerRef, currentSrc, loaded, setLoaded, error, setError };
}

// ─── File action menu items ─────────────────────────────────────────────────

/**
 * What the viewer may do with the files in this listing.
 *
 * Everything is allowed by default so the normal "My Files" surface is unchanged; only a
 * shared folder passes a narrower set. This mirrors the server capabilities in
 * `lib/auth/permissions.ts` — the API refuses regardless, this just stops the UI from
 * offering an action that can only end in a 403.
 */
export type FileGridCaps = {
  /** Rename, move, duplicate, cut, trash. */
  canEdit: boolean;
  /** Favourite flag and public share links — the owner's call only. */
  canOwnerOnlyFlags: boolean;
  /** Restore from trash / delete permanently. */
  canPurge: boolean;
};

export const FULL_FILE_CAPS: FileGridCaps = {
  canEdit: true,
  canOwnerOnlyFlags: true,
  canPurge: true,
};

function buildFileMenuItems(
  file: FileRecord,
  trash: boolean | undefined,
  onAction: (action: string, file: FileRecord) => void,
  caps: FileGridCaps
): FloatingMenuItem[] {
  if (trash) {
    if (!caps.canPurge) return [];
    return [
      { id: "restore", label: "Restore", icon: RotateCcw, onClick: () => onAction("restore", file) },
      { id: "delete", label: "Delete permanently", icon: Trash2, danger: true, shortcut: "Del", onClick: () => onAction("delete", file) },
    ];
  }
  const items: FloatingMenuItem[] = [
    { id: "download", label: "Download", icon: Download, onClick: () => onAction("download", file) },
  ];
  // A public share link exposes the OWNER's file to anyone with the URL, so it stays with
  // the owner even when a collaborator may edit the contents.
  if (caps.canOwnerOnlyFlags) {
    items.push({ id: "share", label: "Share", icon: Share2, onClick: () => onAction("share", file) });
  }
  items.push({ id: "clip-copy", label: "Copy", icon: Copy, shortcut: "Ctrl C", onClick: () => onAction("clip-copy", file) });
  if (caps.canEdit) {
    items.push(
      { id: "clip-cut", label: "Cut", icon: Scissors, shortcut: "Ctrl X", onClick: () => onAction("clip-cut", file) },
      { id: "rename", label: "Rename", icon: Pencil, shortcut: "F2", onClick: () => onAction("rename", file) },
      { id: "move", label: "Move to…", icon: FolderInput, shortcut: "M", onClick: () => onAction("move", file) },
    );
  }
  if (caps.canOwnerOnlyFlags) {
    items.push({ id: "favorite", label: file.isFavorite ? "Unfavorite" : "Favorite", icon: Star, onClick: () => onAction("favorite", file) });
  }
  if (caps.canEdit) {
    items.push(
      { id: "duplicate", label: "Duplicate", icon: CopyPlus, onClick: () => onAction("duplicate", file) },
      { id: "delete", label: "Move to trash", icon: Trash2, danger: true, shortcut: "Del", onClick: () => onAction("delete", file) },
    );
  }
  return items;
}

// ─── Sort header ────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string;
  sortKey: string;
  current: string;
  order: "asc" | "desc";
  onSort: (key: string) => void;
}

function SortHeader({ label, sortKey, current, order, onSort }: SortHeaderProps) {
  const active = current === sortKey;
  const direction = active ? (order === "asc" ? "ascending" : "descending") : null;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      // The row is a CSS grid, not a <table>, so there is no cell to carry aria-sort.
      // The state goes in the label instead, which screen readers do announce.
      aria-label={
        direction
          ? `${label} — sorted ${direction}. Activate to reverse.`
          : `Sort by ${label.toLowerCase()}`
      }
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded text-xs font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      <span aria-hidden className="inline-flex flex-col leading-none">
        {active && order === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : active && order === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-60" />
        )}
      </span>
    </button>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

/**
 * Why the listing is empty, so the copy can say something true.
 *
 * A zero-result search used to read "No files yet — drop files anywhere to upload",
 * which is wrong twice over: the folder is not empty, and uploading is not the way out.
 */
export type FileGridEmpty = {
  /** The active query, when the listing is empty because of a search. */
  searchQuery?: string;
  /** A type filter (Images, Videos, …) is narrowing the listing. */
  filterActive?: boolean;
  /** Clears both the search and the type filter. */
  onResetFilters?: () => void;
  /** Offered only when nothing is filtering — e.g. an Upload button. */
  action?: React.ReactNode;
  /** Folders are listed above, so keep this to one line instead of a full panel. */
  compact?: boolean;
  /** The viewer cannot add anything here, so don't tell them to upload. */
  readOnly?: boolean;
};

function FilesEmptyState({ trash, empty }: { trash: boolean; empty?: FileGridEmpty }) {
  const { searchQuery, filterActive, onResetFilters, action, compact, readOnly } = empty ?? {};
  const searching = !!searchQuery;

  const icon = trash ? Trash2 : searching ? SearchX : filterActive ? Filter : FileIcon2;
  const title = trash
    ? "Recycle bin is empty"
    : searching
      ? "No files match your search"
      : filterActive
        ? "Nothing of this type here"
        : "No files yet";
  const description = trash
    ? "Files you delete will show up here."
    : searching
      ? `Nothing found for “${searchQuery}”. Try fewer words, or clear the search.`
      : filterActive
        ? "Pick All to see everything in this folder again."
        : readOnly
          ? "Nothing has been added to this folder yet."
          : "Drop files anywhere on this page to upload, or use Upload in the toolbar.";

  // With folders listed above, a full-height panel pushes them off screen — a single
  // line says the same thing without hiding what is actually here.
  if (compact) {
    return (
      <p className="rounded-2xl border border-dashed border-border/50 px-4 py-7 text-center text-sm text-muted-foreground">
        {title}
      </p>
    );
  }

  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      className="py-20"
      action={
        (searching || filterActive) && onResetFilters ? (
          <Button variant="secondary" size="sm" onClick={onResetFilters} className="cursor-pointer">
            Clear search and filters
          </Button>
        ) : (
          action
        )
      }
    />
  );
}

// ─── Hover info card ────────────────────────────────────────────────────────

function HoverInfoCard({ file }: { file: FileRecord }) {
  return (
    // aria-hidden: everything in here is already available to assistive tech from
    // the card itself — the popover is a mouse-only convenience.
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 w-64 -translate-x-1/2"
    >
      <div className="rounded-xl border border-border bg-surface p-3 shadow-xl">
        {/* Type badge + name */}
        <div className="flex items-start gap-2.5 mb-2.5">
          <div className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br",
            getGradientFallback(file.mimeType)
          )}>
            <FileIcon mimeType={file.mimeType} className={cn("h-4 w-4", getAccentColor(file.mimeType))} />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="truncate text-sm font-semibold leading-tight">{file.name}</p>
            <span className={cn("mt-0.5 inline-block rounded px-1.5 py-px text-xs font-semibold uppercase tracking-wide", getAccentColor(file.mimeType), "bg-current/10")}>
              {getTypeLabel(file.mimeType)}
            </span>
          </div>
        </div>
        {/* Stats */}
        <div className="space-y-1 text-xs">
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Size</span>
            <span className="font-mono font-medium text-foreground">{formatBytes(file.sizeBytes)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Modified</span>
            <span className="text-foreground">{formatDate(file.updatedAt, "short")}</span>
          </div>
          {(file.isFavorite || file.encrypted) && (
            <div className="flex items-center gap-2 pt-0.5">
              {file.isFavorite && <span className="flex items-center gap-1 text-warning-ink"><Star className="h-3 w-3 fill-current" />Favorite</span>}
              {file.encrypted && <span className="flex items-center gap-1 text-accent-ink"><Lock className="h-3 w-3" />Encrypted</span>}
            </div>
          )}
        </div>
      </div>
      {/* Arrow */}
      <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-2 w-4 overflow-hidden">
        <div className="mx-auto h-2.5 w-2.5 rotate-45 border-l border-t border-border bg-surface" />
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface FileGridProps {
  files: FileRecord[];
  view: "grid" | "list";
  trash?: boolean;
  selectedIds: Set<string>;
  sortBy: string;
  sortOrder: "asc" | "desc";
  onFileAction: (action: string, file: FileRecord) => void;
  onFileClick: (file: FileRecord) => void;
  onSelect: (id: string, shiftKey?: boolean) => void;
  onSelectAll: () => void;
  onSort: (key: string) => void;
  /** Viewer capabilities; omit for full rights (own files). */
  caps?: FileGridCaps;
  hasMore?: boolean;
  loadMore?: () => void;
  loadingMore?: boolean;
  /** Context for the empty state, so its copy matches why nothing is listed. */
  empty?: FileGridEmpty;
}

export function FileGrid({
  files, view, trash = false,
  selectedIds, sortBy, sortOrder,
  onFileAction, onFileClick, onSelect, onSelectAll, onSort,
  caps = FULL_FILE_CAPS,
  hasMore, loadMore, loadingMore,
  empty,
}: FileGridProps) {
  const allSelected = files.length > 0 && selectedIds.size === files.length;

  // ── Sorted files ──
  const sorted = useMemo(() => sortFiles(files, sortBy, sortOrder), [files, sortBy, sortOrder]);

  // ── Virtual list ──
  // Rows scroll with the document like the grid does, so there is no inner scroll box
  // and no hard-coded viewport maths: the old `maxHeight: calc(100dvh - 15rem)` was a
  // guess at the header height that nested a second scrollbar inside the page.
  const [listRef, listMetrics] = useContainerMetrics(view === "list");
  const listVirtualizer = useWindowVirtualizer({
    count: sorted.length + (hasMore ? 1 : 0),
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollMargin: listMetrics.offset,
  });

  // ── Virtual grid ──
  // The grid scrolls with the document, so it virtualizes against the window and
  // offsets by the container's distance from the top of the page.
  const [gridBoxRef, gridMetrics] = useContainerMetrics(view === "grid");
  const columns = useGridColumns();

  const gridGap = columns >= 3 ? 16 : 12; // gap-3 / sm:gap-4
  const estimatedRowHeight = useMemo(() => {
    const cardWidth =
      gridMetrics.width > 0 ? (gridMetrics.width - gridGap * (columns - 1)) / columns : 168;
    // aspect-[4/3] thumbnail + meta block + row gap
    return Math.round(cardWidth * 0.75 + CARD_META_HEIGHT + gridGap);
  }, [gridMetrics.width, gridGap, columns]);

  const gridRowCount = Math.ceil(sorted.length / columns);
  const gridVirtualizer = useWindowVirtualizer({
    count: gridRowCount,
    estimateSize: () => estimatedRowHeight,
    overscan: GRID_OVERSCAN,
    scrollMargin: gridMetrics.offset,
  });

  // Infinite scroll trigger.
  //
  // A callback ref, not an effect reading `ref.current`: the sentinel row is
  // mounted and unmounted by the virtualizer as it scrolls past, and switching
  // between grid and list swaps it for a different node entirely. An effect would
  // keep observing a node that has since been detached — "load more" then stops
  // firing with nothing to show why. React calls the cleanup returned below every
  // time the node changes, so the observer always watches the live sentinel.
  const loadMoreRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !loadMore) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) loadMore();
        },
        { rootMargin: "200px" }
      );
      observer.observe(node);
      return () => observer.disconnect();
    },
    [loadMore]
  );

  // ── Empty ──
  if (files.length === 0) {
    return <FilesEmptyState trash={trash} empty={empty} />;
  }

  // ====== GRID VIEW ======
  if (view === "grid") {
    const virtualRows = gridVirtualizer.getVirtualItems();

    return (
      <div>
        <div
          ref={gridBoxRef}
          className="relative w-full"
          style={{ height: `${gridVirtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((virtualRow) => {
            const start = virtualRow.index * columns;
            const rowFiles = sorted.slice(start, start + columns);
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={gridVirtualizer.measureElement}
                // Each transformed virtual row is its own stacking context.
                // Lift the hovered row above the next row so the card details
                // popover is never painted underneath it.
                className="absolute left-0 top-0 w-full hover:z-20"
                style={{
                  transform: `translateY(${virtualRow.start - gridVirtualizer.options.scrollMargin}px)`,
                }}
              >
                <div
                  className="grid grid-cols-2 gap-3 pb-3 sm:gap-4 sm:pb-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
                >
                  {rowFiles.map((file) => (
                    <GridCard
                      key={file.id}
                      file={file}
                      selected={selectedIds.has(file.id)}
                      trash={trash}
                      onFileAction={onFileAction}
                      onFileClick={onFileClick}
                      onSelect={onSelect}
                      caps={caps}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {hasMore && loadMore && (
          <div ref={loadMoreRef} className="flex justify-center py-8">
            {loadingMore ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner size="xs" />
                Loading more…
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={loadMore}>
                Load more
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ====== LIST VIEW ======
  return (
    // No `overflow`/`max-height` here: the list scrolls with the page, and an
    // `overflow` value would turn this into a scrollport, which silently kills the
    // sticky column header below.
    <div className="rounded-2xl border border-border/40 bg-surface">
      {/* Column header — parks under the mobile app chrome while the page scrolls. */}
      <div
        className={cn(
          "sticky z-10 grid grid-cols-[32px_1fr_72px] sm:grid-cols-[32px_2fr_100px_44px] md:grid-cols-[32px_2fr_100px_1fr_44px] lg:grid-cols-[32px_2fr_100px_1fr_120px_44px] items-center rounded-t-2xl border-b border-border/60 bg-muted px-3 sm:px-4 py-2 text-xs text-muted-foreground uppercase tracking-widest font-semibold",
          STICKY_HEADER_TOP
        )}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={allSelected}
          onClick={onSelectAll}
          className="flex cursor-pointer items-center justify-center rounded-[4px] p-1 -m-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label={allSelected ? "Deselect all files" : "Select all files"}
        >
          <div className={cn(
            "flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors",
            allSelected ? "border-accent bg-accent text-on-accent" : "border-border/60 hover:border-accent/60"
          )}>
            {allSelected && <Check aria-hidden className="h-3 w-3" />}
          </div>
        </button>
        <SortHeader label="Name" sortKey="name" current={sortBy} order={sortOrder} onSort={onSort} />
        <SortHeader label="Size" sortKey="size" current={sortBy} order={sortOrder} onSort={onSort} />
        <span className="hidden sm:block">
          <SortHeader label="Modified" sortKey="date" current={sortBy} order={sortOrder} onSort={onSort} />
        </span>
        <span className="hidden md:block">
          <SortHeader label="Type" sortKey="type" current={sortBy} order={sortOrder} onSort={onSort} />
        </span>
        <span className="hidden lg:block" />
      </div>

      {/* Virtual list */}
      <div
        ref={listRef}
        className="relative overflow-hidden rounded-b-2xl"
        style={{ height: `${listVirtualizer.getTotalSize()}px` }}
      >
        {listVirtualizer.getVirtualItems().map((virtualItem) => {
          const offsetY = virtualItem.start - listVirtualizer.options.scrollMargin;

          if (virtualItem.index >= sorted.length) {
            return (
              <div
                key="loader"
                ref={loadMoreRef}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${offsetY}px)`,
                }}
                className="flex items-center justify-center text-xs text-muted-foreground"
              >
                {loadingMore ? (
                  <div className="flex items-center gap-2" role="status">
                    <Spinner size="xs" />
                    Loading more…
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={loadMore} className="cursor-pointer">Load more</Button>
                )}
              </div>
            );
          }

          const file = sorted[virtualItem.index];
          const selected = selectedIds.has(file.id);
          return (
            <ListRow
              key={file.id}
              file={file}
              selected={selected}
              trash={trash}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${offsetY}px)`,
              }}
              onFileAction={onFileAction}
              onFileClick={onFileClick}
              onSelect={onSelect}
              caps={caps}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Drag source ────────────────────────────────────────────────────────────

/**
 * Makes a row draggable onto a folder card, a breadcrumb, or the folder tree.
 *
 * Only the node ref and the listeners are taken. `attributes` is deliberately left
 * unused: it puts `role="button"` on the row, and Chrome and Safari treat such a node
 * as having presentational children, which would drop the selection checkbox and the
 * action menu out of the accessibility tree — the same reason the row root is a plain
 * `<div>` today. Dragging stays a pointer convenience; the equivalents that need no
 * mouse are "Move to…" (M) and Ctrl+X / Ctrl+V, and they stay the documented path.
 *
 * Nothing is dragged out of the recycle bin, and nothing at all where the viewer may
 * not write: a drag that can only end in a refusal is worse than no drag at all.
 */
function useRowDrag(file: FileRecord, caps: FileGridCaps, trash: boolean | undefined) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: file.id,
    disabled: !caps.canEdit || !!trash,
    data: { kind: "file", name: file.name } satisfies DragData,
  });

  return {
    setNodeRef,
    isDragging,
    /**
     * Composed with the row's own handler instead of spread over it: dnd-kit's mouse
     * activator IS `onMouseDown`, so `{...listeners}` would silently replace the guard
     * that keeps middle- and right-clicks from reaching the page behind the row.
     */
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0) {
        e.stopPropagation();
        return;
      }
      listeners?.onMouseDown?.(e);
    },
  };
}

// ─── Grid Card ──────────────────────────────────────────────────────────────

const GridCard = memo(function GridCard({
  file, selected, trash, onFileAction, onFileClick, onSelect, caps,
}: {
  file: FileRecord; selected: boolean;
  trash?: boolean; onFileAction: (a: string, f: FileRecord) => void;
  onFileClick: (f: FileRecord) => void; onSelect: (id: string, shiftKey?: boolean) => void;
  caps: FileGridCaps;
}) {
  const [hoverInfo, setHoverInfo] = useState(false);
  const ctxMenu = useContextMenu();
  const drag = useRowDrag(file, caps, trash);
  const cat = getMimeCategory(file.mimeType);
  const isVideo = cat === "video";
  const isAudio = cat === "audio";

  return (
    // IMPORTANT: No overflow-hidden on root — badges need to overflow the card corner
    // and HoverInfoCard needs to render below the card boundary.
    // The thumbnail section has its own overflow-hidden + matching border-radius.
    <div
      ref={drag.setNodeRef}
      className={cn(
        "group relative rounded-2xl bg-surface cursor-pointer",
        "transition-[transform,box-shadow,opacity] duration-200 ease-out",
        "active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
        selected
          ? "ring-2 ring-accent/50 ring-offset-2 ring-offset-background shadow-lg shadow-accent/8"
          : "ring-1 ring-border/50 hover:-translate-y-0.5 hover:shadow-lg hover:ring-border/80",
        // The card stays in place at reduced opacity while the overlay carries the
        // visual under the pointer, so the listing never reflows mid-drag.
        drag.isDragging && "opacity-40"
      )}
      onClick={(e) => {
        if (e.button !== 0) return;
        onFileClick(file);
      }}
      onMouseDown={drag.onMouseDown}
      onAuxClick={(e) => {
        if (e.button !== 0) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onContextMenu={(e) => {
        ctxMenu.onContextMenu(e);
        if (!selected) onSelect(file.id);
      }}
      onMouseEnter={() => setHoverInfo(true)}
      onMouseLeave={() => setHoverInfo(false)}
    >
      {/* Corner badges — intentionally overflow the card. Each carries its own
          sr-only text: an icon in a coloured circle says nothing out loud. */}
      {file.isFavorite && (
        <div className="absolute -top-1.5 -right-1.5 z-30 flex h-5 w-5 items-center justify-center rounded-full bg-warning shadow-md ring-2 ring-background">
          <Star className="h-2.5 w-2.5 fill-on-warning text-on-warning" aria-hidden="true" />
          <span className="sr-only">Favorite</span>
        </div>
      )}
      {file.encrypted && (
        <div
          className={cn(
            "absolute -top-1.5 z-30 flex h-5 w-5 items-center justify-center rounded-full bg-accent shadow-md ring-2 ring-background",
            file.isFavorite ? "-right-1.5 translate-x-[-20px]" : "-right-1.5"
          )}
        >
          <Lock className="h-2.5 w-2.5 text-on-accent" aria-hidden="true" />
          <span className="sr-only">Encrypted with AES-256</span>
        </div>
      )}

      {/* Selection checkbox — visible on mobile, hover on desktop.
          The ::after ring widens the touch target to 44px without growing the
          28px box, which would swallow the thumbnail underneath it. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={(e) => { e.stopPropagation(); onSelect(file.id, e.shiftKey); }}
        className={cn(
          "absolute top-2 left-2 z-30 flex h-7 w-7 items-center justify-center rounded-lg transition-all duration-150",
          "after:absolute after:-inset-2 after:content-['']",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          selected
            ? "bg-accent text-on-accent shadow-md"
            : "bg-black/35 backdrop-blur-sm text-transparent border border-white/25 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
        )}
        aria-label={`Select ${file.name}`}
      >
        {selected && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>

      <ThumbnailCard file={file}>
        {isVideo && <VideoOverlay file={file} hovered={hoverInfo} />}
        {isAudio && <AudioOverlay mimeType={file.mimeType} />}
        {/* Reachable by touch and by keyboard, not hover alone. */}
        <div
          className="absolute right-2 bottom-2 z-30 flex items-center opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <CardActions file={file} trash={trash} onAction={onFileAction} caps={caps} />
        </div>
      </ThumbnailCard>

      {/* Meta */}
      <div className="px-2.5 pt-2 pb-2.5">
        {/* The card is a <div> with onClick, which no keyboard can reach. The name
            is a real button so the file opens with Tab + Enter. (role="button" on
            the card root would be worse: Chrome and Safari treat such a node as
            having presentational children and would drop the checkbox and the
            action menu from the accessibility tree.) */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFileClick(file); }}
          aria-label={`Open ${file.name}`}
          className="block w-full truncate rounded text-left text-sm font-medium leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {file.name}
        </button>
        <div className="mt-1 flex items-center justify-between">
          <span className="font-mono text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
          {file.isNote
            ? <span className="rounded bg-accent/12 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-ink">Note</span>
            : <span className="text-xs text-muted-foreground">{formatDate(file.updatedAt, "short")}</span>
          }
        </div>
      </div>

      {/* Hover info — renders below card, now visible since no overflow-hidden on root */}
      {hoverInfo && <HoverInfoCard file={file} />}

      {/* Right-click context menu */}
      <FloatingActionMenu
        open={ctxMenu.open}
        onClose={ctxMenu.close}
        anchorPoint={ctxMenu.point}
        items={buildFileMenuItems(file, trash, onFileAction, caps)}
        placement="context"
        menuLabel={`Actions for ${file.name}`}
        header={{ title: file.name, subtitle: `${getTypeLabel(file.mimeType)} · ${formatBytes(file.sizeBytes)}` }}
      />
    </div>
  );
});

// ─── List Row ───────────────────────────────────────────────────────────────

const ListRow = memo(function ListRow({
  file, selected, trash, style, onFileAction, onFileClick, onSelect, caps,
}: {
  file: FileRecord; selected: boolean; trash?: boolean;
  style: React.CSSProperties; onFileAction: (a: string, f: FileRecord) => void;
  onFileClick: (f: FileRecord) => void; onSelect: (id: string, shiftKey?: boolean) => void;
  caps: FileGridCaps;
}) {
  const menu = useFloatingMenu();
  const ctxMenu = useContextMenu();
  const drag = useRowDrag(file, caps, trash);
  const hasThumb = !!file.thumbnailKey;
  const menuItems = buildFileMenuItems(file, trash, onFileAction, caps);

  return (
    <div
      ref={drag.setNodeRef}
      style={style}
      className={cn(
        "grid grid-cols-[32px_1fr_72px] sm:grid-cols-[32px_2fr_100px_44px] md:grid-cols-[32px_2fr_100px_1fr_44px] lg:grid-cols-[32px_2fr_100px_1fr_120px_44px]",
        "items-center px-3 sm:px-4 border-b border-border/40 transition-colors cursor-pointer",
        selected ? "bg-accent/5" : "hover:bg-muted/40",
        drag.isDragging && "opacity-40"
      )}
      onClick={(e) => {
        if (e.button !== 0) return;
        onFileClick(file);
      }}
      onMouseDown={drag.onMouseDown}
      onAuxClick={(e) => {
        if (e.button !== 0) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onContextMenu={(e) => {
        ctxMenu.onContextMenu(e);
        if (!selected) onSelect(file.id);
      }}
    >
      {/* Checkbox — the 16px box is the visual, the button around it is the target. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={(e) => { e.stopPropagation(); onSelect(file.id, e.shiftKey); }}
        className="-ml-1 flex min-h-11 items-center justify-center rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label={`Select ${file.name}`}
      >
        <div className={cn(
          "flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors",
          selected ? "border-accent bg-accent text-on-accent" : "border-border/50 text-transparent hover:border-accent/50"
        )}>
          {selected && <Check className="h-3 w-3" aria-hidden="true" />}
        </div>
      </button>

      {/* Name + icon */}
      <div className="flex items-center gap-2.5 min-w-0 py-2 pr-2 sm:pr-4">
        <div className="shrink-0 h-9 w-9 rounded-lg overflow-hidden relative">
          {hasThumb ? (
            <img
              src={`/api/files/${file.id}/thumbnail?size=150`}
              // Decorative: the name sits right beside it, and a screen reader
              // reading the filename twice per row is noise, not information.
              alt=""
              loading="lazy"
              decoding="async"
              // Without this the browser starts its own native image drag, which the
              // page reads as an incoming upload and answers with the drop overlay.
              draggable={false}
              width={36}
              height={36}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className={cn("w-full h-full flex items-center justify-center bg-gradient-to-br", getGradientFallback(file.mimeType))}>
              <FileIcon mimeType={file.mimeType} className={cn("h-4 w-4", getAccentColor(file.mimeType))} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {/* Real button, same reasoning as the grid card: the row itself is a
              <div> and cannot be tabbed to. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onFileClick(file); }}
            aria-label={`Open ${file.name}`}
            className="block w-full truncate rounded text-left text-sm font-medium leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {file.name}
          </button>
          <span className="text-xs text-muted-foreground sm:hidden">
            {formatBytes(file.sizeBytes)} · {getTypeLabel(file.mimeType)}
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
          {file.isFavorite && (
            <>
              <Star className="h-3 w-3 fill-warning text-warning-ink" aria-hidden="true" />
              <span className="sr-only">Favorite</span>
            </>
          )}
          {file.encrypted && (
            <>
              <Lock className="h-3 w-3 text-accent-ink" aria-hidden="true" />
              <span className="sr-only">Encrypted</span>
            </>
          )}
          {file.isNote && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-ink">Note</span>}
        </div>
      </div>

      {/* Size */}
      <span className="font-mono text-xs text-muted-foreground truncate hidden sm:block">{formatBytes(file.sizeBytes)}</span>
      {/* Modified */}
      <span className="text-xs text-muted-foreground truncate hidden sm:block">{formatDate(file.updatedAt, "short")}</span>
      {/* Type */}
      <span className="text-xs text-muted-foreground truncate hidden lg:block">{getTypeLabel(file.mimeType)}</span>

      {/* Actions */}
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Button
          ref={menu.anchorRef}
          variant="ghost" size="icon"
          className="h-9 w-9 sm:h-8 sm:w-8 rounded-lg text-muted-foreground hover:text-foreground"
          onClick={() => menu.toggle(file.id)}
          aria-label={`More actions for ${file.name}`}
          aria-expanded={menu.isOpen(file.id)}
        >
          <MoreHorizontal className="h-4 w-4 sm:h-3.5 sm:w-3.5" aria-hidden="true" />
        </Button>
        <FloatingActionMenu
          open={menu.isOpen(file.id)}
          onClose={menu.close}
          anchorRef={menu.anchorRef}
          items={menuItems}
          align="end"
        />
      </div>

      {/* Right-click context menu */}
      <FloatingActionMenu
        open={ctxMenu.open}
        onClose={ctxMenu.close}
        anchorPoint={ctxMenu.point}
        items={menuItems}
        placement="context"
        menuLabel={`Actions for ${file.name}`}
        header={{ title: file.name, subtitle: `${getTypeLabel(file.mimeType)} · ${formatBytes(file.sizeBytes)}` }}
      />
    </div>
  );
});

// ─── Thumbnail card ─────────────────────────────────────────────────────────

function ThumbnailCard({ file, children }: { file: FileRecord; children: React.ReactNode }) {
  const hasThumb = !!file.thumbnailKey;
  const { containerRef, currentSrc, loaded, setLoaded, error, setError } = useThumbnail(file.id, hasThumb);

  return (
    // overflow-hidden here clips the thumbnail to the card's top border-radius.
    // The card root itself has no overflow-hidden so badges and HoverInfoCard can escape.
    <div ref={containerRef} className="relative w-full aspect-[4/3] overflow-hidden rounded-t-2xl">
      {hasThumb && !loaded && !error && (
        <div className="absolute inset-0 bg-gradient-to-br from-muted/50 to-muted/80 animate-pulse" />
      )}
      {(!hasThumb || error) && (
        <div className={cn(
          "absolute inset-0 flex items-center justify-center bg-gradient-to-br",
          getGradientFallback(file.mimeType)
        )}>
          <FileIcon mimeType={file.mimeType} className={cn("h-12 w-12 opacity-60", getAccentColor(file.mimeType))} />
        </div>
      )}
      {currentSrc && !error && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentSrc}
          // Decorative: the filename is rendered directly below the thumbnail.
          alt=""
          loading="lazy"
          decoding="async"
          // See the list row: a native image drag would be mistaken for an upload.
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={cn(
            "absolute inset-0 w-full h-full object-cover transition-all duration-300",
            loaded ? "opacity-100 scale-100" : "opacity-0 scale-105"
          )}
        />
      )}
      {children}
    </div>
  );
}

// ─── Card actions ────────────────────────────────────────────────────────────

function CardActions({ file, trash, onAction, caps }: {
  file: FileRecord; trash?: boolean;
  onAction: (action: string, file: FileRecord) => void;
  caps: FileGridCaps;
}) {
  const menu = useFloatingMenu();
  const menuItems = buildFileMenuItems(file, trash, onAction, caps);

  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost" size="icon-sm"
          className="h-8 w-8 rounded-lg bg-surface/90 backdrop-blur-sm border border-border/40 text-muted-foreground hover:text-foreground shadow-sm"
          onClick={() => onAction("download", file)}
          title="Download"
          aria-label="Download"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          ref={menu.anchorRef}
          variant="ghost" size="icon-sm"
          className={cn(
            "h-8 w-8 rounded-lg bg-surface/90 backdrop-blur-sm border border-border/40 text-muted-foreground hover:text-foreground shadow-sm",
            menu.isOpen(file.id) && "border-accent/40 bg-surface-elevated text-foreground"
          )}
          onClick={() => menu.toggle(file.id)}
          title="More actions"
          aria-label="More actions"
          aria-expanded={menu.isOpen(file.id)}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      <FloatingActionMenu
        open={menu.isOpen(file.id)}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        items={menuItems}
        align="end"
      />
    </>
  );
}

// ─── Video / Audio overlays ─────────────────────────────────────────────────

function VideoOverlay({ file, hovered = false }: { file: FileRecord; hovered?: boolean }) {
  const [loadError, setLoadError] = useState(false);
  const reduceMotion = useReducedMotion();
  // A preview that starts playing under the pointer is motion nobody asked for.
  // With reduced motion the thumbnail stays still and only the badge reacts.
  const previewing = hovered && !reduceMotion && !loadError;

  return (
    <>
      {previewing && (
        // autoPlay, not a play() call from an effect: the element exists only
        // while it should be playing, so the old "pause on unhover" branch could
        // never run — React had already unmounted the node it wanted to pause.
        // muted + autoPlay is also the combination browsers allow without a gesture.
        <video
          src={`/api/files/${file.id}/preview`}
          autoPlay
          muted
          loop
          playsInline
          onError={() => setLoadError(true)}
          className="absolute inset-0 w-full h-full object-cover z-10"
        />
      )}
      <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
        <div className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm transition-all duration-200 motion-reduce:transition-none",
          hovered ? "scale-110 bg-black/60" : "scale-100"
        )}>
          <Play className="h-4 w-4 text-white ml-0.5" fill="white" aria-hidden="true" />
        </div>
      </div>
    </>
  );
}

function AudioOverlay({ mimeType }: { mimeType: string }) {
  // The hue comes from the shared file-type palette rather than a second
  // hardcoded emerald, so audio reads the same here as it does everywhere else.
  const accent = getAccentColor(mimeType);
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className={cn("flex h-14 w-14 items-center justify-center rounded-full bg-current/15 backdrop-blur-sm", accent)}>
        <Music className="h-7 w-7" aria-hidden="true" />
      </div>
    </div>
  );
}
