"use client";

/**
 * The folder tree pane for `/files`.
 *
 * Everything that can be decided without a DOM lives in `lib/files/folder-tree.ts`;
 * this file fetches children, draws rows, and performs what a key press resolved to.
 *
 * Children arrive one parent at a time, so the pane fans out `useQueries` over the
 * parents it currently needs — the same query options the grid uses, so the two share
 * one cache and one invalidation.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useDroppable } from "@dnd-kit/core";
import { ChevronRight, Folder, FolderOpen, House, PanelLeftClose } from "lucide-react";
import { folderChildrenQuery } from "@/hooks/use-folder-children";
import {
  EMPTY_EXPANSION,
  ROOT_KEY,
  TREE_ROOT_DROP_ID,
  childrenKey,
  flattenTree,
  isFolderExpanded,
  openParentIds,
  resolveTreeKey,
  toggleFolderExpansion,
  type ExpansionState,
  type TreeFolder,
  type TreeRoot,
  type TreeRow,
} from "@/lib/files/folder-tree";
import {
  TREE_WIDTH_MAX,
  TREE_WIDTH_MIN,
  clampTreeWidth,
} from "@/lib/files/view-prefs";
import { cn } from "@/lib/utils";

/** Row height is fixed so the indent guides line up and scrolling stays predictable. */
const ROW = "flex h-8 w-full items-center gap-1 rounded-md pr-2 text-sm transition-colors";
const INDENT = 14;
const RESIZE_STEP = 16;

type RowProps = {
  row: TreeRow;
  href: string;
  /** The folder being browsed. Only ever one row, and it is the one scrolled to. */
  active: boolean;
  /** Holds the pane's single tab stop; see `focusedId` below. */
  focused: boolean;
  droppable: boolean;
  onToggle: (row: TreeRow) => void;
  onFocus: (id: string) => void;
};

function TreeRowItem({ row, href, active, focused, droppable, onToggle, onFocus }: RowProps) {
  const { isOver, setNodeRef } = useDroppable({ id: row.id, disabled: !droppable });
  // A folder with nothing inside gets no chevron; one that has not been fetched keeps
  // its chevron, because the only way to find out is to open it.
  const twisty = row.hasChildren !== false;

  return (
    <Link
      ref={setNodeRef}
      href={href}
      data-tree-id={row.id}
      role="treeitem"
      // The rows are flattened, so depth is carried by `aria-level` rather than by
      // nested groups. Level 1 is the root row above them.
      aria-level={row.depth + 2}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={twisty ? row.expanded : undefined}
      aria-current={active ? "page" : undefined}
      tabIndex={focused ? 0 : -1}
      title={row.name}
      onClick={() => onFocus(row.id)}
      style={{ paddingLeft: 4 + row.depth * INDENT }}
      className={cn(
        ROW,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        active
          ? "bg-accent/12 font-medium text-accent-ink"
          : "text-foreground/85 hover:bg-surface-hover hover:text-foreground",
        isOver && "ring-2 ring-accent ring-offset-0"
      )}
    >
      {/* Not a button: a button inside a link is invalid, and the keyboard already
          has Right/Left for opening and closing. Pointer users get the chevron. */}
      <span
        aria-hidden
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle(row);
        }}
        className={cn(
          "flex h-6 w-5 shrink-0 items-center justify-center rounded",
          twisty ? "cursor-pointer hover:bg-muted" : "pointer-events-none opacity-0"
        )}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", row.expanded && "rotate-90")}
        />
      </span>
      {row.expanded && row.hasChildren ? (
        <FolderOpen aria-hidden className="h-4 w-4 shrink-0 text-accent-ink" />
      ) : (
        <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{row.name}</span>
    </Link>
  );
}

/**
 * "My Files" (or the shared folder the pane is rooted at).
 *
 * A row of its own rather than a header, so it is a drop target meaning "out of every
 * folder" and a keyboard stop above the first folder.
 */
function RootRow({
  name,
  href,
  dropId,
  active,
  focused,
  droppable,
  onFocus,
}: {
  name: string;
  href: string;
  /**
   * What a drop here means. At the account root that is the sentinel for "out of every
   * folder"; inside a share it is the shared folder's own id — moving a borrowed file to
   * the viewer's private root is refused by the server, so it is not offered here.
   */
  dropId: string;
  active: boolean;
  focused: boolean;
  droppable: boolean;
  onFocus: (id: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: dropId, disabled: !droppable });

  return (
    <Link
      ref={setNodeRef}
      href={href}
      data-tree-id={ROOT_KEY}
      role="treeitem"
      aria-level={1}
      aria-posinset={1}
      aria-setsize={1}
      aria-expanded
      aria-current={active ? "page" : undefined}
      tabIndex={focused ? 0 : -1}
      onClick={() => onFocus(ROOT_KEY)}
      className={cn(
        ROW,
        "pl-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        active
          ? "bg-accent/12 font-medium text-accent-ink"
          : "text-foreground/85 hover:bg-surface-hover hover:text-foreground",
        isOver && "ring-2 ring-accent"
      )}
    >
      <House aria-hidden className="h-4 w-4 shrink-0" />
      <span className="truncate">{name}</span>
    </Link>
  );
}

/**
 * The drag edge between the pane and the listing.
 *
 * Pointer capture rather than window listeners: the pointer regularly leaves a 4px
 * strip mid-drag, and capture keeps the moves coming without a global handler that
 * has to be torn down. Arrow keys move it too, so the width is not mouse-only.
 */
function ResizeHandle({
  width,
  onWidthChange,
  onWidthCommit,
}: {
  width: number;
  onWidthChange: (px: number) => void;
  onWidthCommit: (px: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize folder tree"
      aria-valuenow={width}
      aria-valuemin={TREE_WIDTH_MIN}
      aria-valuemax={TREE_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const from = start.current;
        if (!from) return;
        onWidthChange(clampTreeWidth(from.width + (e.clientX - from.x)));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onWidthCommit(width);
      }}
      onLostPointerCapture={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowLeft" ? -RESIZE_STEP : e.key === "ArrowRight" ? RESIZE_STEP : 0;
        if (!delta) return;
        e.preventDefault();
        const next = clampTreeWidth(width + delta);
        onWidthChange(next);
        onWidthCommit(next);
      }}
      className="group relative w-1 shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent"
      />
    </div>
  );
}

export type FolderTreeSidebarProps = {
  /** What the pane is rooted at: the account root, or the folder that was shared. */
  root: TreeRoot;
  /** The folder being browsed, so its row can be marked and its path opened. */
  currentFolderId: string | null;
  /** The current folder's chain, itself included — from the breadcrumb's cached path. */
  openPath: readonly string[];
  /** `null` means the root: a share stays on `/shared-with-me/<id>`. */
  hrefFor: (folderId: string | null) => string;
  width: number;
  onWidthChange: (px: number) => void;
  onWidthCommit: (px: number) => void;
  onCollapse: () => void;
  /** Whether a drop here could actually move anything. */
  droppable?: boolean;
};

export function FolderTreeSidebar({
  root,
  currentFolderId,
  openPath,
  hrefFor,
  width,
  onWidthChange,
  onWidthCommit,
  onCollapse,
  droppable = false,
}: FolderTreeSidebarProps) {
  const router = useRouter();
  const [expansion, setExpansion] = useState<ExpansionState>(EMPTY_EXPANSION);
  const [focused, setFocused] = useState<string>(ROOT_KEY);
  const treeRef = useRef<HTMLDivElement>(null);

  const rootId = root.id;
  const rootName = root.name;

  const ancestors = useMemo(() => new Set(openPath), [openPath]);
  const parents = useMemo(
    () => openParentIds({ root: { id: rootId, name: rootName }, state: expansion, ancestors }),
    [rootId, rootName, expansion, ancestors]
  );

  // One request per open parent, sharing the grid's cache entries. A folder closed
  // again keeps its response in the cache, so re-opening it draws instantly.
  const results = useQueries({
    queries: parents.map((id) => ({ ...folderChildrenQuery(id), staleTime: 15_000 })),
  });

  const childrenByParent = useMemo(() => {
    const map = new Map<string, readonly TreeFolder[]>();
    parents.forEach((parentId, i) => {
      const data = results[i]?.data;
      if (!data) return;
      map.set(
        childrenKey(parentId),
        data.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId }))
      );
    });
    return map;
  }, [parents, results]);

  const isExpanded = useCallback(
    (id: string) => isFolderExpanded(expansion, id, ancestors),
    [expansion, ancestors]
  );

  const { rows, truncated } = useMemo(
    () => flattenTree({ root: { id: rootId, name: rootName }, childrenByParent, isExpanded }),
    [rootId, rootName, childrenByParent, isExpanded]
  );

  // The pane keeps ONE tab stop. If the focused row has since been collapsed away or
  // deleted, the stop falls back to the root row — derived here rather than repaired in
  // an effect, so there is never a render with no tab stop at all.
  const focusedId =
    focused === ROOT_KEY || rows.some((row) => row.id === focused) ? focused : ROOT_KEY;

  const focusRow = useCallback((id: string) => {
    setFocused(id);
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)
      ?.focus();
  }, []);

  const toggle = useCallback((row: TreeRow) => {
    setExpansion((state) => toggleFolderExpansion(state, row.id, row.expanded));
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Leave shortcuts to the page: Ctrl/Cmd+Arrow is not tree navigation.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const action = resolveTreeKey(e.key, focusedId, rows);
    if (action.type === "none") return;
    e.preventDefault();
    switch (action.type) {
      case "focus":
        focusRow(action.id);
        break;
      case "expand":
        setExpansion((state) => toggleFolderExpansion(state, action.id, false));
        break;
      case "collapse":
        setExpansion((state) => toggleFolderExpansion(state, action.id, true));
        break;
      case "open":
        router.push(hrefFor(action.id === ROOT_KEY ? rootId : action.id));
        break;
    }
  };

  const loading = results.some((r) => r.isPending);

  // A deep link into a nested folder opens its whole path, which can put the row well
  // below the fold. `block: "nearest"` is deliberate: a row already on screen is left
  // exactly where it is, so opening a branch never yanks the pane around.
  useEffect(() => {
    if (!currentFolderId) return;
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(currentFolderId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [currentFolderId, rows]);

  return (
    <aside
      aria-label="Folder tree"
      style={{ width }}
      className="sticky top-4 hidden max-h-[calc(100vh-7rem)] shrink-0 xl:flex"
    >
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border-light px-2.5">
          <span className="truncate text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Folders
          </span>
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide folder tree"
            className="-mr-1 inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <PanelLeftClose aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* One keydown handler for the whole tree: the rows are one widget with one tab
            stop, so the keys are resolved against the row list rather than per row. */}
        <div
          ref={treeRef}
          role="tree"
          aria-label="Folders"
          aria-busy={loading || undefined}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5"
        >
          <RootRow
            name={rootName}
            href={hrefFor(rootId)}
            dropId={rootId ?? TREE_ROOT_DROP_ID}
            active={currentFolderId === rootId}
            focused={focusedId === ROOT_KEY}
            droppable={droppable}
            onFocus={focusRow}
          />
          {rows.map((row) => (
            <TreeRowItem
              key={row.id}
              row={row}
              href={hrefFor(row.id)}
              active={row.id === currentFolderId}
              focused={focusedId === row.id}
              droppable={droppable}
              onToggle={toggle}
              onFocus={focusRow}
            />
          ))}
          {rows.length === 0 && !loading && (
            <p className="px-2 py-2.5 text-xs text-muted-foreground">No folders here.</p>
          )}
          {truncated && (
            <p className="px-2 py-2.5 text-xs text-muted-foreground">
              Only the first folders are listed. Close a branch to see more.
            </p>
          )}
        </div>
      </div>

      <ResizeHandle width={width} onWidthChange={onWidthChange} onWidthCommit={onWidthCommit} />
    </aside>
  );
}
