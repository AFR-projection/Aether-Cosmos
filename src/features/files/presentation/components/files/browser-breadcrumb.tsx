"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDroppable } from "@dnd-kit/core";
import { ChevronRight, Folder as FolderIcon, House, MoreHorizontal } from "lucide-react";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import { TREE_ROOT_DROP_ID } from "@files/domain/services/folder-tree";
import {
  FloatingActionMenu,
  useFloatingMenu,
  type FloatingMenuItem,
} from "@/ui/primitives/floating-action-menu";

export type FolderCrumb = { id: string; name: string };

type PathResponse = { crumbs: FolderCrumb[]; trimmed: boolean };

/**
 * The ancestor chain of the folder currently being browsed.
 *
 * Shared with the page header so both read one cached response: a deep link into
 * `/files?folder=<id>` carries no folder name, and the listing endpoints only ever
 * return a folder's children.
 */
export function useFolderPath(folderId: string | null) {
  return useQuery({
    queryKey: ["folder-path", folderId],
    queryFn: async () => {
      const res = await apiFetch<PathResponse>(`/api/folders/${folderId}/path`);
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load folder path");
      return res.data;
    },
    enabled: !!folderId,
    staleTime: 60_000,
  });
}

/** Crumbs kept visible either side of the overflow menu. */
const HEAD_KEEP = 1;
const TAIL_KEEP = 2;

function Separator() {
  return <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

const CRUMB_BASE =
  "inline-flex max-w-[10rem] items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/**
 * A crumb that also accepts what is dragged onto it.
 *
 * Moving something "up one level" is the drag every file manager has, and the path is
 * where the eye already is — the folder tree is the long way round and is hidden below
 * `xl`. A wrapper component rather than a hook call in the loop, because `useDroppable`
 * cannot be called conditionally and only the ancestors are worth registering.
 */
function CrumbDropZone({
  id,
  enabled,
  children,
}: {
  id: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id, disabled: !enabled });

  return (
    <span
      ref={setNodeRef}
      className={cn(
        "flex min-w-0 rounded-md ring-accent transition-shadow duration-150 motion-reduce:transition-none",
        isOver && "ring-2"
      )}
    >
      {children}
    </span>
  );
}

/**
 * Where the folder sits, as a row of links.
 *
 * Long chains collapse in the middle rather than wrapping to a second line or
 * pushing the page wider: the first crumb and the last two stay, and everything
 * between them moves into a menu so those folders are still reachable in one click.
 */
export function BrowserBreadcrumb({
  folderId,
  className,
  showRoot = true,
  hrefFor = (id) => `/files?folder=${id}`,
  droppable = false,
}: {
  folderId: string;
  className?: string;
  /**
   * Whether to offer the "My Files" root link. The API already trims a borrowed
   * chain, but the caller knows it is rendering a shared tree before the response
   * lands, so it can suppress the link outright.
   */
  showRoot?: boolean;
  /**
   * Where a crumb points. A shared folder must stay on `/shared-with-me/<id>` so its
   * capabilities get resolved the same way — `/files?folder=<id>` is the owner's route
   * and would leave a member looking at an empty page.
   */
  hrefFor?: (folderId: string) => string;
  /**
   * Whether the ancestors accept a drop. Off by default: only a surface that sits inside
   * a `DndContext` and can perform the move should advertise itself as a target.
   */
  droppable?: boolean;
}) {
  const { data, isPending } = useFolderPath(folderId);
  const t = useT();
  const menu = useFloatingMenu();
  const overflowRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  // A skeleton the same height as the loaded row, so the title below never jumps.
  if (isPending) {
    return (
      <div className={cn("flex h-7 items-center gap-2", className)} aria-hidden>
        <div className="h-3.5 w-14 animate-pulse rounded bg-muted" />
        <Separator />
        <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const crumbs = data?.crumbs ?? [];
  if (crumbs.length === 0) return null;

  const hidden =
    crumbs.length > HEAD_KEEP + TAIL_KEEP + 1
      ? crumbs.slice(HEAD_KEEP, crumbs.length - TAIL_KEEP)
      : [];
  const visible = hidden.length
    ? [...crumbs.slice(0, HEAD_KEEP), ...crumbs.slice(crumbs.length - TAIL_KEEP)]
    : crumbs;

  // The collapsed crumbs navigate through the router rather than rendering links:
  // the shared menu draws buttons, and the crumbs that stay visible are real links.
  const overflowItems: FloatingMenuItem[] = hidden.map((c) => ({
    id: c.id,
    label: c.name,
    icon: FolderIcon,
    onClick: () => router.push(hrefFor(c.id)),
  }));

  // The root is only "My Files" when the viewer owns the tree. Inside a share the
  // chain starts at the folder that was shared, so no root link is offered.
  const hasRoot = showRoot && !data?.trimmed;

  return (
    <nav aria-label={t("files.breadcrumb.pathLabel")} className={cn("flex min-w-0 items-center", className)}>
      {/* A real list, so the path is announced as one — and as a list of a known
          length rather than a run of loose links. Every item owns the separator
          that precedes it, which lets the collapsed group slot in at the exact
          position its folders were removed from. */}
      <ol className="flex min-w-0 items-center gap-1">
        {hasRoot && (
          <li className="flex shrink-0 items-center">
            <CrumbDropZone id={TREE_ROOT_DROP_ID} enabled={droppable}>
              <Link
                href="/files"
                className={cn(CRUMB_BASE, "text-muted-foreground hover:bg-muted hover:text-foreground")}
              >
                <House aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t("files.myFiles")}</span>
              </Link>
            </CrumbDropZone>
          </li>
        )}

        {visible.map((crumb, i) => {
          const isCurrent = i === visible.length - 1;
          // The collapsed folders belong where they were cut out — after the head
          // crumb. Rendering them first would read as "My Files > … > A > D > E",
          // which claims the hidden folders are ancestors of A rather than of D.
          const overflowHere = hidden.length > 0 && i === HEAD_KEEP;

          return (
            <Fragment key={crumb.id}>
              {overflowHere && (
                <li className="flex shrink-0 items-center gap-1">
                  <Separator />
                  <button
                    ref={overflowRef}
                    type="button"
                    onClick={() => menu.toggle("crumbs")}
                    aria-label={t("files.breadcrumb.overflow", { count: hidden.length })}
                    aria-haspopup="menu"
                    aria-expanded={menu.isOpen("crumbs")}
                    className={cn(
                      CRUMB_BASE,
                      // The ::after ring reaches a 44px target without giving the
                      // trigger a larger box than the crumbs it sits between.
                      "relative cursor-pointer after:absolute after:-inset-[11px] after:content-['']",
                      "text-muted-foreground hover:bg-muted hover:text-foreground",
                      menu.isOpen("crumbs") && "bg-muted text-foreground"
                    )}
                  >
                    <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
                  </button>
                  <FloatingActionMenu
                    open={menu.isOpen("crumbs")}
                    onClose={menu.close}
                    anchorRef={overflowRef}
                    items={overflowItems}
                    align="start"
                    menuLabel={t("files.breadcrumb.overflowMenu")}
                  />
                </li>
              )}
              <li className="flex min-w-0 items-center gap-1">
                {(i > 0 || hasRoot) && <Separator />}
                {isCurrent ? (
                  <span aria-current="page" title={crumb.name} className={cn(CRUMB_BASE, "text-foreground")}>
                    <span className="truncate">{crumb.name}</span>
                  </span>
                ) : (
                  <CrumbDropZone id={crumb.id} enabled={droppable}>
                    <Link
                      href={hrefFor(crumb.id)}
                      title={crumb.name}
                      className={cn(CRUMB_BASE, "text-muted-foreground hover:bg-muted hover:text-foreground")}
                    >
                      <span className="truncate">{crumb.name}</span>
                    </Link>
                  </CrumbDropZone>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
