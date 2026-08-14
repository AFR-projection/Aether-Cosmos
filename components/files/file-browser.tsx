"use client";

import { useCallback, useEffect, useState, useRef, useMemo, type ElementType } from "react";
import { QUICK_ACTION_EVENT, type QuickAction } from "@/lib/system/quick-actions";
import {
  Upload, FolderPlus, FilePlus, Grid3X3, List, Search, Trash2, AlertCircle, FolderUp,
  Image, Film, Music, FileText, FileArchive, Star, X, CheckSquare, Square,
  Download, File, Lock, Move, ArrowDownUp, ArrowUp, ArrowDown, Check, PencilRuler,
  Copy, Scissors, ClipboardPaste,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileGrid } from "./file-grid";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { File as FileRecord, Folder as FolderRecord } from "@/lib/db/schema";
import dynamic from "next/dynamic";
import { DndContext, DragEndEvent } from "@dnd-kit/core";
import { FolderCard } from "@/components/folders/folder-card";
import { getSharedUploadQueue, UploadQueue, traverseDirectory } from "@/lib/upload-queue";
import { requestDownload, downloadZip, requestFolderArchive } from "@/lib/download/download-actions";
import { EncryptionSetupDialog } from "./encryption-setup-dialog";
import { MoveToFolderDialog } from "./move-to-folder-dialog";
import { BulkRenameDialog } from "./bulk-rename-dialog";
import { useDialogs } from "@/components/ui/dialog-prompts";
import {
  loadView, saveView, loadSortBy, saveSortBy, loadSortOrder, saveSortOrder,
  SORT_OPTIONS,
} from "@/lib/files/view-prefs";
import { sortFiles } from "@/lib/files/sort";
import {
  setClipboard, clearClipboard, getClipboard, useFileClipboard,
} from "@/lib/files/clipboard";
import { notify } from "@/lib/system/notify-store";
import { motion, AnimatePresence } from "framer-motion";
import { recordActivity } from "@/lib/activity/activity-store";

const ActivityCenter = dynamic(
  () => import("@/components/files/activity-center").then((m) => m.ActivityCenter),
  { ssr: false }
);

const NoteEditor = dynamic(() => import("@/components/editors/note-editor").then((m) => m.NoteEditor), { ssr: false });
const FilePreview = dynamic(() => import("@/components/files/file-preview").then((m) => m.FilePreview), { ssr: false });
const ShareDialog = dynamic(() => import("@/components/files/share-dialog").then((m) => m.ShareDialog), { ssr: false });
const FolderInviteDialog = dynamic(
  () => import("@/components/folders/folder-invite-dialog").then((m) => m.FolderInviteDialog),
  { ssr: false }
);

// ─── Filter definitions ─────────────────────────────────────────────────────
const FILTERS = [
  { key: "all", label: "All", icon: File },
  { key: "image", label: "Images", icon: Image },
  { key: "video", label: "Videos", icon: Film },
  { key: "audio", label: "Audio", icon: Music },
  { key: "document", label: "Documents", icon: FileText },
  { key: "archive", label: "Archives", icon: FileArchive },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

const FILTER_MIME_MAP: Record<string, string[]> = {
  image: ["image/"],
  video: ["video/"],
  audio: ["audio/"],
  document: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument", "text/", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"],
  archive: ["application/zip", "application/x-rar", "application/x-7z", "application/gzip", "application/x-tar"],
};

function matchesFilter(file: FileRecord, filter: FilterKey): boolean {
  if (filter === "all") return true;
  const prefixes = FILTER_MIME_MAP[filter] ?? [];
  return prefixes.some((p) => file.mimeType.startsWith(p));
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface FileBrowserProps {
  folderId?: string | null;
  trash?: boolean;
  favorites?: boolean;
  selectedFileId?: string | null;
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
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-colors",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground/70 hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function FileBrowser({ folderId = null, trash = false, favorites = false, selectedFileId = null }: FileBrowserProps) {
  const queryClient = useQueryClient();
  const { askPrompt, askConfirm, dialogs } = useDialogs();

  // View + search + filter + sort (view & sort persist across sessions)
  const [view, setView] = useState<"grid" | "list">(() => loadView());
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<FilterKey>("all");
  const [sortBy, setSortBy] = useState<string>(() => loadSortBy());
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(() => loadSortOrder());
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const setViewPersisted = useCallback((v: "grid" | "list") => {
    setView(v);
    saveView(v);
  }, []);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Move-to-folder dialog: holds the file ids being moved (null = closed)
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  // Bulk-rename dialog: holds the files being renamed (null = closed)
  const [bulkRenameIds, setBulkRenameIds] = useState<string[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const clipboard = useFileClipboard();

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
  const [loadingMore, setLoadingMore] = useState(false);

  const listScope = `${folderId ?? "root"}:${trash}:${favorites}:${search}`;

  // ── File fetching ──
  const filesQuery = useQuery({
    queryKey: ["files", folderId, trash, favorites, search],
    queryFn: async () => {
      if (search) {
        const params = new URLSearchParams({ q: search, limit: "100" });
        if (folderId) params.set("folderId", folderId);
        const res = await apiFetch<{ files: FileRecord[]; nextCursor: string | null }>(
          `/api/search?${params}`
        );
        if (!res.success) throw new Error(res.error ?? "Failed to search files");
        return res.data ?? { files: [], nextCursor: null };
      }
      const params = new URLSearchParams({ limit: "100" });
      if (folderId) params.set("folderId", folderId);
      if (trash) params.set("trash", "true");
      if (favorites) params.set("favorites", "true");
      const res = await apiFetch<{ files: FileRecord[]; nextCursor: string | null }>(
        `/api/files?${params}`
      );
      if (!res.success) throw new Error(res.error ?? "Failed to load files");
      return res.data ?? { files: [], nextCursor: null };
    },
    staleTime: 5_000,
    refetchOnMount: "always",
    retry: 2,
  });

  // Reset pagination when folder / filters change
  useEffect(() => {
    setLoadedMore([]);
    setMoreCursor(undefined);
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

  const getQueue = useCallback((): UploadQueue => {
    if (!uploadQueue) {
      const q = getSharedUploadQueue();
      q.setEncryption(encryptUploads, encryptUploads ? encryptPassphrase : null);
      let lastToastKey = "";
      q.on("allComplete", () => {
        queryClient.invalidateQueries({ queryKey: ["files"] });
        queryClient.invalidateQueries({ queryKey: ["folders"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        const stats = q.getStats();
        const toastKey = `${stats.total}:${stats.completed}:${stats.failed}`;
        if (toastKey !== lastToastKey && stats.total > 0) {
          lastToastKey = toastKey;
          if (stats.failed > 0) notify({ title: "Upload finished with errors", description: `${stats.failed} file${stats.failed === 1 ? "" : "s"} failed. Open Activity for details.`, tone: "error", duration: 5000 });
          else if (stats.completed > 0) notify({ title: "Upload completed", description: `${stats.completed} file${stats.completed === 1 ? "" : "s"} uploaded successfully.`, tone: "success", duration: 4000 });
        }
      });
      q.on("error", (item) => {
        if (item.status === "error") notify({ title: "Upload failed", description: `${item.file?.name ?? item.remotePath} — ${item.error ?? "Transfer failed"}`, tone: "error", duration: 5000 });
      });
      setUploadQueue(q);
      return q;
    }
    uploadQueue.setEncryption(encryptUploads, encryptUploads ? encryptPassphrase : null);
    return uploadQueue;
  }, [uploadQueue, queryClient, encryptUploads, encryptPassphrase]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(""), 4000);
  }, []);

  // ── Folder fetching ──
  const foldersQuery = useQuery({
    queryKey: ["folders", folderId, trash],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (folderId) params.set("parentId", folderId);
      if (trash) params.set("trash", "true");
      const res = await apiFetch<{ folders: FolderRecord[] }>(`/api/folders?${params}`);
      return res.data?.folders ?? [];
    },
    enabled: !favorites && !search,
  });

  const folders = foldersQuery.data ?? [];

  // ── Load more ──
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "100", cursor: nextCursor });
      if (folderId) params.set("folderId", folderId);
      if (trash) params.set("trash", "true");
      if (favorites) params.set("favorites", "true");
      const res = await apiFetch<{ files: FileRecord[]; nextCursor: string | null }>(
        `/api/files?${params}`
      );
      if (!res.success || !res.data) {
        throw new Error(res.error ?? "Failed to load more files");
      }
      setLoadedMore((prev) => [...prev, ...res.data!.files]);
      setMoreCursor(res.data.nextCursor);
    } catch {
      showError("Failed to load more files");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, folderId, trash, favorites, showError]);

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
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragActive(false);
  }, []);

  // ── Dropzone native handler ──
  const onDropNative = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const items = e.dataTransfer.items;
      if (!items) return;

      const queue = getQueue();
      const allFilesArr: { file: File; relativePath: string; folderId: string | null }[] = [];

      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      for (const entry of entries) {
        if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry;
          const files = await traverseDirectory(entry, dirEntry.name);
          for (const f of files) {
            allFilesArr.push({ file: f.file, relativePath: f.relativePath, folderId: null });
          }
        } else {
          const fileEntry = entry as FileSystemFileEntry;
          const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
          allFilesArr.push({ file, relativePath: file.name, folderId });
        }
      }

      // Extract ALL unique directory paths from all traversed files
      const allFolderPaths = new Set<string>();
      for (const item of allFilesArr) {
        const parts = item.relativePath.split("/");
        if (parts.length > 1) {
          for (let i = 1; i < parts.length; i++) {
            allFolderPaths.add(parts.slice(0, i).join("/"));
          }
        }
      }

      if (allFolderPaths.size > 0) {
        try {
          const res = await apiFetch<{ folders: Record<string, string> }>("/api/folders/batch", {
            method: "POST",
            body: JSON.stringify({ paths: Array.from(allFolderPaths) }),
          });
          if (res.data?.folders) {
            for (const item of allFilesArr) {
              const parts = item.relativePath.split("/");
              if (parts.length > 1) {
                const folderPath = parts.slice(0, -1).join("/");
                item.folderId = res.data.folders[folderPath] ?? folderId;
              } else {
                item.folderId = folderId;
              }
            }
          }
        } catch {
          showError("Failed to create folders");
          return;
        }
      }

      queue.addFolderStructure(allFilesArr);
      dragCounter.current = 0;
      setIsDragActive(false);
    },
    [folderId, getQueue, showError]
  );

  // ── Clipboard: copy / cut (paste lives below, needs folderId handlers) ──
  const copyToClipboard = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const label = ids.length === 1
      ? (allFiles.find((x) => x.id === ids[0])?.name ?? "1 file")
      : `${ids.length} files`;
    setClipboard("copy", ids, label);
    notify({ title: "Copied", description: `${label} ready to paste`, tone: "info", duration: 2500 });
  }, [allFiles]);

  const cutToClipboard = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const label = ids.length === 1
      ? (allFiles.find((x) => x.id === ids[0])?.name ?? "1 file")
      : `${ids.length} files`;
    setClipboard("cut", ids, label);
    notify({ title: "Cut", description: `${label} ready to move`, tone: "info", duration: 2500 });
  }, [allFiles]);

  // ── File actions ──
  const handleFileAction = useCallback(async (action: string, file: FileRecord) => {
    try {
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
          if (!res.success) { showError(res.error ?? "Failed to restore"); return; }
          recordActivity("restore", file.name, "done");
        } else if (action === "delete") {
          const ok = await askConfirm({
            title: "Delete permanently?",
            message: `"${file.name}" will be erased forever. This cannot be undone.`,
            confirmText: "Delete forever",
            danger: true,
          });
          if (!ok) return;
          const res = await apiFetch("/api/files", { method: "DELETE", body: JSON.stringify({ id: file.id, permanent: true }) });
          if (!res.success) { showError(res.error ?? "Failed to delete permanently"); return; }
          recordActivity("delete", file.name, "done");
        }
        queryClient.invalidateQueries({ queryKey: ["files"] });
        return;
      }
      if (action === "delete") {
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "delete" }) });
        if (!res.success) { showError(res.error ?? "Failed to delete"); return; }
        recordActivity("delete", file.name, "done");
      } else if (action === "favorite") {
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "favorite" }) });
        if (!res.success) { showError(res.error ?? "Failed"); return; }
      } else if (action === "rename") {
        const name = await askPrompt({
          title: "Rename file",
          label: "File name",
          initialValue: file.name,
          confirmText: "Rename",
          selectStem: true,
        });
        if (!name || name === file.name) return;
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action: "rename", name }) });
        if (!res.success) { showError(res.error ?? "Failed to rename"); return; }
        recordActivity("rename", file.name, "done", { detail: `→ ${name}` });
      } else {
        const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: file.id, action }) });
        if (!res.success) { showError(res.error ?? "Failed"); return; }
      }
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError("Connection failed");
    }
  }, [trash, queryClient, showError, askPrompt, askConfirm, copyToClipboard, cutToClipboard, selectedIds]);

  // ── Folder actions ──
  async function createFolder() {
    const name = await askPrompt({
      title: "New folder",
      label: "Folder name",
      placeholder: "Untitled folder",
      confirmText: "Create",
    });
    if (!name) return;
    try {
      const res = await apiFetch("/api/folders", { method: "POST", body: JSON.stringify({ name, parentId: folderId }) });
      if (!res.success) { showError(res.error ?? "Failed to create folder"); return; }
      recordActivity("create_folder", name, "done");
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    } catch {
      showError("Connection failed");
    }
  }

  async function folderAction(action: "rename" | "delete", folder: FolderRecord) {
    try {
      if (action === "rename") {
        const name = await askPrompt({
          title: "Rename folder",
          label: "Folder name",
          initialValue: folder.name,
          confirmText: "Rename",
        });
        if (!name || name === folder.name) return;
        const res = await apiFetch("/api/folders", { method: "PATCH", body: JSON.stringify({ id: folder.id, action: "rename", name }) });
        if (!res.success) { showError(res.error ?? "Failed to rename"); return; }
        recordActivity("rename", folder.name, "done", { detail: `→ ${name}` });
      } else if (action === "delete") {
        const ok = await askConfirm({
          title: "Delete folder?",
          message: `"${folder.name}" and everything inside it will be moved to the recycle bin.`,
          confirmText: "Delete folder",
          danger: true,
        });
        if (!ok) return;
        const res = await apiFetch("/api/folders", { method: "PATCH", body: JSON.stringify({ id: folder.id, action: "delete" }) });
        if (!res.success) { showError(res.error ?? "Failed to delete"); return; }
        recordActivity("delete", folder.name, "done", { detail: "Folder" });
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError("Connection failed");
    }
  }

  // ── Note ──
  async function createNote() {
    const res = await apiFetch<{ file: FileRecord }>("/api/files", { method: "POST", body: JSON.stringify({ name: "Untitled Note", folderId }) });
    if (res.data?.file) {
      setSelectedFile(res.data.file);
      setShowNoteEditor(true);
      queryClient.invalidateQueries({ queryKey: ["files"] });
    }
  }

  // ── Drag-drop ──
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    try {
      const res = await apiFetch("/api/files", { method: "PATCH", body: JSON.stringify({ id: active.id as string, action: "move", folderId: over.id as string }) });
      if (!res.success) { showError(res.error ?? "Failed to move"); return; }
      queryClient.invalidateQueries({ queryKey: ["files"] });
    } catch {
      showError("Connection failed");
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
        showError("Failed to read folder");
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

    const entries = Array.from(fileList);
    const files: { file: File; relativePath: string }[] = [];

    for (const f of entries) {
      const path = f.webkitRelativePath || f.name;
      files.push({ file: f, relativePath: path });
    }

    // Use timestamp as folder name since webkitdirectory doesn't expose the original name
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}`;
    const fallbackName = `Upload ${ts}`;

    await uploadFolderStructure(fallbackName, files, folderId);
    e.target.value = "";
  }

  // ── Core: create root folder, subfolders, then upload all files ──
  async function uploadFolderStructure(
    rootName: string,
    files: { file: File; relativePath: string }[],
    parentFolderId: string | null,
  ) {
    if (files.length === 0) return;
    const queue = getQueue();

    // 1. Create the root folder
    const folderRes = await apiFetch<{ folder: FolderRecord }>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: rootName, parentId: parentFolderId }),
    });
    if (!folderRes.success || !folderRes.data) {
      showError("Failed to create folder");
      return;
    }
    const rootId = folderRes.data.folder.id;

    // 2. Collect all unique subfolder paths (relative to root folder)
    const subFolderPaths = new Set<string>();
    for (const item of files) {
      const parts = item.relativePath.split("/");
      if (parts.length > 1) {
        for (let i = 1; i < parts.length; i++) {
          subFolderPaths.add(parts.slice(0, i).join("/"));
        }
      }
    }

    // 3. Create subfolders inside root folder via batch API
    const folderIdMap = new Map<string, string>();
    if (subFolderPaths.size > 0) {
      try {
        const batchRes = await apiFetch<{ folders: Record<string, string> }>("/api/folders/batch", {
          method: "POST",
          body: JSON.stringify({
            paths: Array.from(subFolderPaths),
            rootFolderId: rootId,
          }),
        });
        if (batchRes.data?.folders) {
          for (const [path, id] of Object.entries(batchRes.data.folders)) {
            folderIdMap.set(path, id);
          }
        }
      } catch {
        showError("Failed to create subfolders");
        return;
      }
    }

    // 4. Prepare files with correct folderId
    const uploadItems: { file: File; relativePath: string; folderId: string | null }[] = [];
    for (const item of files) {
      const parts = item.relativePath.split("/");
      if (parts.length > 1) {
        const folderPath = parts.slice(0, -1).join("/");
        const destFolderId = folderIdMap.get(folderPath) ?? rootId;
        uploadItems.push({ file: item.file, relativePath: item.relativePath, folderId: destFolderId });
      } else {
        // File at root of uploaded folder → goes directly into root folder
        uploadItems.push({ file: item.file, relativePath: item.relativePath, folderId: rootId });
      }
    }

    // 5. Upload all files
    queue.addFolderStructure(uploadItems);
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
    setSortMenuOpen(false);
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
    const ids = Array.from(selectedIds);
    try {
      const res = await apiFetch("/api/files/batch", {
        method: "PATCH",
        body: JSON.stringify({ ids, action: "favorite" }),
      });
      if (!res.success) showError(res.error ?? "Favorite failed");
    } catch {
      showError("Connection failed");
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["files"] });
  }

  async function batchDelete() {
    const ok = await askConfirm({
      title: `Delete ${selectedIds.size} file${selectedIds.size > 1 ? "s" : ""}?`,
      message: "They'll be moved to the recycle bin — you can restore them later.",
      confirmText: "Move to trash",
      danger: true,
    });
    if (!ok) return;
    const ids = Array.from(selectedIds);
    try {
      const res = await apiFetch("/api/files/batch", {
        method: "PATCH",
        body: JSON.stringify({ ids, action: "delete" }),
      });
      if (!res.success) showError(res.error ?? "Delete failed");
      else {
        const n = ids.length;
        recordActivity("delete", `${n} file${n > 1 ? "s" : ""}`, "done");
      }
    } catch {
      showError("Connection failed");
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  // Move one or many files into a destination folder (null = root).
  async function executeMove(ids: string[], destinationFolderId: string | null) {
    setMoveIds(null);
    if (ids.length === 0) return;
    try {
      if (ids.length === 1) {
        const file = allFiles.find((f) => f.id === ids[0]);
        const res = await apiFetch("/api/files", {
          method: "PATCH",
          body: JSON.stringify({ id: ids[0], action: "move", folderId: destinationFolderId }),
        });
        if (!res.success) { showError(res.error ?? "Failed to move"); return; }
        if (file) recordActivity("move", file.name, "done");
      } else {
        const res = await apiFetch("/api/files/batch", {
          method: "PATCH",
          body: JSON.stringify({ ids, action: "move", folderId: destinationFolderId }),
        });
        if (!res.success) { showError(res.error ?? "Failed to move files"); return; }
        recordActivity("move", `${ids.length} files`, "done");
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      showError("Connection failed");
    }
  }

  // Apply a set of computed renames (from the bulk-rename dialog).
  async function executeBulkRename(renames: { id: string; name: string }[]) {
    setBulkRenameIds(null);
    if (renames.length === 0) return;
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
    if (failed > 0) showError(`${failed} file${failed > 1 ? "s" : ""} could not be renamed`);
    else recordActivity("rename", `${renames.length} file${renames.length > 1 ? "s" : ""}`, "done");
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["files"] });
  }

  // Paste = copy or move the clipboard contents INTO the current folder.
  async function pasteHere() {
    const clip = getClipboard();
    if (!clip) return;
    try {
      if (clip.mode === "cut") {
        const res = await apiFetch("/api/files/batch", {
          method: "PATCH",
          body: JSON.stringify({ ids: clip.ids, action: "move", folderId }),
        });
        if (!res.success) { showError(res.error ?? "Failed to move"); return; }
        recordActivity("move", clip.label, "done");
      } else {
        let failed = 0;
        for (const id of clip.ids) {
          const res = await apiFetch("/api/files", {
            method: "PATCH",
            body: JSON.stringify({ id, action: "copy", targetFolderId: folderId }),
          });
          if (!res.success) failed++;
        }
        if (failed > 0) showError(`${failed} file${failed > 1 ? "s" : ""} could not be copied`);
        else recordActivity("copy", clip.label, "done");
      }
      // A cut is consumed on paste; a copy stays so it can be pasted again.
      if (clip.mode === "cut") clearClipboard();
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      notify({ title: "Pasted", description: `into ${folderId ? "this folder" : "My Files"}`, tone: "success", duration: 2500 });
    } catch {
      showError("Connection failed");
    }
  }

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
          showError("Download failed");
        }
      }
      return;
    }
    const encryptedSelected = ids
      .map((id) => allFiles.find((f) => f.id === id))
      .filter((f): f is FileRecord => !!f && !!f.encrypted);
    if (encryptedSelected.length > 0) {
      showError(
        `${encryptedSelected.length} file terenkripsi tidak bisa masuk ZIP. Download satu per satu biar bisa dimasukin passphrase.`
      );
      return;
    }
    try {
      await downloadZip(ids, `download-${ids.length}-files.zip`);
    } catch {
      showError("Download failed");
    }
  }

  // ── Select file from URL ──
  useEffect(() => {
    if (selectedFileId && allFiles.length > 0) {
      const found = allFiles.find((f) => f.id === selectedFileId);
      if (found) {
        setSelectedFile(found);
        if (found.isNote) setShowNoteEditor(true);
      }
    }
  }, [selectedFileId, allFiles]);

  const handleFileClick = useCallback((file: FileRecord) => {
    if (file.isNote) { setSelectedFile(file); setShowNoteEditor(true); }
    else { setSelectedFile(file); }
  }, []);

  // Mobile bottom-nav "+" delegates here so we never duplicate upload/note/
  // folder logic. Disabled in trash/favorites where creation isn't allowed.
  useEffect(() => {
    if (trash || favorites) return;
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
  }, [trash, favorites, folderId]);

  const isLoading = filesQuery.isPending && !filesQuery.data;

  // ── Keyboard shortcuts (power-user parity with Drive/Dropbox) ──
  useEffect(() => {
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

      // Esc clears the current selection.
      if (e.key === "Escape" && selectedIds.size > 0) {
        e.preventDefault();
        setSelectedIds(new Set());
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, filteredFiles, trash]);

  useEffect(() => {
    if (filesQuery.isError) {
      showError(filesQuery.error instanceof Error ? filesQuery.error.message : "Failed to load files");
    }
  }, [filesQuery.isError, filesQuery.error, showError]);

  return (
    <DndContext onDragEnd={handleDragEnd}>
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={onDropNative}
    >

      {/* ── Drag overlay ── */}
      {isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/5 backdrop-blur-sm">
          <div className="text-center">
            <div className="flex items-center justify-center gap-3 mb-2">
              <Upload className="h-10 w-10 text-accent" />
              <FolderUp className="h-10 w-10 text-accent/60" />
            </div>
            <p className="text-lg font-medium">Drop files or folders to upload</p>
            <p className="text-sm text-muted-foreground mt-1">Files and folder structures will be preserved</p>
          </div>
        </div>
      )}

      {/* ── Error toast ── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-4 flex items-center gap-2.5 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-500"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Page header ── */}
      {!trash && !favorites && (
        <div className="mb-6">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {folderId ? "Folder" : "My Files"}
            </h1>
            {!isLoading && allFiles.length > 0 && (
              <span className="text-sm text-muted-foreground/50 font-normal">
                {typeFilter !== "all"
                  ? `${filteredFiles.length} of ${allFiles.length}`
                  : `${allFiles.length} file${allFiles.length !== 1 ? "s" : ""}`}
              </span>
            )}
          </div>
          {search && (
            <p className="mt-0.5 text-sm text-muted-foreground/60">
              Results for <span className="font-medium text-foreground/80">&ldquo;{search}&rdquo;</span>
            </p>
          )}
        </div>
      )}
      {(trash || favorites) && (
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {trash ? "Recycle Bin" : "Favorites"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground/50">
            {trash ? "Files moved to trash — restore or delete permanently" : "Files you've starred"}
          </p>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[160px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
          <Input
            ref={searchInputRef}
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 bg-surface text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1 hidden sm:block" />

        {/* ─ Action group ─ */}
        {!trash && !favorites && (
          <div className="flex items-center gap-1.5">
            {/* Upload files (primary) */}
            <label>
              <Button variant="default" size="sm" asChild className="h-9 gap-1.5 px-3 cursor-pointer">
                <span>
                  <Upload className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Upload</span>
                </span>
              </Button>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const fileList = e.target.files;
                  if (!fileList) return;
                  const queue = getQueue();
                  queue.addFiles(Array.from(fileList), folderId);
                  e.target.value = "";
                }}
              />
            </label>

            <Button variant="secondary" size="sm" onClick={() => void createFolder()} className="h-9 px-2.5 gap-1.5" title="New folder">
              <FolderPlus className="h-3.5 w-3.5" />
              <span className="hidden md:inline text-xs">Folder</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void createNote()} className="h-9 px-2.5 gap-1.5" title="New note">
              <FilePlus className="h-3.5 w-3.5" />
              <span className="hidden md:inline text-xs">Note</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void pickAndUploadFolder()} className="h-9 px-2.5 gap-1.5" title="Upload folder">
              <FolderUp className="h-3.5 w-3.5" />
              <span className="hidden lg:inline text-xs">Folder upload</span>
            </Button>

            <ActivityCenter uploadQueue={uploadQueue} inline />

            {/* Encryption toggle */}
            <Button
              variant={encryptUploads ? "default" : "ghost"}
              size="sm"
              className={cn("h-9 px-2.5 gap-1.5", encryptUploads && "ring-1 ring-accent/40")}
              title={encryptUploads ? "Encryption ON — click to disable" : "Enable client-side encryption"}
              onClick={() => {
                if (encryptUploads) { setEncryptUploads(false); setEncryptPassphrase(""); return; }
                setEncryptDialogOpen(true);
              }}
            >
              <Lock className={cn("h-3.5 w-3.5", encryptUploads && "fill-current")} />
              {encryptUploads && <span className="hidden sm:inline text-xs font-semibold">Enc</span>}
            </Button>

            {/* Paste */}
            {clipboard && (
              <Button
                variant="secondary"
                size="sm"
                className="h-9 gap-1.5 px-2.5 border border-accent/25 bg-accent/5 text-accent hover:bg-accent/10"
                onClick={pasteHere}
                title={`Paste ${clipboard.count} ${clipboard.mode === "cut" ? "(move)" : "(copy)"}`}
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                <span className="hidden sm:inline text-xs">{clipboard.count}</span>
              </Button>
            )}
          </div>
        )}

        {/* Separator */}
        <div className="hidden sm:block h-5 w-px bg-border/40" />

        {/* ─ View controls ─ */}
        <div className="flex items-center gap-1.5">
          {/* Sort dropdown */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
              onClick={() => setSortMenuOpen((o) => !o)}
              title="Sort"
            >
              <ArrowDownUp className="h-3.5 w-3.5" />
              <span className="hidden sm:inline text-xs">
                {SORT_OPTIONS.find((o) => o.key === sortBy)?.label ?? "Sort"}
              </span>
            </Button>
            <AnimatePresence>
              {sortMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSortMenuOpen(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.97 }}
                    transition={{ duration: 0.12 }}
                    className="absolute right-0 z-50 mt-1.5 w-44 overflow-hidden rounded-xl border border-border/50 bg-surface-elevated/98 py-1 shadow-2xl shadow-black/15 backdrop-blur-xl"
                  >
                    {SORT_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => chooseSort(opt.key)}
                        className={cn(
                          "flex w-full items-center justify-between px-3 py-2 text-[13px] transition-colors hover:bg-accent/8",
                          sortBy === opt.key ? "text-accent font-medium" : "text-foreground/80"
                        )}
                      >
                        {opt.label}
                        {sortBy === opt.key && <Check className="h-3 w-3" />}
                      </button>
                    ))}
                    <div className="my-1 mx-2.5 border-t border-border/30" />
                    <button
                      onClick={toggleSortOrder}
                      className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-foreground/80 transition-colors hover:bg-accent/8"
                    >
                      {sortOrder === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                      {sortOrder === "asc" ? "Ascending" : "Descending"}
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {/* Grid / List toggle */}
          <div className="flex items-center gap-px rounded-lg border border-border/40 bg-muted/40 p-0.5">
            <button
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-all",
                view === "grid" ? "bg-surface shadow-sm text-foreground" : "text-muted-foreground/60 hover:text-foreground"
              )}
              onClick={() => setViewPersisted("grid")}
              title="Grid view (G)"
            >
              <Grid3X3 className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-all",
                view === "list" ? "bg-surface shadow-sm text-foreground" : "text-muted-foreground/60 hover:text-foreground"
              )}
              onClick={() => setViewPersisted("list")}
              title="List view (L)"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* hidden webkitdirectory input */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error — webkitdirectory is non-standard HTML attribute
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={handleFolderUpload}
      />

      {/* ── Filter chips ── */}
      {!trash && !favorites && !search && (
        <div className="mb-4 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {FILTERS.map(({ key, label, icon: Icon }) => {
            const count = key !== "all" ? allFiles.filter((f) => matchesFilter(f, key)).length : allFiles.length;
            return (
              <button
                key={key}
                onClick={() => { setTypeFilter(key); setSelectedIds(new Set()); }}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                  typeFilter === key
                    ? "bg-foreground/90 text-background shadow-sm"
                    : "bg-muted/50 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="h-3 w-3" />
                {label}
                {count > 0 && key !== "all" && (
                  <span className={cn(
                    "text-[10px] font-mono tabular-nums",
                    typeFilter === key ? "opacity-60" : "opacity-40"
                  )}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Folders ── */}
      {!search && folders.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {folders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              trash={trash}
              onRename={(f) => folderAction("rename", f)}
              onDelete={(f) => folderAction("delete", f)}
              onShare={trash ? undefined : (f) => setInviteFolder(f)}
              onDownload={trash ? undefined : (f) => void requestFolderArchive(f.id, f.name)}
            />
          ))}
        </div>
      )}

      {/* ── Files ── */}
      <FileGrid
        files={filteredFiles}
        view={view}
        trash={trash}
        selectedIds={selectedIds}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onFileAction={handleFileAction}
        onFileClick={handleFileClick}
        onSelect={toggleSelect}
        onSelectAll={toggleSelectAll}
        onSort={handleSort}
        hasMore={!!nextCursor}
        loadMore={loadMore}
        loadingMore={loadingMore}
      />

      {/* ── Preview / Note editor ── */}
      {selectedFile && !showNoteEditor && (
        <FilePreview file={selectedFile} onClose={() => setSelectedFile(null)} />
      )}

      {showNoteEditor && selectedFile && (
        <NoteEditor file={selectedFile} onClose={() => { setShowNoteEditor(false); setSelectedFile(null); }} />
      )}

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
          onConfirm={(dest) => executeMove(moveIds, dest)}
        />
      )}

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
          initial={{ y: 20, opacity: 0, scale: 0.95 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 20, opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 500, damping: 36 }}
          className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2"
        >
          <div className="flex items-center gap-0.5 rounded-2xl border border-border/50 bg-surface-elevated/95 px-2 py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.22)] backdrop-blur-2xl">
            {/* Count */}
            <span className="px-2.5 py-1 text-sm font-semibold text-foreground/80 shrink-0 select-none">
              {selectedIds.size}
            </span>
            <div className="h-5 w-px bg-border/40 mx-1" />

            <DockButton icon={Download} label="Download" onClick={batchDownload} />
            {!trash && <DockButton icon={Copy} label="Copy" onClick={() => copyToClipboard(Array.from(selectedIds))} />}
            {!trash && <DockButton icon={Scissors} label="Cut" onClick={() => cutToClipboard(Array.from(selectedIds))} />}
            {!trash && <DockButton icon={Move} label="Move" onClick={() => setMoveIds(Array.from(selectedIds))} />}
            {!trash && selectedIds.size >= 2 && (
              <DockButton icon={PencilRuler} label="Rename" onClick={() => setBulkRenameIds(Array.from(selectedIds))} />
            )}
            <DockButton icon={Star} label="Favorite" onClick={batchFavorite} />

            <div className="h-5 w-px bg-border/40 mx-1" />
            <DockButton icon={Trash2} label="Delete" onClick={batchDelete} danger />

            <div className="h-5 w-px bg-border/40 mx-1" />
            <button
              onClick={() => setSelectedIds(new Set())}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
              title="Clear selection (Esc)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>

    </DndContext>
  );
}
