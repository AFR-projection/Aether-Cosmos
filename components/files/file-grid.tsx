"use client";

import { useRef, useState, useEffect, useMemo, memo, useSyncExternalStore } from "react";
import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  FileText, Image, Film, Music, FileArchive, File,
  Star, Trash2, Copy, CopyPlus, Scissors, RotateCcw, Pencil, MoreHorizontal, Download,
  Play, Share2, Check, Lock, FolderInput,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { cn, formatBytes, formatDate, getMimeCategory } from "@/lib/utils";
import { sortFiles } from "@/lib/files/sort";
import { Button } from "@/components/ui/button";
import { FloatingActionMenu, useFloatingMenu, type FloatingMenuItem } from "@/components/ui/floating-action-menu";
import type { File as FileRecord } from "@/lib/db/schema";
import { Spinner } from "@/components/system/spinner";
import { isLiteMode } from "@/lib/system/lite-mode";

const ROW_HEIGHT = 56;
const OVERSCAN = 8;

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

/** Height of the name/size block under each thumbnail (px-3 py-2.5). */
const CARD_META_HEIGHT = 56;
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

// ─── Right-click context menu hook ────────────────────────────────────────────
// Places a zero-size fixed anchor at the cursor so FloatingActionMenu can position
// its popover exactly where the user right-clicked.
function useContextMenu() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
    setOpen(true);
  };

  const anchorStyle: React.CSSProperties = {
    position: "fixed",
    left: pos.x,
    top: pos.y,
    width: 0,
    height: 0,
    pointerEvents: "none",
  };

  return { anchorRef, open, close: () => setOpen(false), onContextMenu, anchorStyle };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  const cat = getMimeCategory(mimeType);
  const icons: Record<string, typeof File> = {
    image: Image, video: Film, audio: Music, pdf: FileText,
    document: FileText, spreadsheet: FileText, presentation: FileText,
    archive: FileArchive, text: FileText,
  };
  const Icon = icons[cat] ?? File;
  return <Icon className={className} />;
}

function getAccentColor(mimeType: string): string {
  const c: Record<string, string> = {
    image: "text-violet-500", video: "text-blue-500", audio: "text-emerald-500",
    pdf: "text-red-500", document: "text-sky-500", spreadsheet: "text-green-500",
    presentation: "text-orange-500", archive: "text-amber-500", text: "text-gray-500",
  };
  return c[getMimeCategory(mimeType)] ?? "text-gray-400";
}

function getGradientFallback(mimeType: string): string {
  const g: Record<string, string> = {
    image: "from-violet-500/20 to-fuchsia-500/10",
    video: "from-blue-500/20 to-cyan-500/10",
    audio: "from-emerald-500/20 to-teal-500/10",
    pdf: "from-red-500/20 to-orange-500/10",
    document: "from-sky-500/20 to-indigo-500/10",
    spreadsheet: "from-green-500/20 to-lime-500/10",
    presentation: "from-orange-500/20 to-amber-500/10",
    archive: "from-amber-500/20 to-yellow-500/10",
    text: "from-gray-500/15 to-zinc-500/10",
  };
  return g[getMimeCategory(mimeType)] ?? "from-gray-500/10 to-zinc-500/5";
}

function getTypeLabel(mimeType: string): string {
  const cat = getMimeCategory(mimeType);
  const labels: Record<string, string> = {
    image: "Image", video: "Video", audio: "Audio", pdf: "PDF",
    document: "Document", spreadsheet: "Sheet", presentation: "Slides",
    archive: "Archive", text: "Text",
  };
  return labels[cat] ?? "File";
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

function buildFileMenuItems(
  file: FileRecord,
  trash: boolean | undefined,
  onAction: (action: string, file: FileRecord) => void
): FloatingMenuItem[] {
  if (trash) {
    return [
      { id: "restore", label: "Restore", icon: RotateCcw, onClick: () => onAction("restore", file) },
      { id: "delete", label: "Delete permanently", icon: Trash2, danger: true, onClick: () => onAction("delete", file) },
    ];
  }
  return [
    { id: "download", label: "Download", icon: Download, onClick: () => onAction("download", file) },
    { id: "share", label: "Share", icon: Share2, onClick: () => onAction("share", file) },
    { id: "clip-copy", label: "Copy", icon: Copy, onClick: () => onAction("clip-copy", file) },
    { id: "clip-cut", label: "Cut", icon: Scissors, onClick: () => onAction("clip-cut", file) },
    { id: "rename", label: "Rename", icon: Pencil, onClick: () => onAction("rename", file) },
    { id: "move", label: "Move to…", icon: FolderInput, onClick: () => onAction("move", file) },
    { id: "favorite", label: file.isFavorite ? "Unfavorite" : "Favorite", icon: Star, onClick: () => onAction("favorite", file) },
    { id: "duplicate", label: "Duplicate", icon: CopyPlus, onClick: () => onAction("duplicate", file) },
    { id: "delete", label: "Move to trash", icon: Trash2, danger: true, onClick: () => onAction("delete", file) },
  ];
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
  return (
    <button
      onClick={() => onSort(sortKey)}
      className={cn(
        "flex items-center gap-1 text-xs font-semibold uppercase tracking-wider transition-colors",
        active ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground/80"
      )}
    >
      {label}
      <span className="inline-flex flex-col leading-none">
        {active && order === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : active && order === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </button>
  );
}

// ─── Hover info card ────────────────────────────────────────────────────────

function HoverInfoCard({ file, style }: { file: FileRecord; style?: React.CSSProperties }) {
  return (
    <div
      style={style}
      className="animate-fade-in-scale absolute z-40 left-1/2 -translate-x-1/2 top-full mt-2 w-72 rounded-2xl border border-border/60 bg-surface-elevated p-4 shadow-xl"
    >
      <div className="flex items-start gap-3 mb-3">
        <div className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br",
          getGradientFallback(file.mimeType)
        )}>
          <FileIcon mimeType={file.mimeType} className={cn("h-5 w-5", getAccentColor(file.mimeType))} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{file.name}</p>
          <p className="text-xs text-muted-foreground/70">{getTypeLabel(file.mimeType)}</p>
        </div>
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground/60">
        <div className="flex justify-between">
          <span>Size</span>
          <span className="font-mono font-medium text-foreground/80">{formatBytes(file.sizeBytes)}</span>
        </div>
        <div className="flex justify-between">
          <span>Modified</span>
          <span>{formatDate(file.updatedAt)}</span>
        </div>
        <div className="flex justify-between">
          <span>Type</span>
          <span>{file.mimeType}</span>
        </div>
        {file.isFavorite && (
          <div className="flex justify-between">
            <span>Favorite</span>
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
          </div>
        )}
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
  hasMore?: boolean;
  loadMore?: () => void;
  loadingMore?: boolean;
}

export function FileGrid({
  files, view, trash = false,
  selectedIds, sortBy, sortOrder,
  onFileAction, onFileClick, onSelect, onSelectAll, onSort,
  hasMore, loadMore, loadingMore,
}: FileGridProps) {
  const allSelected = files.length > 0 && selectedIds.size === files.length;

  // ── Sorted files ──
  const sorted = useMemo(() => sortFiles(files, sortBy, sortOrder), [files, sortBy, sortOrder]);

  // ── Virtual list ──
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length + (hasMore ? 1 : 0),
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  // ── Virtual grid ──
  // The grid scrolls with the document, so it virtualizes against the window
  // and offsets by the container's distance from the top of the page.
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns();
  const [gridWidth, setGridWidth] = useState(0);
  const [gridOffset, setGridOffset] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || view !== "grid") return;
    const measure = () => {
      setGridWidth(el.clientWidth);
      setGridOffset(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    // Only fires on real layout changes (resize / sidebar collapse), not scroll.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  const gridGap = columns >= 3 ? 16 : 12; // gap-3 / sm:gap-4
  const estimatedRowHeight = useMemo(() => {
    const cardWidth =
      gridWidth > 0 ? (gridWidth - gridGap * (columns - 1)) / columns : 168;
    // aspect-[4/3] thumbnail + meta block + row gap
    return Math.round(cardWidth * 0.75 + CARD_META_HEIGHT + gridGap);
  }, [gridWidth, gridGap, columns]);

  const gridRowCount = Math.ceil(sorted.length / columns);
  const gridVirtualizer = useWindowVirtualizer({
    count: gridRowCount,
    estimateSize: () => estimatedRowHeight,
    overscan: GRID_OVERSCAN,
    scrollMargin: gridOffset,
  });

  // Infinite scroll trigger
  const lastItemRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore || !lastItemRef.current || !loadMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { rootMargin: "200px" }
    );
    observer.observe(lastItemRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, sorted.length]);

  // ── Empty ──
  if (files.length === 0) {
    return (
      <div className="animate-fade-in flex flex-col items-center justify-center py-24 text-muted-foreground">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-accent/5 border border-accent/10">
          <File className="h-10 w-10 text-accent/40" />
        </div>
        <p className="text-lg font-semibold">No files here</p>
        <p className="mt-1 text-sm text-muted-foreground/70">
          {trash ? "Recycle bin is empty" : "Upload files or create a note to get started"}
        </p>
      </div>
    );
  }

  // ====== GRID VIEW ======
  if (view === "grid") {
    const virtualRows = gridVirtualizer.getVirtualItems();

    return (
      <div>
        <div
          ref={gridRef}
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
                className="absolute left-0 top-0 w-full"
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
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {hasMore && loadMore && (
          <div ref={lastItemRef} className="flex justify-center py-8">
            {loadingMore ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground/60">
                <Spinner size="xs" />
                Loading more...
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
    <div
      ref={listRef}
      className="rounded-2xl border border-border/50 bg-surface overflow-auto"
      style={{ maxHeight: "calc(100dvh - 16rem)" }}
    >
      {/* Table header */}
      <div className="sticky top-0 z-10 grid grid-cols-[28px_1fr_60px] sm:grid-cols-[28px_2fr_100px_44px] md:grid-cols-[28px_2fr_1fr_1fr_44px] lg:grid-cols-[28px_2fr_1fr_1fr_1fr_44px] border-b border-border/40 bg-muted/80 backdrop-blur-sm px-2 sm:px-4 py-2.5 text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
        <button onClick={onSelectAll} className="flex items-center justify-center">
          <div className={cn(
            "flex h-4 w-4 items-center justify-center rounded border transition-colors",
            allSelected ? "border-accent bg-accent text-white" : "border-border/50 hover:border-accent/50"
          )}>
            {allSelected && <Check className="h-3 w-3" />}
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
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          if (virtualItem.index >= sorted.length) {
            return (
              <div
                key="loader"
                ref={lastItemRef}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                className="flex items-center justify-center text-xs text-muted-foreground/60"
              >
                {loadingMore ? (
                  <div className="flex items-center gap-2">
                    <Spinner size="xs" />
                    Loading more...
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" onClick={loadMore}>Load more</Button>
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
                transform: `translateY(${virtualItem.start}px)`,
              }}
              onFileAction={onFileAction}
              onFileClick={onFileClick}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Grid Card ──────────────────────────────────────────────────────────────

const GridCard = memo(function GridCard({
  file, selected, trash, onFileAction, onFileClick, onSelect,
}: {
  file: FileRecord; selected: boolean;
  trash?: boolean; onFileAction: (a: string, f: FileRecord) => void;
  onFileClick: (f: FileRecord) => void; onSelect: (id: string, shiftKey?: boolean) => void;
}) {
  const [hoverInfo, setHoverInfo] = useState(false);
  const ctxMenu = useContextMenu();
  const cat = getMimeCategory(file.mimeType);
  const isVideo = cat === "video";
  const isAudio = cat === "audio";

  return (
    // Hover lift and press feedback run on transform/opacity only — compositor
    // work, no layout or paint — and there is no mount animation, because cards
    // mount and unmount constantly while the virtualized grid scrolls.
    <div
      className={cn(
        "group relative rounded-2xl border bg-surface overflow-hidden cursor-pointer",
        "transition-[transform,box-shadow,border-color] duration-200 ease-out",
        "active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100",
        selected
          ? "border-accent/50 shadow-md shadow-accent/5 ring-1 ring-accent/20"
          : "border-border/60 hover:-translate-y-1 hover:shadow-lg hover:border-accent/30 hover:shadow-accent/5"
      )}
      onClick={() => onFileClick(file)}
      onContextMenu={ctxMenu.onContextMenu}
      onMouseEnter={() => setHoverInfo(true)}
      onMouseLeave={() => setHoverInfo(false)}
    >
      {/* Selection checkbox — always visible on mobile, hover on desktop */}
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(file.id, e.shiftKey); }}
        className={cn(
          "absolute top-1 left-1 z-30 flex h-9 w-9 sm:h-7 sm:w-7 items-center justify-center rounded-md border transition-all",
          selected
            ? "border-accent bg-accent text-white"
            : "border-white/40 text-transparent opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:border-accent/70"
        )}
        aria-label={selected ? "Deselect file" : "Select file"}
      >
        {selected && <Check className="h-4 w-4 sm:h-3 sm:w-3" />}
      </button>

      {file.isFavorite && (
        <div className="absolute -top-1 -right-1 z-30 flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 shadow-md shadow-amber-400/20">
          <Star className="h-3 w-3 fill-white text-white" />
        </div>
      )}

      {file.encrypted && (
        <div
          className={cn(
            "absolute -top-1 z-30 flex h-6 w-6 items-center justify-center rounded-full bg-accent shadow-md shadow-accent/20",
            file.isFavorite ? "-right-1 translate-x-[-1.6rem]" : "-right-1"
          )}
          title="Encrypted (AES-256)"
        >
          <Lock className="h-3 w-3 text-white" />
        </div>
      )}

      <ThumbnailCard file={file}>
        {isVideo && <VideoOverlay file={file} hovered={hoverInfo} />}
        {isAudio && <AudioOverlay />}

        <div
          className="absolute right-2 bottom-2 z-30 flex md:hidden md:group-hover:flex items-center"
          onClick={(e) => e.stopPropagation()}
        >
          <CardActions file={file} trash={trash} onAction={onFileAction} />
        </div>
      </ThumbnailCard>

      <div className="px-3 py-2.5">
        <p className="truncate text-sm font-semibold leading-tight">{file.name}</p>
        <div className="mt-1 flex items-center justify-between">
          <span className="font-mono text-[11px] text-muted-foreground/70">{formatBytes(file.sizeBytes)}</span>
          <span className="text-[10px] text-muted-foreground/50">{formatDate(file.updatedAt, "short")}</span>
        </div>
      </div>

      {/* Hover info popover */}
      {hoverInfo && <HoverInfoCard file={file} />}

      {/* Right-click context menu */}
      <span ref={ctxMenu.anchorRef} style={ctxMenu.anchorStyle} aria-hidden />
      <FloatingActionMenu
        open={ctxMenu.open}
        onClose={ctxMenu.close}
        anchorRef={ctxMenu.anchorRef}
        items={buildFileMenuItems(file, trash, onFileAction)}
        align="start"
      />
    </div>
  );
});

// ─── List Row ───────────────────────────────────────────────────────────────

const ListRow = memo(function ListRow({
  file, selected, trash, style, onFileAction, onFileClick, onSelect,
}: {
  file: FileRecord; selected: boolean; trash?: boolean;
  style: React.CSSProperties; onFileAction: (a: string, f: FileRecord) => void;
  onFileClick: (f: FileRecord) => void; onSelect: (id: string, shiftKey?: boolean) => void;
}) {
  const menu = useFloatingMenu();
  const ctxMenu = useContextMenu();
  const hasThumb = !!file.thumbnailKey;
  const menuItems = buildFileMenuItems(file, trash, onFileAction);

  return (
    <div
      style={style}
      className={cn(
        "grid grid-cols-[28px_1fr_60px] sm:grid-cols-[28px_2fr_100px_44px] md:grid-cols-[28px_2fr_1fr_1fr_44px] lg:grid-cols-[28px_2fr_1fr_1fr_1fr_44px] items-center gap-0 px-2 sm:px-4 border-b border-border/20 transition-colors text-sm cursor-pointer",
        selected
          ? "bg-accent/5 border-accent/10"
          : "hover:bg-accent/[0.03]"
      )}
      onClick={() => onFileClick(file)}
      onContextMenu={ctxMenu.onContextMenu}
    >
      {/* Checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(file.id, e.shiftKey); }}
        className="flex items-center justify-center p-2 -m-2"
        aria-label={selected ? "Deselect file" : "Select file"}
      >
        <div className={cn(
          "flex h-5 w-5 sm:h-4 sm:w-4 items-center justify-center rounded border transition-colors",
          selected
            ? "border-accent bg-accent text-white"
            : "border-border/50 text-transparent hover:border-accent/50"
        )}>
          {selected && <Check className="h-3.5 w-3.5 sm:h-3 sm:w-3" />}
        </div>
      </button>

      {/* Name */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 pr-1 sm:pr-3">
        <div className="shrink-0 w-8 h-8 rounded-lg overflow-hidden relative">
          {hasThumb ? (
            <img
              // 32px box — 150 is the smallest size the endpoint serves. The old
              // `size=80` was not a served size, so the server silently fell
              // back to 300 for every row.
              src={`/api/files/${file.id}/thumbnail?size=150`}
              alt={file.name}
              loading="lazy"
              decoding="async"
              width={32}
              height={32}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className={cn("w-full h-full flex items-center justify-center bg-gradient-to-br", getGradientFallback(file.mimeType))}>
              <FileIcon mimeType={file.mimeType} className={cn("h-4 w-4", getAccentColor(file.mimeType))} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium block">{file.name}</span>
          <span className="text-[10px] text-muted-foreground/50 sm:hidden">
            {formatBytes(file.sizeBytes)} &middot; {getTypeLabel(file.mimeType)}
          </span>
        </div>
        {file.isFavorite && <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0 hidden sm:block" />}
        {file.encrypted && <Lock className="h-3 w-3 text-accent shrink-0 hidden sm:block" aria-label="Encrypted" />}
        {file.isNote && <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium text-accent hidden sm:block">Note</span>}
      </div>

      {/* Size - hidden on smallest screens */}
      <span className="font-mono text-xs text-muted-foreground/80 truncate hidden sm:block">{formatBytes(file.sizeBytes)}</span>

      {/* Modified - hidden on sm and below */}
      <span className="text-xs text-muted-foreground/70 truncate hidden sm:block md:text-left">{formatDate(file.updatedAt, "short")}</span>

      {/* Type - hidden on md and below */}
      <span className="text-xs text-muted-foreground/60 truncate hidden md:block">{getTypeLabel(file.mimeType)}</span>

      {/* Actions */}
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Button
          ref={menu.anchorRef}
          variant="ghost" size="icon"
          className="h-10 w-10 sm:h-8 sm:w-8 rounded-lg text-muted-foreground/50 hover:text-foreground"
          onClick={() => menu.toggle(file.id)}
          aria-label="More actions"
          aria-expanded={menu.isOpen(file.id)}
        >
          <MoreHorizontal className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
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
      <span ref={ctxMenu.anchorRef} style={ctxMenu.anchorStyle} aria-hidden />
      <FloatingActionMenu
        open={ctxMenu.open}
        onClose={ctxMenu.close}
        anchorRef={ctxMenu.anchorRef}
        items={menuItems}
        align="start"
      />
    </div>
  );
});

// ─── Thumbnail card ─────────────────────────────────────────────────────────

function ThumbnailCard({ file, children }: { file: FileRecord; children: React.ReactNode }) {
  const hasThumb = !!file.thumbnailKey;
  const { containerRef, currentSrc, loaded, setLoaded, error, setError } = useThumbnail(file.id, hasThumb);

  return (
    <div ref={containerRef} className="relative w-full aspect-[4/3] overflow-hidden rounded-t-[14px]">
      {hasThumb && !loaded && !error && (
        <div className="absolute inset-0 bg-gradient-to-br from-muted/50 to-muted/80 animate-pulse" />
      )}
      {(!hasThumb || error) && (
        <div className={cn(
          "absolute inset-0 flex items-center justify-center bg-gradient-to-br",
          getGradientFallback(file.mimeType)
        )}>
          <FileIcon mimeType={file.mimeType} className={cn("h-12 w-12 opacity-40", getAccentColor(file.mimeType))} />
        </div>
      )}
      {currentSrc && !error && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentSrc}
          alt={file.name}
          loading="lazy"
          decoding="async"
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

function CardActions({ file, trash, onAction }: {
  file: FileRecord; trash?: boolean;
  onAction: (action: string, file: FileRecord) => void;
}) {
  const menu = useFloatingMenu();
  const menuItems = buildFileMenuItems(file, trash, onAction);

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const el = videoRef.current;
    if (!el || loadError) return;

    if (hovered) {
      el.currentTime = 0;
      playPromiseRef.current = el.play();
      playPromiseRef.current?.catch(() => {});
    } else {
      if (playPromiseRef.current) {
        playPromiseRef.current.then(() => {
          if (!cancelled) { el.pause(); el.currentTime = 0; }
        }).catch(() => {});
        playPromiseRef.current = null;
      } else {
        el.pause();
        el.currentTime = 0;
      }
    }

    return () => { cancelled = true; };
  }, [hovered, loadError]);

  return (
    <>
      {hovered && !loadError && (
        <video
          ref={videoRef}
          src={`/api/files/${file.id}/preview`}
          muted
          loop
          playsInline
          onError={() => setLoadError(true)}
          className="absolute inset-0 w-full h-full object-cover z-10"
        />
      )}
      <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
        <div className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm transition-all duration-200",
          hovered ? "scale-110 bg-black/60" : "scale-100"
        )}>
          <Play className="h-4 w-4 text-white ml-0.5" fill="white" />
        </div>
      </div>
    </>
  );
}

function AudioOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/20 backdrop-blur-sm">
        <Music className="h-7 w-7 text-emerald-500" />
      </div>
    </div>
  );
}
