"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useRef, useMemo, type ElementType } from "react";
import { QUICK_ACTION_EVENT, type QuickAction } from "@/shared/lib/system/quick-actions";
import {
  Upload, FolderPlus, FilePlus, Grid3X3, List, Search, Trash2, AlertCircle, FolderUp,
  Image, Film, Music, FileText, FileArchive, Star, X, Files, FolderOpen,
  Download, File, Lock, Move, ArrowDownUp, ArrowUp, ArrowDown, PencilRuler,
  Copy, Scissors, ClipboardPaste, ArrowLeft, Plus, ChevronDown, PanelLeft,
  Loader2, CheckSquare,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { FileGrid } from "./file-grid";
import { BrowserBreadcrumb, useFolderPath } from "./browser-breadcrumb";
import {
  FloatingActionMenu,
  useFloatingMenu,
  type FloatingMenuItem,
} from "@/ui/primitives/floating-action-menu";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { File as FileRecord, Folder as FolderRecord } from "@/shared/infrastructure/db/schema";
import dynamic from "next/dynamic";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { FolderCard } from "@files/presentation/components/folders/folder-card";
import { getSharedUploadQueue, UploadQueue, traverseDirectory, type UploadItem } from "@files/application/commands/upload-queue";
import { requestDownload, downloadZip, requestFolderArchive } from "@files/application/commands/download-actions";
import { EncryptionSetupDialog } from "./encryption-setup-dialog";
import { MoveToFolderDialog } from "./move-to-folder-dialog";
import { BulkRenameDialog } from "./bulk-rename-dialog";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import {
  loadView, saveView, loadSortBy, saveSortBy, loadSortOrder, saveSortOrder,
  loadTreeOpen, saveTreeOpen, loadTreeWidth, saveTreeWidth,
  SORT_OPTIONS,
} from "@files/domain/services/view-prefs";
import { sortFiles } from "@files/domain/services/sort";
import { FolderTreeSidebar } from "./folder-tree-sidebar";
import { folderChildrenQuery } from "@files/presentation/hooks/use-folder-children";
import { useMediaQuery } from "@/ui/hooks/use-media-query";
import {
  DRAG_ACTIVATION_DISTANCE,
  describeDrag,
  planDragMove,
  readDragSource,
  type DragSource,
} from "@files/domain/services/drag-move";
import {
  collectFolderPaths, chunkPaths, resolveFileFolderIds, splitCommonRoot,
  type UploadEntry,
} from "@files/domain/services/folder-tree-upload";
import {
  setClipboard, clearClipboard, getClipboard, useFileClipboard, cutIds,
  type ClipboardEntry,
} from "@files/domain/services/clipboard";
import { usePaste } from "@files/presentation/hooks/use-paste";
import { PasteConflictDialog } from "./paste-conflict-dialog";
import { notify } from "@/shared/lib/system/notify-store";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { recordActivity } from "@/shared/lib/activity/activity-store";
import {
  apiErrorMessage,
  createTranslator,
  errorCodeMessage,
  getLocale,
  useT,
  type TranslationKey,
} from "@/shared/lib/i18n";

const ActivityCenter = dynamic(
  () => import("@files/presentation/components/files/activity-center").then((m) => m.ActivityCenter),
  { ssr: false }
);

const NoteEditor = dynamic(() => import("@files/presentation/components/editors/note-editor").then((m) => m.NoteEditor), { ssr: false });
const FilePreview = dynamic(() => import("@files/presentation/components/files/file-preview").then((m) => m.FilePreview), { ssr: false });
const ShareDialog = dynamic(() => import("@files/presentation/components/files/share-dialog").then((m) => m.ShareDialog), { ssr: false });
const FolderInviteDialog = dynamic(
  () => import("@files/presentation/components/folders/folder-invite-dialog").then((m) => m.FolderInviteDialog),
  { ssr: false }
);

// ─── Filter definitions ─────────────────────────────────────────────────────
/**
 * The type chips. Each carries a translation key rather than a label: the table is
 * module scope, evaluated once at import time before any locale exists, so the word
 * can only be resolved at render. `key` is the filter's own id and never changes
 * with the language — it is what the mime map and the selected state are keyed by.
 */
const FILTERS = [
  { key: "all", labelKey: "files.browser.filter.all", icon: File },
  { key: "image", labelKey: "files.browser.filter.images", icon: Image },
  { key: "video", labelKey: "files.browser.filter.videos", icon: Film },
  { key: "audio", labelKey: "files.browser.filter.audio", icon: Music },
  { key: "document", labelKey: "files.browser.filter.documents", icon: FileText },
  { key: "archive", labelKey: "files.browser.filter.archives", icon: FileArchive },
] as const satisfies readonly { key: string; labelKey: TranslationKey; icon: ElementType }[];

type FilterKey = (typeof FILTERS)[number]["key"];

const FILTER_MIME_MAP: Record<string, string[]> = {
  image: ["image/"],
  video: ["video/"],
  audio: ["audio/"],
  document: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument", "text/", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"],
  archive: ["application/zip", "application/x-rar", "application/x-7z", "application/gzip", "application/x-tar"],
};

/** Actions that mutate the folder's contents, so they need `canEdit`. */
const NEEDS_EDIT_ACTIONS = new Set(["rename", "move", "duplicate", "copy", "clip-cut"]);

/**
 * One page of a listing. Both endpoints answer with this shape but page differently:
 * `/api/files` walks a `createdAt` cursor, `/api/search` ranks by relevance and walks an
 * OFFSET index, so exactly one of the two tokens is ever non-null.
 */
type FilePage = { files: FileRecord[]; nextCursor: string | null; nextPage: number | null };
const EMPTY_PAGE: FilePage = { files: [], nextCursor: null, nextPage: null };

function matchesFilter(file: FileRecord, filter: FilterKey): boolean {
  if (filter === "all") return true;
  const prefixes = FILTER_MIME_MAP[filter] ?? [];
  return prefixes.some((p) => file.mimeType.startsWith(p));
}

// ─── Props ──────────────────────────────────────────────────────────────────

/**
 * What the signed-in viewer may do in this listing.
 *
 * Mirrors `FolderCapabilities` from `src/shared/lib/auth/permissions.ts`. The server refuses on its
 * own — this only stops the UI from offering buttons that can only end in a 403, which is
 * what made "view" access feel broken (and let a `view` member believe they could delete
 * the owner's folder).
 */
export type BrowserCaps = {
  role: "owner" | "view" | "edit";
  /** Create / rename / move / trash the CONTENT of this folder. */
  canEdit: boolean;
  /** Favourite flag + public share links. Owner only. */
  canOwnerOnlyFlags: boolean;
  /** Restore from the bin, delete permanently. Owner only. */
  canPurge: boolean;
  /** Invite collaborators / change their role. Owner only. */
  canManageMembers: boolean;
};

/** Own files: everything is permitted. */
export const OWNER_CAPS: BrowserCaps = {
  role: "owner",
  canEdit: true,
  canOwnerOnlyFlags: true,
  canPurge: true,
  canManageMembers: true,
};

interface FileBrowserProps {
  folderId?: string | null;
  trash?: boolean;
  favorites?: boolean;
  selectedFileId?: string | null;
  isSharedContext?: boolean;
  sharedFolderName?: string;
  /** Omit on own surfaces; a shared folder passes the capabilities the server resolved. */
  caps?: BrowserCaps;
  /** Slot in the shared-folder header — currently the "Leave shared folder" button. */
  sharedAction?: React.ReactNode;
}

/**
 * Badge copy for the header, so a member always knows what they are allowed to do.
 *
 * The wording is a key, not a string: this table is built at import time, and the
 * access-level words are shared with every other folder-permission surface.
 */
const ROLE_BADGE: Record<
  BrowserCaps["role"],
  { labelKey: TranslationKey; className: string } | null
> = {
  owner: null,
  view: {
    labelKey: "common.viewOnly",
    className: "border-warning/25 bg-warning/10 text-warning-ink",
  },
  edit: {
    labelKey: "common.canEdit",
    className: "border-success/25 bg-success/10 text-success-ink",
  },
};

// ─── Folder-tree creation ───────────────────────────────────────────────────

/**
 * Create every directory a set of uploaded files needs, in chunks, and return the
 * path → id map.
 *
 * Throws on the first chunk the server refuses. That matters: `apiFetch` resolves
 * on a 4xx, so the previous code read a rejected request as "no folders" and let
 * every file fall back to the root folder — the upload reported success and the
 * project arrived flat. A folder tree that cannot be created is an upload that must
 * not start.
 *
 * `fallbackMessage` arrives already translated: this runs outside the component, so
 * it has no locale of its own, and the server's own message still wins when there
 * is one.
 */
async function createFolderTree(
  relativePaths: string[],
  rootFolderId: string | null,
  fallbackMessage: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const paths = collectFolderPaths(relativePaths);
  if (paths.length === 0) return map;

  // Sequential, not parallel: two chunks that share an ancestor would otherwise
  // both find it missing and insert it twice.
  for (const chunk of chunkPaths(paths)) {
    const res = await apiFetch<{ folders: Record<string, string> }>("/api/folders/batch", {
      method: "POST",
      body: JSON.stringify({ paths: chunk, rootFolderId }),
    });
    if (!res.success || !res.data) {
      throw new Error(res.error ?? fallbackMessage);
    }
    for (const [path, id] of Object.entries(res.data.folders)) map.set(path, id);
  }

  return map;
}

// ─── DockButton ─────────────────────────────────────────────────────────────

function DockButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ElementType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={danger ? "destructive" : "ghost"}
      size="sm"
      onClick={onClick}
      title={label}
      // The text label is `sm:inline` only, so below that breakpoint this is an
      // icon-only control: without an explicit name a screen reader announces
      // nothing but "button". `title` is not a reliable substitute.
      aria-label={label}
      className={cn("shrink-0 cursor-pointer gap-1.5 rounded-xl px-2.5", danger && "border-transparent")}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

/** One toolbar control height, so search / buttons / toggles line up exactly. */
const CONTROL_H = "h-9";

// ─── Component ──────────────────────────────────────────────────────────────

export function FileBrowser({
  folderId = null,
  trash = false,
  favorites = false,
  selectedFileId = null,
  isSharedContext = false,
  sharedFolderName = "",
  caps = OWNER_CAPS,
  sharedAction = null,
}: FileBrowserProps) {
  const queryClient = useQueryClient();
  const t = useT();
  const { askPrompt, askConfirm, dialogs } = useDialogs();
  // Only framer-motion needs this: the global `prefers-reduced-motion` block in
  // globals.css already neutralises CSS animations, but JS-driven springs escape it.
  const reduceMotion = useReducedMotion();

  // View + search + filter + sort (view & sort persist across sessions)
  const [view, setView] = useState<"grid" | "list">(() => loadView());
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterKey>("all");
  const [sortBy, setSortBy] = useState<string>(() => loadSortBy());
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(() => loadSortOrder());

  // Folder tree pane (open state + width persist across sessions).
  const [treeOpen, setTreeOpen] = useState(() => loadTreeOpen());
  const [treeWidth, setTreeWidth] = useState(() => loadTreeWidth());

  // Toolbar menus ("new" and "sort") share one open-state so only one is ever up,
  // but each needs its own anchor to position against.
  const toolbarMenu = useFloatingMenu();
  // Where the background context menu opened, in viewport coordinates. `null` = closed.
  const [areaPoint, setAreaPoint] = useState<{ x: number; y: number } | null>(null);
  /**
   * Name of the folder the running paste is aimed at. Kept here rather than read off the
   * breadcrumb, because "Paste into" on a folder card targets a child — the conflict
   * dialog has to name that child, not the folder being viewed.
   */
  const [pasteTargetName, setPasteTargetName] = useState("");
  const newMenuRef = useRef<HTMLButtonElement>(null);
  const sortMenuRef = useRef<HTMLButtonElement>(null);

  const setViewPersisted = useCallback((v: "grid" | "list") => {
    setView(v);
    saveView(v);
  }, []);

  const toggleTree = useCallback(() => {
    const next = !treeOpen;
    setTreeOpen(next);
    saveTreeOpen(next);
  }, [treeOpen]);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Move-to-folder dialog: holds the file ids being moved (null = closed)
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  // Bulk-rename dialog: holds the files being renamed (null = closed)
  const [bulkRenameIds, setBulkRenameIds] = useState<string[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const clipboard = useFileClipboard();
  // Owns the whole three-round-trip paste: progress, cancellation and the conflict prompt.
  // Destructured because the hook returns a fresh object every progress tick — depending on
  // that object would rebuild the keyboard listener mid-transfer.
  const {
    progress: pasteProgress,
    conflict: pasteConflict,
    run: runPaste,
    cancel: cancelPaste,
  } = usePaste();
  // Items waiting to be moved out of here are shown faded, the way Explorer does it.
  const ghostIds = useMemo(() => cutIds(clipboard), [clipboard]);

  // File preview / note editor
  const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
  const [showNoteEditor, setShowNoteEditor] = useState(false);

  // Upload
  const [error, setError] = useState("");
  const [uploadQueue, setUploadQueue] = useState<UploadQueue | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [encryptUploads, setEncryptUploads] = useState(false);
  const [encryptPassphrase, setEncryptPassphrase] = useState("");
  const [encryptDialogOpen, setEncryptDialogOpen] = useState(false);
  const [inviteFolder, setInviteFolder] = useState<FolderRecord | null>(null);
  const [shareFile, setShareFile] = useState<FileRecord | null>(null);

  // Infinite scroll — extra pages loaded via "Load more"
  const [loadedMore, setLoadedMore] = useState<FileRecord[]>([]);
  /** undefined = use first page cursor; null/string = after load-more */
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined);
  /**
   * The search endpoint ranks by relevance, so it pages by OFFSET index instead of a
   * `createdAt` cursor and always answers `nextCursor: null`. Tracking only the cursor
   * capped every search at its first 100 hits with no way to ask for more.
   */
  const [morePage, setMorePage] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const listScope = `${folderId ?? "root"}:${trash}:${favorites}:${search}`;

  // ── File fetching ──
  const filesQuery = useQuery({
    queryKey: ["files", folderId, trash, favorites, search],
    queryFn: async () => {
      if (search) {
        const params = new URLSearchParams({ q: search, limit: "100" });
        if (folderId) params.set("folderId", folderId);
        const res = await apiFetch<FilePage>(`/api/search?${params}`);
        if (!res.success) throw new Error(res.error ?? t("files.browser.error.search"));
        return res.data ?? EMPTY_PAGE;
      }
      const params = new URLSearchParams({ limit: "100" });
      if (folderId) params.set("folderId", folderId);
      if (trash) params.set("trash", "true");
      if (favorites) params.set("favorites", "true");
      const res = await apiFetch<FilePage>(`/api/files?${params}`);
      if (!res.success) throw new Error(res.error ?? t("files.browser.error.load"));
      return res.data ?? EMPTY_PAGE;
    },
    staleTime: 5_000,
    refetchOnMount: "always",
    retry: 2,
  });

  // Reset pagination when folder / filters change
  useEffect(() => {
    setLoadedMore([]);
    setMoreCursor(undefined);
    setMorePage(undefined);
  }, [listScope]);

  const baseFiles = filesQuery.data?.files ?? [];
  const allFiles = useMemo(() => {
    if (loadedMore.length === 0) return baseFiles;
    const seen = new Set(baseFiles.map((f) => f.id));
    const merged = [...baseFiles];
    for (const f of loadedMore) {
      if (!seen.has(f.id)) merged.push(f);
    }
    return merged;
  }, [baseFiles, loadedMore]);

  const nextCursor =
    moreCursor !== undefined ? moreCursor : (filesQuery.data?.nextCursor ?? null);
  const nextPage =
    morePage !== undefined ? morePage : (filesQuery.data?.nextPage ?? null);
  /** Whichever token the active endpoint pages with is the one that decides this. */
  const hasMore = search ? nextPage !== null : nextCursor !== null;

  const getQueue = useCallback((): UploadQueue => {
    if (!uploadQueue) {
      const q = getSharedUploadQueue();
      q.setEncryption(encryptUploads, encryptUploads ? encryptPassphrase : null);
      setUploadQueue(q);
      return q;
    }
    uploadQueue.setEncryption(encryptUploads, encryptUploads ? encryptPassphrase : null);
    return uploadQueue;
  }, [uploadQueue, encryptUploads, encryptPassphrase]);

  /**
   * The batch-completion notice for uploads started from this browser. The queue
   * is a module-level singleton that outlives this component, so the listeners
   * are registered in an effect and removed on unmount — registering them where
   * the queue is first grabbed left one extra listener behind on every visit to
   * this route, and the toast fired once per stale listener.
   */
  useEffect(() => {
    if (!uploadQueue) return;
    const q = uploadQueue;
    let lastToastKey = "";
    const onAllComplete = () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      const stats = q.getStats();
      const toastKey = `${stats.total}:${stats.completed}:${stats.failed}`;
      if (toastKey === lastToastKey || stats.total === 0) return;
      lastToastKey = toastKey;
      // The listeners are registered once per queue, so they must not capture `t` —
      // a translator built here reads the locale live at the moment the toast goes out.
      const translate = createTranslator(getLocale());
      if (stats.failed > 0) {
        notify({ title: translate("files.browser.notify.uploadErrorsTitle"), description: translate("files.browser.notify.uploadErrorsBody", { count: stats.failed }), tone: "error", duration: 5000 });
      } else if (stats.completed > 0) {
        notify({ title: translate("files.browser.notify.uploadDoneTitle"), description: translate("files.browser.notify.uploadDoneBody", { count: stats.completed }), tone: "success", duration: 4000 });
      }
    };
    const onError = (item: UploadItem) => {
      if (item.status !== "error") return;
      const translate = createTranslator(getLocale());
      notify({
        title: translate("files.browser.notify.uploadFailedTitle"),
        description: translate("files.browser.notify.transferFailedBody", {
          name: item.file?.name ?? item.remotePath,
          // The queue reports a code where it has one; anything else is its own prose.
          reason: item.error
            ? errorCodeMessage(item.error, translate)
            : translate("files.browser.notify.transferFailed"),
        }),
        tone: "error",
        duration: 5000,
      });
    };
    q.on("allComplete", onAllComplete);
    q.on("error", onError);
    return () => {
      q.off("allComplete", onAllComplete);
      q.off("error", onError);
    };
  }, [uploadQueue, queryClient]);

  // One timer, replaced each time: two errors in quick succession used to leave two
  // pending timeouts, so the second banner was cleared early by the first one's clock.
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(""), 5000);
  }, []);
  useEffect(() => () => { if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

  // Client-side twin of `shareRefusal`/`fileRefusal`: same wording the API would return, so
  // a blocked action reads the same whether it was stopped here or on the server.
  const refuse = useCallback((what: "edit" | "flag" | "purge") => {
    if (what === "purge") {
      showError(t("files.browser.refuse.purge"));
      return;
    }
    if (what === "flag") {
      showError(t("files.browser.refuse.flag"));
      return;
    }
    showError(
      caps.role === "view"
        ? t("files.browser.refuse.viewOnly")
        : t("files.browser.refuse.noPermission")
    );
  }, [caps.role, showError, t]);

  // The per-file menu needs a narrower slice of the same capabilities.
  const gridCaps = useMemo(
    () => ({
      canEdit: caps.canEdit,
      canOwnerOnlyFlags: caps.canOwnerOnlyFlags,
      canPurge: caps.canPurge,
    }),
    [caps.canEdit, caps.canOwnerOnlyFlags, caps.canPurge]
  );

  // ── Folder fetching ──
  // The options come from the shared factory so the tree pane observes the SAME cache
  // entry for this folder's children instead of fetching its own copy.
  const foldersQuery = useQuery({
    ...folderChildrenQuery(folderId, trash),
    enabled: !favorites && !search,
  });

  const folders = foldersQuery.data ?? [];

  // ── Folder identity ──
  // The listing endpoints return a folder's CHILDREN, never the folder itself, so the
  // name comes from the ancestor-path query the breadcrumb already caches — the header
  // used to just print the literal word "Folder". Fetched here rather than beside the
  // header it feeds, because a drop resolves its destination's name from these crumbs.
  const folderPath = useFolderPath(folderId);

  // ── Load more ──
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (folderId) params.set("folderId", folderId);
      let url: string;
      if (search) {
        // Keep paging the SEARCH endpoint. Asking `/api/files` for the next page of a
        // search returned the folder's contents instead, so page two of any search was
        // a list of files that never matched the query.
        params.set("q", search);
        params.set("page", String(nextPage));
        url = `/api/search?${params}`;
      } else {
        params.set("cursor", nextCursor!);
        if (trash) params.set("trash", "true");
        if (favorites) params.set("favorites", "true");
        url = `/api/files?${params}`;
      }
      const res = await apiFetch<FilePage>(url);
      if (!res.success || !res.data) {
        throw new Error(apiErrorMessage(res, t, "files.browser.error.loadMore"));
      }
      setLoadedMore((prev) => [...prev, ...res.data!.files]);
      setMoreCursor(res.data.nextCursor ?? null);
      setMorePage(res.data.nextPage ?? null);
    } catch {
      showError(t("files.browser.error.loadMore"));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextCursor, nextPage, loadingMore, search, folderId, trash, favorites, showError, t]);

  // ── Filter + sort files (client-side) ──
  const filteredFiles = useMemo(() => {
    let list = allFiles;
    if (typeFilter !== "all") {
      list = list.filter((f) => matchesFilter(f, typeFilter));
    }
    return list;
  }, [allFiles, typeFilter]);

  // ── Drag state (manual tracking replaces react-dropzone isDragActive) ──
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    // No "drop to upload" overlay when the viewer may not write here.
    if (caps.canEdit) setIsDragActive(true);
  }, [caps.canEdit]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragActive(false);
  }, []);

  // ── Dropzone native handler ──
  const onDropNative = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      // Dropping onto a folder you may only read must not start an upload.
      if (!caps.canEdit) {
        dragCounter.current = 0;
        setIsDragActive(false);
        refuse("edit");
        return;
      }
      const items = e.dataTransfer.items;
      if (!items) return;

      const queue = getQueue();
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      const dropped: UploadEntry[] = [];
      for (const entry of entries) {
        if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry;
          const files = await traverseDirectory(entry, dirEntry.name);
          for (const f of files) {
            dropped.push({ file: f.file, relativePath: f.relativePath });
          }
        } else {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
          dropped.push({ file, relativePath: file.name });
        }
      }

      if (dropped.length === 0) {
        dragCounter.current = 0;
        setIsDragActive(false);
        return;
      }

      dragCounter.current = 0;
      setIsDragActive(false);

      let folderIds: Map<string, string>;
      try {
        // `folderId` as the root: a tree dropped while inside a folder used to be
        // created at the account root, because this call never said where it landed.
        folderIds = await createFolderTree(
          dropped.map((d) => d.relativePath),
          folderId,
          t("files.browser.error.folderTree")
        );
      } catch (error) {
        showError(
          error instanceof Error ? error.message : t("files.browser.error.createFolders")
        );
        return;
      }

      const { items: uploadItems, unresolved } = resolveFileFolderIds(dropped, folderIds, folderId);
      if (unresolved.length > 0) {
        showError(
          t("files.browser.error.unresolvedFolders", { count: unresolved.length })
        );
        return;
      }

      queue.addFolderStructure(uploadItems);
    },
    [folderId, getQueue, showError, caps.canEdit, refuse, t]
  );

  // ── Clipboard: copy / cut (paste lives below, needs folderId handlers) ──
  /**
   * One writer for both modes and both kinds. The clipboard records where the items came
   * from, which is what lets a cut refuse a paste back into its own folder instead of
   * running a no-op move, and what lets a folder be carried the same way a file is.
   */
  const putOnClipboard = useCallback(
    (mode: "copy" | "cut", entries: ClipboardEntry[]) => {
      if (entries.length === 0) return;
      const label =
        entries.length === 1
          ? entries[0].name
          : t("files.browser.fileCount", { count: entries.length });
      setClipboard(mode, entries, folderId, label);
      notify({
        title: mode === "cut" ? t("files.list.cut") : t("common.copied"),
        description: t(
          mode === "cut" ? "files.browser.notify.readyToMove" : "files.browser.notify.readyToPaste",
          { label }
        ),
        tone: "info",
        duration: 2500,
      });
    },
    [folderId, t]
  );

  // Names are looked up now so the chip can say "report.pdf" rather than "1 file", but the
  // paste re-reads them from the server: a rename between copy and paste wins.
  const fileEntries = useCallback(
    (ids: readonly string[]): ClipboardEntry[] =>
      ids.map((id) => ({
        kind: "file" as const,
        id,
        name: allFiles.find((x) => x.id === id)?.name ?? id,
      })),
    [allFiles]
  );

  const copyToClipboard = useCallback(
    (ids: string[]) => putOnClipboard("copy", fileEntries(ids)),
    [putOnClipboard, fileEntries]
  );

  const cutToClipboard = useCallback(
    (ids: string[]) => putOnClipboard("cut", fileEntries(ids)),
    [putOnClipboard, fileEntries]
  );

  const copyFolderToClipboard = useCallback(
    (folder: FolderRecord) =>
      putOnClipboard("copy", [{ kind: "folder", id: folder.id, name: folder.name }]),
    [putOnClipboard]
  );

  const cutFolderToClipboard = useCallback(
    (folder: FolderRecord) =>
      putOnClipboard("cut", [{ kind: "folder", id: folder.id, name: folder.name }]),
    [putOnClipboard]
  );

  // ── File actions ──
  const handleFileAction = useCallback(async (action: string, file: FileRecord) => {
    try {
      // Menus, keyboard shortcuts and the mobile sheet all funnel through here, so the
      // capability check lives here rather than only where the buttons are rendered.
      if (NEEDS_EDIT_ACTIONS.has(action) && !caps.canEdit) { refuse("edit"); return; }
      if ((action === "favorite" || action === "share") && !caps.canOwnerOnlyFlags) { refuse("flag"); return; }
      if (action === "restore" && !caps.canPurge) { refuse("purge"); return; }
      if (action === "delete" && (trash ? !caps.canPurge : !caps.canEdit)) {
        refuse(trash ? "purge" : "edit");
        return;
      }
      if (action === "download") {
        // Notes have no stored file — export happens from the editor
        // (Markdown / TXT / PDF). Open it instead of hitting the download API.
        if (file.isNote) {
          setSelectedFile(file);
          setShowNoteEditor(true);
          return;
        }
        requestDownload(file);
        return;
      }
      if (action === "share") {
        // Open the share dialog — "share" is not a PATCH mutation.
        setShareFile(file);
        return;
      }
      if (action === "move") {
        setMoveIds([file.id]);
        return;
      }
      if (action === "clip-copy") {
        copyToClipboard(selectedIds.has(file.id) ? Array.from(selectedIds) : [file.id]);
        return;
      }
      if (action === "clip-cut") {
        cutToClipboard(selectedIds.has(file.id) ? Array.from(selectedIds) : [file.id]);
        return;
      }
      if (trash) {
        if (action === "restore") {
          const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "restore" }) });
          if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.restore")); return; }
          recordActivity("restore", file.name, "done");
        } else if (action === "delete") {
          const ok = await askConfirm({
            title: t("files.browser.confirm.purgeTitle"),
            message: t("files.browser.confirm.purgeBody", { name: file.name }),
            confirmText: t("files.browser.confirm.purgeAction"),
            danger: true,
          });
          if (!ok) return;
          const res = await apiFetch("/api/files", { method: "DELETE", body: JSON.stringify({ id: file.id, permanent: true }) });
          if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.purge")); return; }
          recordActivity("delete", file.name, "done");
        }
        queryClient.invalidateQueries({ queryKey: ["files"] });
        return;
      }
      if (action === "delete") {
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "delete" }) });
        if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.delete")); return; }
        recordActivity("delete", file.name, "done");
      } else if (action === "favorite") {
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "favorite" }) });
        if (!res.success) { showError(apiErrorMessage(res, t, "errors.unexpected")); return; }
      } else if (action === "rename") {
        const name = await askPrompt({
          title: t("files.browser.prompt.renameFileTitle"),
          label: t("files.browser.prompt.fileName"),
          initialValue: file.name,
          confirmText: t("common.rename"),
          selectStem: true,
        });
        if (!name || name === file.name) return;
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "rename", name }) });
        if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.rename")); return; }
        recordActivity("rename", file.name, "done", { detail: `→ ${name}` });
      } else {
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action }) });
        if (!res.success) { showError(apiErrorMessage(res, t, "errors.unexpected")); return; }
      }
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError(t("errors.connectionFailed"));
    }
  }, [trash, queryClient, showError, askPrompt, askConfirm, copyToClipboard, cutToClipboard, selectedIds, caps, refuse, t]);

  // ── Folder actions ──
  async function createFolder() {
    if (!caps.canEdit) { refuse("edit"); return; }
    const name = await askPrompt({
      title: t("files.browser.prompt.newFolderTitle"),
      label: t("files.browser.prompt.folderName"),
      placeholder: t("files.browser.untitledFolder"),
      confirmText: t("files.browser.prompt.create"),
    });
    if (!name) return;
    try {
      const res = await apiFetch("/api/folders", { method: "POST", body: JSON.stringify({ name, parentId: folderId }) });
      if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.createFolder")); return; }
      recordActivity("create_folder", name, "done");
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    } catch {
      showError(t("errors.connectionFailed"));
    }
  }

  async function folderAction(action: "rename" | "delete", folder: FolderRecord) {
    if (!caps.canEdit) { refuse("edit"); return; }
    try {
      if (action === "rename") {
        const name = await askPrompt({
          title: t("files.browser.prompt.renameFolderTitle"),
          label: t("files.browser.prompt.folderName"),
          initialValue: folder.name,
          confirmText: t("common.rename"),
        });
        if (!name || name === folder.name) return;
        const res = await apiFetch("/api/folders", { method: "PATCH", body: JSON.stringify({ id: folder.id, action: "rename", name }) });
        if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.rename")); return; }
        recordActivity("rename", folder.name, "done", { detail: `→ ${name}` });
      } else if (action === "delete") {
        const ok = await askConfirm({
          title: t("files.browser.confirm.deleteFolderTitle"),
          message: t("files.browser.confirm.deleteFolderBody", { name: folder.name }),
          confirmText: t("files.browser.confirm.deleteFolderAction"),
          danger: true,
        });
        if (!ok) return;
        const res = await apiFetch("/api/folders", { method: "PATCH", body: JSON.stringify({ id: folder.id, action: "delete" }) });
        if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.delete")); return; }
        recordActivity("delete", folder.name, "done", { detail: t("common.folder") });
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError(t("errors.connectionFailed"));
    }
  }

  // ── Note ──
  async function createNote() {
    if (!caps.canEdit) { refuse("edit"); return; }
    const res = await apiFetch<{ file: FileRecord }>("/api/files", { method: "POST", body: JSON.stringify({ name: t("files.browser.untitledNote"), folderId }) });
    if (res.data?.file) {
      setSelectedFile(res.data.file);
      setShowNoteEditor(true);
      queryClient.invalidateQueries({ queryKey: ["files"] });
    }
  }

  // ── Drag-drop ──
  //
  // Mouse and pen only. A touch sensor would have to claim the same gesture the listing
  // uses to scroll and the one Android uses to open the context menu; losing either on a
  // phone costs more than drag-to-move gains there, where the always-visible checkboxes
  // plus "Move to…" already do the job. The keyboard path is unchanged: M, or Ctrl+X
  // then Ctrl+V.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } })
  );

  /** What is under the pointer right now, for the overlay. `null` when nothing is. */
  const [dragSource, setDragSource] = useState<DragSource | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragSource(readDragSource(event.active));
  }, []);

  /** A readable destination for the activity line. Ids the page has no name for stay out. */
  function destinationLabel(destination: string | null): string | undefined {
    if (destination === null) return t("files.myFiles");
    return (
      folders.find((f) => f.id === destination)?.name ??
      folderPath.data?.crumbs.find((c) => c.id === destination)?.name
    );
  }

  async function moveFolderTo(source: DragSource, destination: string | null) {
    try {
      const res = await apiFetch("/api/folders", {
        method: "PATCH",
        body: JSON.stringify({ id: source.id, action: "move", parentId: destination }),
      });
      // The server owns the rules the browser cannot check: a folder dropped into its own
      // subtree, and a destination in someone else's tree. Its wording is the better one.
      if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.moveFolder")); return; }
      recordActivity("move", source.name, "done", { destination: destinationLabel(destination) });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["folder-path"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError(t("errors.connectionFailed"));
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDragSource(null);
    const source = readDragSource(event.active);
    if (!source) return;

    const plan = planDragMove({
      source,
      overId: typeof event.over?.id === "string" ? event.over.id : null,
      currentFolderId: folderId ?? null,
      selectedIds: [...selectedIds],
      canEdit: caps.canEdit,
      trash,
    });

    switch (plan.type) {
      case "none":
        return;
      case "denied":
        refuse("edit");
        return;
      case "blocked":
        showError(errorCodeMessage(plan.reason, t));
        return;
      case "files":
        await executeMove(plan.ids, plan.destination, destinationLabel(plan.destination));
        return;
      case "folder":
        await moveFolderTo(source, plan.destination);
        return;
    }
  }

  // ── Recursive directory reader for showDirectoryPicker ──
  async function readDirectoryRecursive(
    dirHandle: FileSystemDirectoryHandle,
    path: string = ""
  ): Promise<{ file: File; relativePath: string }[]> {
    const results: { file: File; relativePath: string }[] = [];
    const dirEntries = (
      dirHandle as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [name, handle] of dirEntries) {
      const entryPath = path ? `${path}/${name}` : name;
      if (handle.kind === "file") {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        results.push({ file, relativePath: entryPath });
      } else {
        const subResults = await readDirectoryRecursive(handle as FileSystemDirectoryHandle, entryPath);
        results.push(...subResults);
      }
    }
    return results;
  }

  // ── Folder upload (showDirectoryPicker + webkitdirectory fallback) ──
  async function pickAndUploadFolder() {
    if (!caps.canEdit) { refuse("edit"); return; }
    let rootFolderName: string;
    let files: { file: File; relativePath: string }[];

    // Try modern File System Access API first
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        const dirHandle = await (
          window as unknown as {
            showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker();
        rootFolderName = dirHandle.name;
        files = await readDirectoryRecursive(dirHandle);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return; // User cancelled
        showError(t("files.browser.error.readFolder"));
        return;
      }
    } else {
      // Fallback: trigger hidden webkitdirectory input
      folderInputRef.current?.click();
      return;
    }

    if (files.length === 0) return;
    await uploadFolderStructure(rootFolderName, files, folderId);
  }

  // ── Webkitdirectory fallback handler ──
  async function handleFolderUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    if (!caps.canEdit) { e.target.value = ""; refuse("edit"); return; }

    const picked: UploadEntry[] = Array.from(fileList).map((f) => ({
      file: f,
      relativePath: f.webkitRelativePath || f.name,
    }));

    // `webkitRelativePath` starts with the directory the user chose, so the name is
    // right there. The old code invented "Upload <timestamp>" and then kept the
    // real name as a subfolder, burying every project one level deeper than it is.
    const { rootName, entries } = splitCommonRoot(picked);
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}`;

    await uploadFolderStructure(
      rootName ?? t("files.browser.uploadFallbackName", { timestamp: ts }),
      entries,
      folderId
    );
    e.target.value = "";
  }

  // ── Core: create root folder, subfolders, then upload all files ──
  async function uploadFolderStructure(
    rootName: string,
    entries: UploadEntry[],
    parentFolderId: string | null,
  ) {
    if (entries.length === 0) return;
    const queue = getQueue();

    // 1. Create the root folder
    const folderRes = await apiFetch<{ folder: FolderRecord }>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: rootName, parentId: parentFolderId }),
    });
    if (!folderRes.success || !folderRes.data) {
      showError(apiErrorMessage(folderRes, t, "files.browser.error.createFolder"));
      return;
    }
    const rootId = folderRes.data.folder.id;

    // 2. Create every subfolder underneath it, in chunks, failing loudly.
    let folderIds: Map<string, string>;
    try {
      folderIds = await createFolderTree(
        entries.map((entry) => entry.relativePath),
        rootId,
        t("files.browser.error.folderTree")
      );
    } catch (error) {
      showError(
        error instanceof Error ? error.message : t("files.browser.error.createSubfolders")
      );
      return;
    }

    // 3. Point each file at its own folder — never at the root as a fallback.
    const { items, unresolved } = resolveFileFolderIds(entries, folderIds, rootId);
    if (unresolved.length > 0) {
      showError(t("files.browser.error.unresolvedFolders", { count: unresolved.length }));
      return;
    }

    queue.addFolderStructure(items);
  }

  // ── Sort toggle ──
  const handleSort = useCallback((key: string) => {
    if (sortBy === key) {
      setSortOrder((o) => {
        const next = o === "asc" ? "desc" : "asc";
        saveSortOrder(next);
        return next;
      });
    } else {
      setSortBy(key);
      saveSortBy(key);
      setSortOrder("asc");
      saveSortOrder("asc");
    }
  }, [sortBy]);

  const chooseSort = useCallback((key: string) => {
    setSortBy(key);
    saveSortBy(key);
    setSortOrder("asc");
    saveSortOrder("asc");
  }, []);

  const toggleSortOrder = useCallback(() => {
    setSortOrder((o) => {
      const next = o === "asc" ? "desc" : "asc";
      saveSortOrder(next);
      return next;
    });
  }, []);

  // ── Selection ──
  // Files in the exact order the user sees them (filter + sort) — the basis for
  // shift-click range selection so a range matches the on-screen order.
  const visibleFiles = useMemo(
    () => sortFiles(filteredFiles, sortBy, sortOrder),
    [filteredFiles, sortBy, sortOrder]
  );
  const lastSelectedId = useRef<string | null>(null);

  const toggleSelect = useCallback((id: string, shiftKey?: boolean) => {
    // Shift-click: select the contiguous range from the last anchor to here.
    if (shiftKey && lastSelectedId.current) {
      const order = visibleFiles.map((f) => f.id);
      const from = order.indexOf(lastSelectedId.current);
      const to = order.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        const range = order.slice(lo, hi + 1);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const rid of range) next.add(rid);
          return next;
        });
        lastSelectedId.current = id;
        return;
      }
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelectedId.current = id;
  }, [visibleFiles]);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === filteredFiles.length) return new Set();
      return new Set(filteredFiles.map((f) => f.id));
    });
  }, [filteredFiles]);

  // ── Batch actions ──
  async function batchFavorite() {
    if (!caps.canOwnerOnlyFlags) { refuse("flag"); return; }
    const ids = Array.from(selectedIds);
    try {
      const res = await apiFetch("/api/files/batch", {
        method: "PATCH",
        body: JSON.stringify({ ids, action: "favorite" }),
      });
      if (!res.success) showError(apiErrorMessage(res, t, "files.browser.error.favoriteBatch"));
    } catch {
      showError(t("errors.connectionFailed"));
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["files"] });
  }

  async function batchDelete() {
    if (trash ? !caps.canPurge : !caps.canEdit) { refuse(trash ? "purge" : "edit"); return; }
    const n = selectedIds.size;
    // In the bin the only delete left IS the permanent one. This used to send the same
    // `PATCH action:"delete"` as the normal listing, which only stamps `deletedAt` again —
    // so the files the user asked to purge were still sitting there afterwards.
    const ok = await askConfirm(
      trash
        ? {
            title: t("files.browser.confirm.purgeBatchTitle", { count: n }),
            message: t("files.browser.confirm.purgeBatchBody"),
            confirmText: t("files.browser.confirm.purgeAction"),
            danger: true,
          }
        : {
            title: t("files.browser.confirm.trashBatchTitle", { count: n }),
            message: t("files.browser.confirm.trashBatchBody"),
            confirmText: t("files.list.trash"),
            danger: true,
          }
    );
    if (!ok) return;
    const ids = Array.from(selectedIds);
    try {
      const res = trash
        ? await apiFetch("/api/files/batch", {
            method: "DELETE",
            body: JSON.stringify({ ids, permanent: true }),
          })
        : await apiFetch("/api/files/batch", {
            method: "PATCH",
            body: JSON.stringify({ ids, action: "delete" }),
          });
      if (!res.success) showError(apiErrorMessage(res, t, "files.browser.error.deleteBatch"));
      else recordActivity("delete", t("files.browser.fileCount", { count: ids.length }), "done");
    } catch {
      showError(t("errors.connectionFailed"));
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  // Move one or many files into a destination folder (null = root).
  async function executeMove(ids: string[], destinationFolderId: string | null, destinationFolderName?: string) {
    setMoveIds(null);
    if (ids.length === 0) return;
    if (!caps.canEdit) { refuse("edit"); return; }
    const sourceName = folderId === null ? t("files.myFiles") : undefined;
    const destName = destinationFolderName ?? (destinationFolderId === null ? t("files.myFiles") : undefined);
    try {
      if (ids.length === 1) {
        const file = allFiles.find((f) => f.id === ids[0]);
        const res = await apiFetch("/api/files", {
          method: "PATCH",
          body: JSON.stringify({ id: ids[0], action: "move", folderId: destinationFolderId }),
        });
        if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.move")); return; }
        if (file) recordActivity("move", file.name, "done", { source: sourceName, destination: destName });
      } else {
        const res = await apiFetch("/api/files/batch", {
          method: "PATCH",
          body: JSON.stringify({ ids, action: "move", folderId: destinationFolderId }),
        });
        if (!res.success) { showError(apiErrorMessage(res, t, "files.browser.error.moveFiles")); return; }
        recordActivity("move", t("files.browser.fileCount", { count: ids.length }), "done", { source: sourceName, destination: destName });
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError(t("errors.connectionFailed"));
    }
  }

  // Apply a set of computed renames (from the bulk-rename dialog).
  async function executeBulkRename(renames: { id: string; name: string }[]) {
    setBulkRenameIds(null);
    if (renames.length === 0) return;
    if (!caps.canEdit) { refuse("edit"); return; }
    let failed = 0;
    for (const r of renames) {
      try {
        const res = await apiFetch("/api/files", {
          method: "PATCH",
          body: JSON.stringify({ id: r.id, action: "rename", name: r.name }),
        });
        if (!res.success) failed++;
      } catch {
        failed++;
      }
    }
    if (failed > 0) showError(t("files.browser.error.renameBatch", { count: failed }));
    else recordActivity("rename", t("files.browser.fileCount", { count: renames.length }), "done");
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["files"] });
  }

  /**
   * Paste = copy or move the clipboard contents INTO a folder. All three entry points
   * (the toolbar chip, Ctrl+V, and "Paste into" on a folder card) funnel through here, so
   * the destination is a parameter rather than always "the folder being viewed".
   *
   * `pathIds` is the destination's own id plus every ancestor. For the current folder that
   * is exactly the breadcrumb chain; for a child card it is that chain plus the child.
   */
  const pasteInto = useCallback(
    (destination: string | null, destinationName: string, extraPathId?: string) => {
      const crumbs = (folderPath.data?.crumbs ?? []).map((crumb) => crumb.id);
      setPasteTargetName(destinationName);
      void runPaste({
        clipboard: getClipboard(),
        destinationFolderId: destination,
        destinationPathIds: extraPathId ? [...crumbs, extraPathId] : crumbs,
        canEdit: caps.canEdit,
        trash,
        destinationName,
      });
    },
    [runPaste, folderPath.data, caps.canEdit, trash]
  );

  const pasteHere = useCallback(() => {
    pasteInto(folderId, folderId ? t("files.browser.thisFolder") : t("files.myFiles"));
    setSelectedIds(new Set());
  }, [pasteInto, folderId, t]);

  const pasteIntoFolder = useCallback(
    (folder: FolderRecord) => {
      pasteInto(folder.id, folder.name, folder.id);
      setSelectedIds(new Set());
    },
    [pasteInto]
  );

  async function batchDownload() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const file = allFiles.find((f) => f.id === ids[0]);
      if (file) {
        requestDownload(file);
      } else {
        try {
          await downloadZip(ids, `download-1-file.zip`);
        } catch {
          showError(t("files.browser.error.download"));
        }
      }
      return;
    }
    const encryptedSelected = ids
      .map((id) => allFiles.find((f) => f.id === id))
      .filter((f): f is FileRecord => !!f && !!f.encrypted);
    if (encryptedSelected.length > 0) {
      showError(
        t("files.browser.error.encryptedZip", { count: encryptedSelected.length })
      );
      return;
    }
    try {
      await downloadZip(ids, `download-${ids.length}-files.zip`);
    } catch {
      showError(t("files.browser.error.download"));
    }
  }

  // ── Select file from URL ──
  // `?file=<id>` is a one-shot instruction, not a piece of live state. Because this
  // effect depended on `allFiles`, every background refetch re-ran it and re-opened
  // the preview the user had just closed — so the deep link became impossible to
  // dismiss. The ref records that the instruction has been carried out.
  const appliedUrlSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedFileId || allFiles.length === 0) return;
    if (appliedUrlSelection.current === selectedFileId) return;
    const found = allFiles.find((f) => f.id === selectedFileId);
    if (!found) return;
    appliedUrlSelection.current = selectedFileId;
    setSelectedFile(found);
    if (found.isNote) setShowNoteEditor(true);
  }, [selectedFileId, allFiles]);

  const handleFileClick = useCallback((file: FileRecord) => {
    if (file.isNote) { setSelectedFile(file); setShowNoteEditor(true); }
    else { setSelectedFile(file); }
  }, []);

  // Mobile bottom-nav "+" delegates here so we never duplicate upload/note/
  // folder logic. Disabled in trash/favorites where creation isn't allowed.
  useEffect(() => {
    if (trash || favorites || !caps.canEdit) return;
    const handler = (e: Event) => {
      const action = (e as CustomEvent<QuickAction>).detail;
      if (action === "upload") uploadInputRef.current?.click();
      else if (action === "note") void createNote();
      else if (action === "folder") void createFolder();
    };
    window.addEventListener(QUICK_ACTION_EVENT, handler);
    return () => window.removeEventListener(QUICK_ACTION_EVENT, handler);
    // createNote/createFolder are stable closures over folderId; re-bind on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trash, favorites, folderId, caps.canEdit]);

  const isLoading = filesQuery.isPending && !filesQuery.data;

  /**
   * True while any surface this component owns is on top of the listing. The shortcuts
   * below are bound to `window`, so without this a Backspace inside the note editor also
   * trashed the selection behind it, and `g` / `l` silently flipped the view under an
   * open preview. Dialogs from `useDialogs()` are not included: they own the focus, so
   * their own handlers see the key first.
   */
  const overlayOpen =
    !!selectedFile || showNoteEditor || !!moveIds || !!bulkRenameIds ||
    !!shareFile || !!inviteFolder || encryptDialogOpen;

  // ── Keyboard shortcuts (power-user parity with Drive/Dropbox) ──
  useEffect(() => {
    if (overlayOpen) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      // "/" focuses search from anywhere (unless already typing).
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (typing) return;

      // Esc clears the selection first, then the clipboard. Explorer drops its cut
      // marquee on Escape, and since this clipboard survives a reload there would
      // otherwise be no way to put it down.
      if (e.key === "Escape") {
        if (selectedIds.size > 0) {
          e.preventDefault();
          setSelectedIds(new Set());
          return;
        }
        if (getClipboard()) {
          e.preventDefault();
          clearClipboard();
        }
        return;
      }

      // Ctrl/Cmd+A selects everything currently shown.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (filteredFiles.length === 0) return;
        e.preventDefault();
        setSelectedIds(new Set(filteredFiles.map((f) => f.id)));
        return;
      }

      // Ctrl/Cmd+V pastes the clipboard into the current folder (works with an
      // empty selection too — that's the common Explorer flow).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !trash) {
        if (getClipboard()) { e.preventDefault(); void pasteHere(); }
        return;
      }
      // Ctrl/Cmd+C / Ctrl/Cmd+X copy or cut the current selection.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selectedIds.size > 0 && !trash) {
        e.preventDefault();
        copyToClipboard(Array.from(selectedIds));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && selectedIds.size > 0 && !trash) {
        e.preventDefault();
        cutToClipboard(Array.from(selectedIds));
        return;
      }

      // Plain g / l toggle grid / list.
      if (e.key === "g" && !e.ctrlKey && !e.metaKey) { setViewPersisted("grid"); return; }
      if (e.key === "l" && !e.ctrlKey && !e.metaKey) { setViewPersisted("list"); return; }

      // The rest act on the current selection.
      if (selectedIds.size === 0) return;
      const selected = filteredFiles.filter((f) => selectedIds.has(f.id));

      // Spacebar quick-preview a single selected file (macOS Quick Look style).
      if (e.key === " " && selected.length === 1) {
        e.preventDefault();
        handleFileClick(selected[0]);
        return;
      }
      // Delete / Backspace → trash selection.
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void batchDelete();
        return;
      }
      // F2 renames a single selected file.
      if (e.key === "F2" && selected.length === 1) {
        e.preventDefault();
        void handleFileAction("rename", selected[0]);
        return;
      }
      // m moves the selection.
      if (e.key === "m" && !trash) {
        e.preventDefault();
        setMoveIds(Array.from(selectedIds));
        return;
      }
      // Ctrl/Cmd+D downloads the selection (single file or bulk ZIP).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void batchDownload();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // `folderId`/`folderPath.data` are listed because Ctrl+V reads the destination and its
    // ancestor chain out of this closure — a stale one would paste into the folder the user
    // was looking at a navigation ago.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, filteredFiles, trash, overlayOpen, folderId, folderPath.data, pasteHere]);

  useEffect(() => {
    if (filesQuery.isError) {
      // The query function already translated its own failure, so the only thing
      // needed here is a translator for the generic case — built from the live
      // locale rather than captured, because this effect must not re-run on a
      // language change and re-raise an error the user has already dismissed.
      const translate = createTranslator(getLocale());
      showError(
        filesQuery.error instanceof Error
          ? filesQuery.error.message
          : translate("files.browser.error.load")
      );
    }
  }, [filesQuery.isError, filesQuery.error, showError]);

  // ── Header identity ──
  const currentFolderName = folderPath.data?.crumbs.at(-1)?.name;
  const headingPending = !!folderId && !currentFolderName && folderPath.isPending;
  const heading = isSharedContext
    ? sharedFolderName || currentFolderName || t("files.browser.sharedFolder")
    : folderId
      ? currentFolderName ?? t("common.folder")
      : t("files.myFiles");
  const HeadingIcon = folderId || isSharedContext ? FolderOpen : Files;
  const roleBadge = ROLE_BADGE[caps.role];

  // ── Folder tree pane ──
  // Only mounted from `xl` up: the app already spends 240px on its global nav, and a
  // third column below that width would leave the listing one card wide. Below it the
  // breadcrumb and folder cards remain the way around, so nothing is lost — and no tree
  // requests are made for rows nobody can see.
  const wideEnoughForTree = useMediaQuery("(min-width: 1280px)");
  const showTree = wideEnoughForTree && treeOpen && !trash && !favorites;

  // Inside a share the cached path is already trimmed to start at the folder that was
  // shared, so `crumbs[0]` IS the root the member is allowed to see. Before it lands the
  // pane is rooted at the current folder, which re-roots itself once the path arrives.
  const shareRoot = isSharedContext ? folderPath.data?.crumbs[0] : undefined;
  const treeRoot = useMemo(
    () =>
      isSharedContext
        ? {
            id: shareRoot?.id ?? folderId,
            name: shareRoot?.name ?? (sharedFolderName || t("files.browser.sharedFolder")),
          }
        : { id: null, name: t("files.myFiles") },
    [isSharedContext, shareRoot?.id, shareRoot?.name, folderId, sharedFolderName, t]
  );

  // The chain includes the folder itself, so its own children are open in the pane.
  const treeOpenPath = useMemo(
    () => (folderPath.data?.crumbs ?? []).map((crumb) => crumb.id),
    [folderPath.data]
  );

  const treeHrefFor = useCallback(
    (id: string | null) =>
      id === null ? "/files" : isSharedContext ? `/shared-with-me/${id}` : `/files?folder=${id}`,
    [isSharedContext]
  );

  /** Files shown / files here, plus the search term — one line, always text. */
  const countLabel =
    typeFilter !== "all"
      ? t("files.browser.fileCountFiltered", {
          shown: filteredFiles.length,
          count: allFiles.length,
        })
      : t("files.browser.fileCount", { count: allFiles.length });

  const canCreate = !trash && !favorites && caps.canEdit;

  // The menu closes itself after an item runs, so these only do the work.
  const newItems: FloatingMenuItem[] = [
    { id: "folder", label: t("quickActions.folder"), icon: FolderPlus, onClick: () => void createFolder() },
    { id: "note", label: t("quickActions.note"), icon: FilePlus, onClick: () => void createNote() },
    {
      id: "folder-upload",
      label: t("files.browser.uploadFolder"),
      icon: FolderUp,
      separatorBefore: true,
      onClick: () => void pickAndUploadFolder(),
    },
  ];

  /**
   * Right-click on the background between cards — Explorer's area menu, trimmed to what is
   * reachable from empty space. Built unconditionally so the handler can tell "nothing to
   * offer" (a read-only trash view) from "menu suppressed".
   */
  const areaMenuItems: FloatingMenuItem[] = [];
  if (clipboard && canCreate) {
    areaMenuItems.push({
      id: "area-paste",
      label: t(
        clipboard.mode === "cut" ? "files.browser.pasteMove" : "files.browser.pasteCopy",
        { count: clipboard.count }
      ),
      icon: ClipboardPaste,
      shortcut: "Ctrl+V",
      onClick: pasteHere,
    });
  }
  if (filteredFiles.length > 0) {
    areaMenuItems.push({
      id: "area-select-all",
      label: t("files.list.selectAll"),
      icon: CheckSquare,
      shortcut: "Ctrl+A",
      separatorBefore: areaMenuItems.length > 0,
      onClick: () => setSelectedIds(new Set(filteredFiles.map((f) => f.id))),
    });
  }
  if (canCreate) {
    areaMenuItems.push(
      {
        id: "area-folder",
        label: t("quickActions.folder"),
        icon: FolderPlus,
        separatorBefore: areaMenuItems.length > 0,
        onClick: () => void createFolder(),
      },
      {
        id: "area-upload",
        label: t("quickActions.upload"),
        icon: Upload,
        onClick: () => uploadInputRef.current?.click(),
      }
    );
  }

  const sortItems: FloatingMenuItem[] = [
    ...SORT_OPTIONS.map((opt) => ({
      id: opt.key,
      label: t(opt.labelKey),
      icon: ArrowDownUp,
      checked: sortBy === opt.key,
      onClick: () => chooseSort(opt.key),
    })),
    {
      id: "order",
      label: sortOrder === "asc" ? t("files.browser.ascending") : t("files.browser.descending"),
      icon: sortOrder === "asc" ? ArrowUp : ArrowDown,
      separatorBefore: true,
      onClick: toggleSortOrder,
    },
  ];

  /**
   * The active sort column, as words. Resolved once so the visible label and the
   * screen-reader sentence beside it can never name different columns; falls back
   * to `common.name` because that is the column the browser actually sorts by
   * when a stored preference names one this build no longer offers.
   */
  const sortColumnLabel = t(SORT_OPTIONS.find((o) => o.key === sortBy)?.labelKey ?? "common.name");

  /** Puts the listing back to "everything here" from the empty state. */
  const resetFilters = useCallback(() => {
    setSearch("");
    setTypeFilter("all");
    setSelectedIds(new Set());
  }, []);

  return (
    // `pointerWithin` rather than the default rectangle intersection: the targets here
    // range from a full folder card to a 28px-tall breadcrumb, and only "the thing the
    // pointer is actually inside" behaves the way a drop is aimed. It also resolves to
    // nothing when the pointer is over open space, so letting go there moves nothing.
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragSource(null)}
    >
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={onDropNative}
    >

      {/* ── Drag overlay ──
          z-30 is the page-chrome tier: high enough to cover the listing it belongs to,
          low enough that a full-screen surface (preview, upload panel) still wins. */}
      {isDragActive && (
        <div className="absolute inset-0 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/5 backdrop-blur-sm">
          <div className="text-center">
            <div className="mb-2 flex items-center justify-center gap-3">
              <Upload aria-hidden className="h-10 w-10 text-accent-ink" />
              <FolderUp aria-hidden className="h-10 w-10 text-accent-ink/60" />
            </div>
            <p className="text-lg font-medium">{t("files.browser.dropTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("files.browser.dropHint")}</p>
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      <AnimatePresence>
        {error && (
          <motion.div
            role="alert"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            className="mb-4 flex items-center gap-2.5 rounded-xl border border-danger/25 bg-danger/10 px-4 py-2.5 text-sm text-danger-ink"
          >
            <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Page header ──
          One block for every surface. `trash`/`favorites` are headed by their own page,
          so this stays out of their way rather than printing a second H1. */}
      {!trash && !favorites && (
        <div className="mb-5">
          {isSharedContext && (
            <Link
              href="/shared-with-me"
              className="group mb-3 -ml-1.5 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ArrowLeft aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
              <span>{t("nav.sharedWithMe")}</span>
            </Link>
          )}

          {/* Where this folder sits. Inside a share the chain starts at the shared
              folder, so no link back to the owner's root is offered. */}
          {folderId && (
            <BrowserBreadcrumb
              folderId={folderId}
              showRoot={!isSharedContext}
              droppable={caps.canEdit && !trash}
              hrefFor={
                isSharedContext ? (id) => `/shared-with-me/${id}` : undefined
              }
              className="mb-1.5"
            />
          )}

          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10">
              <HeadingIcon aria-hidden className="h-5 w-5 text-accent-ink" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
                  {headingPending ? (
                    <>
                      <span
                        aria-hidden
                        className="inline-block h-5 w-40 animate-pulse rounded bg-muted align-middle"
                      />
                      <span className="sr-only">{t("files.browser.loadingFolder")}</span>
                    </>
                  ) : (
                    heading
                  )}
                </h1>
                {/* Say the role out loud: a member who sees no Upload button should know
                    it is by design, not a broken page. */}
                {roleBadge && (
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
                      roleBadge.className
                    )}
                  >
                    {t(roleBadge.labelKey)}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {isLoading ? (
                  t("common.loading")
                ) : (
                  <>
                    {countLabel}
                    {folders.length > 0 && !search && (
                      <> · {t("files.browser.folderCount", { count: folders.length })}</>
                    )}
                    {search && (
                      <>
                        {" · "}
                        <span className="font-medium text-foreground">
                          {t("files.browser.resultsFor", { query: search })}
                        </span>
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            {sharedAction && <div className="shrink-0">{sharedAction}</div>}
          </div>
        </div>
      )}

      {/* ── Tree + listing ──
          The pane is a sibling of the LISTING, not of the page: the breadcrumb, title
          and role badge above still span the full width, so re-opening the tree never
          reflows the header. `items-start` lets the pane stick while the grid scrolls. */}
      <div className="flex items-start gap-4">
        {showTree && (
          <FolderTreeSidebar
            root={treeRoot}
            currentFolderId={folderId}
            openPath={treeOpenPath}
            hrefFor={treeHrefFor}
            width={treeWidth}
            onWidthChange={setTreeWidth}
            onWidthCommit={saveTreeWidth}
            onCollapse={toggleTree}
            droppable={caps.canEdit && !trash}
          />
        )}

        <div className="min-w-0 flex-1">
          {/* ── Toolbar ──
              Search on the left, everything that acts on the listing on the right, in one
              row that wraps as a block instead of scattering ten separate controls. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {/* Folder tree toggle. Only offered where the pane can actually appear —
                below `xl` there is no room for it, and trash/favorites are flat lists. */}
            {!trash && !favorites && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleTree}
                aria-pressed={treeOpen}
                aria-label={treeOpen ? t("files.tree.hide") : t("files.tree.show")}
                title={treeOpen ? t("files.tree.hide") : t("files.tree.show")}
                className={cn(
                  CONTROL_H,
                  "hidden shrink-0 cursor-pointer px-2 xl:inline-flex",
                  treeOpen && "bg-muted text-foreground"
                )}
              >
                <PanelLeft aria-hidden className="h-4 w-4" />
              </Button>
            )}

            {/* Search */}
            <div className="relative min-w-[180px] flex-1 sm:max-w-sm">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                aria-label={t("nav.searchFiles")}
                // The shortcut is in the placeholder because the toolbar has no room for
                // a hint chip; "/" focuses this field from anywhere on the page.
                placeholder={t("files.browser.searchPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={cn(CONTROL_H, "bg-surface pl-9 pr-9")}
              />
              {search && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSearch("")}
                  aria-label={t("files.browser.clearSearch")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer hover:bg-muted"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* Pushes everything that follows to the right edge on a single row. */}
            <div className="hidden flex-1 sm:block" />

            {/* ─ Create group ─ (hidden for a `view` member: nothing here would succeed) */}
            {canCreate && (
              <>
                {/* Upload files — the one primary action on the page. */}
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => uploadInputRef.current?.click()}
                  className={cn(CONTROL_H, "cursor-pointer gap-1.5 px-3")}
                >
                  <Upload aria-hidden className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("files.browser.upload")}</span>
                  <span className="sr-only sm:hidden">{t("quickActions.upload")}</span>
                </Button>

                {/* Everything else that creates something lives in one menu, so the
                    toolbar reads as "search · upload · new" instead of five buttons. */}
                <Button
                  ref={newMenuRef}
                  variant="secondary"
                  size="sm"
                  onClick={() => toolbarMenu.toggle("new")}
                  aria-haspopup="menu"
                  aria-expanded={toolbarMenu.isOpen("new")}
                  className={cn(CONTROL_H, "cursor-pointer gap-1 px-2.5")}
                >
                  <Plus aria-hidden className="h-3.5 w-3.5" />
                  <span className="hidden md:inline text-xs">{t("files.browser.newMenu")}</span>
                  <ChevronDown aria-hidden className="h-3 w-3 opacity-60" />
                  <span className="sr-only md:hidden">{t("files.browser.newItem")}</span>
                </Button>
                <FloatingActionMenu
                  open={toolbarMenu.isOpen("new")}
                  onClose={toolbarMenu.close}
                  anchorRef={newMenuRef}
                  items={newItems}
                  align="end"
                  menuLabel={t("files.browser.createMenu")}
                />
              </>
            )}

            {/* ─ Transfer state ─ */}
            {canCreate && (
              <>
                {/* Encryption is a mode, not an action: it reports itself as pressed. */}
                <Button
                  variant={encryptUploads ? "default" : "ghost"}
                  size="sm"
                  aria-pressed={encryptUploads}
                  className={cn(CONTROL_H, "cursor-pointer gap-1.5 px-2.5", encryptUploads && "ring-1 ring-accent/40")}
                  title={encryptUploads ? t("files.browser.encryptOn") : t("files.browser.encryptOff")}
                  onClick={() => {
                    if (encryptUploads) { setEncryptUploads(false); setEncryptPassphrase(""); return; }
                    setEncryptDialogOpen(true);
                  }}
                >
                  <Lock aria-hidden className={cn("h-3.5 w-3.5", encryptUploads && "fill-current")} />
                  <span className={encryptUploads ? "hidden text-xs font-semibold sm:inline" : "sr-only"}>
                    {t(encryptUploads ? "files.browser.encryptedLabel" : "files.encrypt.title")}
                  </span>
                </Button>

                {/* One slot, two states: what is waiting to be pasted, or what is being
                    pasted right now. A running paste is the more urgent of the two, and
                    it is also the only one that can be stopped. */}
                {pasteProgress ? (
                  // A progressbar, not a live region: `aria-live` here would announce
                  // every tick, so a 400-file paste would talk 400 times. A progressbar's
                  // value changes are readable on demand and silent until asked.
                  <div
                    role="progressbar"
                    aria-label={t(
                      pasteProgress.mode === "cut"
                        ? "files.paste.progress.movingLabel"
                        : "files.paste.progress.copyingLabel"
                    )}
                    // Left indeterminate outside the transfer phase, where there is no
                    // total yet to be a fraction of.
                    aria-valuemin={pasteProgress.phase === "transfer" ? 0 : undefined}
                    aria-valuemax={pasteProgress.phase === "transfer" ? pasteProgress.total : undefined}
                    aria-valuenow={pasteProgress.phase === "transfer" ? pasteProgress.done : undefined}
                    aria-valuetext={
                      pasteProgress.phase === "transfer"
                        ? t("files.paste.progress.count", {
                            done: pasteProgress.done,
                            total: pasteProgress.total,
                          })
                        : t(
                            pasteProgress.phase === "planning"
                              ? "files.paste.progress.planning"
                              : "files.paste.progress.structure"
                          )
                    }
                    className={cn(
                      CONTROL_H,
                      "flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/5 pl-2.5 pr-1 text-accent-ink"
                    )}
                  >
                    <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                    {/* Already spoken by `aria-valuetext`; repeating it as content would
                        read the fraction twice. */}
                    <span aria-hidden className="text-xs tabular-nums">
                      {pasteProgress.phase === "transfer"
                        ? `${pasteProgress.done}/${pasteProgress.total}`
                        : t(
                            pasteProgress.phase === "planning"
                              ? "files.paste.progress.planning"
                              : "files.paste.progress.structure"
                          )}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      onClick={cancelPaste}
                      aria-label={t("files.paste.cancel")}
                      title={t("files.paste.cancel")}
                      className="h-6 w-6 rounded-md text-accent-ink hover:bg-accent/15"
                    >
                      <X aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  clipboard && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className={cn(CONTROL_H, "cursor-pointer gap-1.5 border border-accent/25 bg-accent/5 px-2.5 text-accent-ink hover:bg-accent/10")}
                      onClick={pasteHere}
                      title={t(clipboard.mode === "cut" ? "files.browser.pasteMove" : "files.browser.pasteCopy", { count: clipboard.count })}
                    >
                      {/* Scissors for a cut: the chip is the only place the mode is
                          visible once the source folder is out of view. */}
                      {clipboard.mode === "cut" ? (
                        <Scissors aria-hidden className="h-3.5 w-3.5" />
                      ) : (
                        <ClipboardPaste aria-hidden className="h-3.5 w-3.5" />
                      )}
                      <span className="text-xs tabular-nums">{clipboard.count}</span>
                      <span className="sr-only">{t("files.browser.pasteHere")}</span>
                    </Button>
                  )
                )}
              </>
            )}

            {!trash && !favorites && <ActivityCenter uploadQueue={uploadQueue} inline />}

            <div className="mx-0.5 hidden h-5 w-px bg-border/40 sm:block" />

            {/* ─ View controls ─ */}
            <Button
              ref={sortMenuRef}
              variant="ghost"
              size="sm"
              onClick={() => toolbarMenu.toggle("sort")}
              aria-haspopup="menu"
              aria-expanded={toolbarMenu.isOpen("sort")}
              className={cn(CONTROL_H, "cursor-pointer gap-1.5 px-2.5 text-muted-foreground hover:text-foreground")}
            >
              <ArrowDownUp aria-hidden className="h-3.5 w-3.5" />
              <span className="hidden text-xs sm:inline">{sortColumnLabel}</span>
              <span className="sr-only">
                {t("files.browser.sortState", {
                  column: sortColumnLabel,
                  direction: t(
                    sortOrder === "asc"
                      ? "files.browser.directionAscending"
                      : "files.browser.directionDescending"
                  ),
                })}
              </span>
            </Button>
            <FloatingActionMenu
              open={toolbarMenu.isOpen("sort")}
              onClose={toolbarMenu.close}
              anchorRef={sortMenuRef}
              items={sortItems}
              align="end"
              menuLabel={t("files.browser.sortMenu")}
            />

            {/* Grid / List toggle */}
            <div className="flex items-center gap-px rounded-lg border border-border/40 bg-muted/40 p-0.5">
              <button
                type="button"
                aria-pressed={view === "grid"}
                aria-label={t("files.browser.gridView")}
                title={t("files.browser.gridViewHint")}
                className={cn(
                  "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  view === "grid" ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setViewPersisted("grid")}
              >
                <Grid3X3 aria-hidden className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={view === "list"}
                aria-label={t("files.browser.listView")}
                title={t("files.browser.listViewHint")}
                className={cn(
                  "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  view === "list" ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setViewPersisted("list")}
              >
                <List aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Hidden pickers — always mounted, so the mobile "+" quick action and the
              New menu can click them regardless of which controls are on screen. */}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const fileList = e.target.files;
              if (!fileList) return;
              const queue = getQueue();
              queue.addFiles(Array.from(fileList), folderId);
              e.target.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error — webkitdirectory is a non-standard HTML attribute
            webkitdirectory=""
            multiple
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={handleFolderUpload}
          />

          {/* ── Filter chips ──
              Kept on screen during a search too: the type filter still applies to the
              results, so hiding the chips made the narrowed count look like a bug. */}
          {!trash && !favorites && (
            <div
              role="group"
              aria-label={t("files.browser.filterLabel")}
              className="no-scrollbar mb-4 flex items-center gap-1.5 overflow-x-auto"
            >
              {FILTERS.map(({ key, labelKey, icon: Icon }) => {
                const count = key !== "all" ? allFiles.filter((f) => matchesFilter(f, key)).length : allFiles.length;
                const active = typeFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { setTypeFilter(key); setSelectedIds(new Set()); }}
                    className={cn(
                      "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                      active
                        ? "border-accent/40 bg-accent/12 text-accent-ink"
                        : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon aria-hidden className="h-3 w-3" />
                    {t(labelKey)}
                    {count > 0 && key !== "all" && (
                      // Subordinate by weight, not by opacity: `opacity-40` on an already
                      // muted chip put the count under the contrast floor.
                      <span className="font-mono text-xs font-normal tabular-nums">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Background right-click target. Cards stop propagation for their own context
              menus, and a link or button keeps the native one — that is where "open in new
              tab" lives, and taking it away from a folder card would be a downgrade. */}
          <div
            onContextMenu={(e) => {
              if (areaMenuItems.length === 0) return;
              if ((e.target as HTMLElement).closest("a,button,input,textarea")) return;
              e.preventDefault();
              setAreaPoint({ x: e.clientX, y: e.clientY });
            }}
          >
          {/* ── Folders ── */}
          {!search && folders.length > 0 && (
            <section aria-labelledby="folders-heading" className="mb-5">
              <h2
                id="folders-heading"
                className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
              >
                {t("files.browser.foldersSection")} <span className="font-mono font-normal tabular-nums">{folders.length}</span>
              </h2>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {folders.map((folder) => (
                  <FolderCard
                    key={folder.id}
                    folder={folder}
                    trash={trash}
                    // Inside a shared folder, a subfolder must stay in the shared view so its
                    // capabilities get resolved the same way instead of falling back to /files.
                    href={isSharedContext ? `/shared-with-me/${folder.id}` : undefined}
                    canDrag={caps.canEdit}
                    ghosted={ghostIds.has(folder.id)}
                    onRename={caps.canEdit ? (f) => folderAction("rename", f) : undefined}
                    onDelete={caps.canEdit ? (f) => folderAction("delete", f) : undefined}
                    onShare={trash || !caps.canManageMembers ? undefined : (f) => setInviteFolder(f)}
                    onDownload={trash ? undefined : (f) => void requestFolderArchive(f.id, f.name)}
                    // Copy is offered even to a `view` member: reading the folder is what it
                    // needs, and the paste itself is checked at the destination.
                    onCopy={trash ? undefined : copyFolderToClipboard}
                    onCut={trash || !caps.canEdit ? undefined : cutFolderToClipboard}
                    // Only meaningful while something is actually on the clipboard.
                    onPasteInto={
                      trash || !caps.canEdit || !clipboard ? undefined : pasteIntoFolder
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── Files ── */}
          {!search && folders.length > 0 && filteredFiles.length > 0 && (
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {t("files.browser.filesSection")} <span className="font-mono font-normal tabular-nums">{filteredFiles.length}</span>
            </h2>
          )}
          <FileGrid
            files={filteredFiles}
            view={view}
            trash={trash}
            selectedIds={selectedIds}
            cutIds={ghostIds}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onFileAction={handleFileAction}
            onFileClick={handleFileClick}
            onSelect={toggleSelect}
            onSelectAll={toggleSelectAll}
            onSort={handleSort}
            caps={gridCaps}
            hasMore={hasMore}
            loadMore={loadMore}
            loadingMore={loadingMore}
            empty={{
              searchQuery: search || undefined,
              filterActive: typeFilter !== "all",
              onResetFilters: resetFilters,
              readOnly: !canCreate,
              action: canCreate ? (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => uploadInputRef.current?.click()}
                  className="cursor-pointer gap-1.5"
                >
                  <Upload aria-hidden className="h-3.5 w-3.5" />
                  {t("quickActions.upload")}
                </Button>
              ) : undefined,
              // With folders on screen the page is not empty, so the notice stays a
              // single line instead of a full-height illustration.
              compact: !search && folders.length > 0,
            }}
          />

            <FloatingActionMenu
              open={areaPoint !== null}
              onClose={() => setAreaPoint(null)}
              anchorPoint={areaPoint}
              items={areaMenuItems}
              placement="context"
              menuLabel={t("files.browser.areaMenu")}
            />
          </div>
        </div>
      </div>

      {/* ── Preview / Note editor ──
          Both surfaces declare `exit` animations, and both were mounted bare — without
          an AnimatePresence around them React unmounts the element the instant the state
          flips, so closing either one snapped off the screen and the exit props were
          dead code. Keyed by file id so switching files replays the entrance. */}
      <AnimatePresence>
        {selectedFile && !showNoteEditor && (
          <FilePreview
            key={`preview-${selectedFile.id}`}
            file={selectedFile}
            onClose={() => setSelectedFile(null)}
            /* A trashed file is not edited in place — it is restored first. */
            canEdit={caps.canEdit && !trash}
            onSaved={() => {
              // The listing carries size and modified time, and a save moves both.
              queryClient.invalidateQueries({ queryKey: ["files"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showNoteEditor && selectedFile && (
          <NoteEditor
            key={`note-${selectedFile.id}`}
            file={selectedFile}
            onClose={() => { setShowNoteEditor(false); setSelectedFile(null); }}
          />
        )}
      </AnimatePresence>

      {inviteFolder && (
        <FolderInviteDialog
          folderId={inviteFolder.id}
          folderName={inviteFolder.name}
          onClose={() => setInviteFolder(null)}
        />
      )}

      {shareFile && (
        <ShareDialog
          fileId={shareFile.id}
          fileName={shareFile.name}
          fileType={shareFile.mimeType}
          isNote={shareFile.isNote}
          onClose={() => setShareFile(null)}
        />
      )}

      <EncryptionSetupDialog
        open={encryptDialogOpen}
        onClose={() => setEncryptDialogOpen(false)}
        onConfirm={(pass) => {
          setEncryptPassphrase(pass);
          setEncryptUploads(true);
        }}
      />

      {moveIds && (
        <MoveToFolderDialog
          count={moveIds.length}
          disabledFolderIds={folderId ? [folderId] : []}
          onCancel={() => setMoveIds(null)}
          onConfirm={(dest) => executeMove(moveIds, dest.folderId, dest.folderName)}
        />
      )}

      {/* Parked promise: the paste is suspended until this resolves, so it renders
          outside the listing and survives a re-render of the grid underneath. */}
      <PasteConflictDialog conflict={pasteConflict} destinationName={pasteTargetName} />

      {bulkRenameIds && (
        <BulkRenameDialog
          files={allFiles
            .filter((f) => bulkRenameIds.includes(f.id))
            .map((f) => ({ id: f.id, name: f.name }))}
          onCancel={() => setBulkRenameIds(null)}
          onConfirm={executeBulkRename}
        />
      )}

      {dialogs}
    </div>

    {/* ── Floating batch action dock ── */}
    <AnimatePresence>
      {selectedIds.size > 0 && (
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { y: 20, opacity: 0, scale: 0.95 }}
          animate={reduceMotion ? { opacity: 1 } : { y: 0, opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { y: 20, opacity: 0, scale: 0.95 }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 36 }}
          // z-60 clears the mobile bottom nav (z-40) it used to hide behind, and the
          // offset lifts it above that bar plus the home indicator on a phone.
          className="fixed bottom-[calc(var(--bottom-nav-h)+var(--safe-bottom)+0.75rem)] left-1/2 z-[60] -translate-x-1/2 lg:bottom-6"
        >
          <div className="flex items-center gap-0.5 rounded-2xl border border-border/50 bg-surface-elevated/95 px-2 py-1.5 shadow-2xl backdrop-blur-2xl">
            {/* Count. The digit is decorative: `common.selectedCount` reads the whole
                fact aloud, so a screen reader says "3 selected" rather than "3, selected". */}
            <span className="shrink-0 select-none px-2.5 py-1 text-sm font-semibold tabular-nums text-foreground">
              <span aria-hidden>{selectedIds.size}</span>
              <span className="sr-only">{t("common.selectedCount", { count: selectedIds.size })}</span>
            </span>
            <div className="mx-1 h-5 w-px bg-border/40" />

            <DockButton icon={Download} label={t("common.download")} onClick={batchDownload} />
            {!trash && <DockButton icon={Copy} label={t("common.copy")} onClick={() => copyToClipboard(Array.from(selectedIds))} />}
            {!trash && caps.canEdit && <DockButton icon={Scissors} label={t("files.list.cut")} onClick={() => cutToClipboard(Array.from(selectedIds))} />}
            {!trash && caps.canEdit && <DockButton icon={Move} label={t("files.browser.move")} onClick={() => setMoveIds(Array.from(selectedIds))} />}
            {!trash && caps.canEdit && selectedIds.size >= 2 && (
              <DockButton icon={PencilRuler} label={t("common.rename")} onClick={() => setBulkRenameIds(Array.from(selectedIds))} />
            )}
            {caps.canOwnerOnlyFlags && <DockButton icon={Star} label={t("files.list.favorite")} onClick={batchFavorite} />}

            {(trash ? caps.canPurge : caps.canEdit) && (
              <>
                <div className="h-5 w-px bg-border/40 mx-1" />
                <DockButton icon={Trash2} label={t("common.delete")} onClick={batchDelete} danger />
              </>
            )}

            <div className="mx-1 h-5 w-px bg-border/40" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setSelectedIds(new Set())}
              className="h-8 w-8 shrink-0 cursor-pointer rounded-xl hover:bg-muted/60"
              aria-label={t("files.browser.clearSelection")}
              title={t("files.browser.clearSelectionHint")}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>

    {/* ── What follows the pointer ──
        Rendered by dnd-kit in a portal instead of transforming the row in place, so the
        listing never reflows while something is being carried across it. `dropAnimation`
        is off: the default flies the preview back to where the row was, which reads as
        "nothing happened" at the exact moment the row has in fact moved elsewhere. */}
    <DragOverlay dropAnimation={null}>
      {dragSource && <DragPreview source={dragSource} selectedIds={selectedIds} />}
    </DragOverlay>

    </DndContext>
  );
}

/**
 * The pill under the pointer during a drag.
 *
 * Deliberately quiet — no accent fill, no motion. The accent belongs to the drop target
 * under the pointer, which is the thing being aimed at; a second accent here would leave
 * two controls competing for the same "this is live" signal. The count comes from
 * `describeDrag` so it can never disagree with what the drop actually moves.
 */
function DragPreview({
  source,
  selectedIds,
}: {
  source: DragSource;
  selectedIds: Set<string>;
}) {
  const { label, count } = describeDrag(source, [...selectedIds]);
  const Icon = source.kind === "folder" ? FolderOpen : File;

  return (
    <div className="pointer-events-none flex max-w-[16rem] cursor-grabbing items-center gap-2 rounded-xl border border-border bg-surface-elevated px-3 py-2 shadow-xl shadow-black/25">
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm font-medium text-foreground">{label}</span>
      {count > 1 && (
        <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-on-accent">
          {count}
        </span>
      )}
    </div>
  );
}
