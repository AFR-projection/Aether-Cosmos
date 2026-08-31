"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowLeft, ChevronDown, ChevronRight, Download, FileAudio, FileCode,
  FileImage, FileText, FileVideo, Folder, FolderOpen, Search, X, type LucideIcon,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Badge } from "@/ui/primitives/badge";
import { Input } from "@/ui/primitives/input";
import { cn } from "@/shared/lib/utils";
import { apiErrorMessage, useFormat, useT } from "@/shared/lib/i18n";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./viewer-chrome";

interface ArchiveViewerProps {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  fileId: string;
}

interface ArchiveEntry {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  compressedSize: number;
  date: string;
}

interface ArchiveData {
  entries: ArchiveEntry[];
  summary: {
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
    totalCompressedSize: number;
    format: string;
  };
}

/** Extensions the extract endpoint can hand back as something viewable here. */
const PREVIEW_EXTENSIONS = new Set([
  "txt", "md", "mdx", "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "cpp", "h", "hpp", "cs", "php", "html", "htm", "css", "scss",
  "less", "sass", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "vue",
  "svelte", "astro", "env", "gitignore", "dockerignore", "log", "csv", "tsv",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function iconFor(name: string): LucideIcon {
  const ext = extOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return FileImage;
  if (["js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "html", "css"].includes(ext)) {
    return FileCode;
  }
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return FileAudio;
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return FileVideo;
  return FileText;
}

type Node = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  children: Node[];
};

/**
 * Turns the flat entry list into a real tree. The previous renderer filtered the
 * same flat array at every level, which meant nested folders never appeared and
 * an expanded folder re-rendered the whole list underneath itself.
 */
function buildTree(entries: ArchiveEntry[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, size: 0, children: [] };
  const dirs = new Map<string, Node>([["", root]]);

  const ensureDir = (path: string): Node => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? root : ensureDir(path.slice(0, slash));
    const node: Node = {
      name: path.slice(slash + 1),
      path,
      dir: true,
      size: 0,
      children: [],
    };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const entry of entries) {
    const clean = entry.path.replace(/^\/+|\/+$/g, "");
    if (!clean) continue;
    if (entry.dir) {
      ensureDir(clean);
      continue;
    }
    const slash = clean.lastIndexOf("/");
    const parent = slash === -1 ? root : ensureDir(clean.slice(0, slash));
    parent.children.push({
      name: entry.name || clean.slice(slash + 1),
      path: clean,
      dir: false,
      size: entry.size,
      children: [],
    });
  }

  const sort = (node: Node) => {
    node.children.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

interface RowsProps {
  nodes: Node[];
  depth: number;
  /** Folders are open unless collapsed, so no state has to be derived from data. */
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (node: Node) => void;
}

function ArchiveRows({ nodes, depth, collapsed, onToggle, onOpen }: RowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const indent = { paddingLeft: `${12 + depth * 16}px` };

        if (node.dir) {
          const open = !collapsed.has(node.path);
          return (
            <div key={node.path}>
              <button
                type="button"
                onClick={() => onToggle(node.path)}
                aria-expanded={open}
                style={indent}
                className="flex min-h-9 w-full items-center gap-1.5 pr-3 text-left text-xs text-foreground transition-colors hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                {open ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-warning-ink" aria-hidden="true" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-warning-ink" aria-hidden="true" />
                )}
                <span className="truncate font-medium">{node.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {node.children.length}
                </span>
              </button>
              {open && node.children.length > 0 && (
                <ArchiveRows
                  nodes={node.children}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              )}
            </div>
          );
        }

        const canPreview = PREVIEW_EXTENSIONS.has(extOf(node.name));
        return (
          <ArchiveFileRow
            key={node.path}
            node={node}
            icon={iconFor(node.name)}
            style={indent}
            canPreview={canPreview}
            onOpen={onOpen}
          />
        );
      })}
    </>
  );
}

function ArchiveFileRow({
  node,
  icon: Icon,
  style,
  canPreview,
  onOpen,
}: {
  node: Node;
  /** Resolved by the parent so the row never builds a component while rendering. */
  icon: LucideIcon;
  style?: React.CSSProperties;
  canPreview: boolean;
  onOpen: (node: Node) => void;
}) {
  const t = useT();
  const { formatBytes } = useFormat();
  const label = canPreview
    ? t("files.viewer.archive.previewEntry", { name: node.name })
    : t("files.viewer.archive.noPreviewEntry", { name: node.name });
  return (
    <button
      type="button"
      onClick={() => canPreview && onOpen(node)}
      aria-label={label}
      title={canPreview ? undefined : t("files.viewer.archive.noPreviewHint")}
      style={style}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 pr-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
        canPreview ? "cursor-pointer hover:bg-accent/5" : "cursor-default"
      )}
    >
      <Icon
        className={cn("h-4 w-4 shrink-0", canPreview ? "text-muted-foreground" : "text-muted-foreground/50")}
        aria-hidden="true"
      />
      <span className={cn("flex-1 truncate text-xs", !canPreview && "text-muted-foreground")}>
        {node.name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(node.size)}</span>
    </button>
  );
}

type Preview =
  | { kind: "text"; path: string; name: string; body: string }
  | { kind: "image"; path: string; name: string; url: string };

export function ArchiveViewer({ fileName, sizeBytes, fileId }: ArchiveViewerProps) {
  const t = useT();
  const { formatBytes } = useFormat();
  const [data, setData] = useState<ArchiveData | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * The API's own reply, kept raw rather than turned into a sentence here: the
   * fetch runs once, but the reader may change language afterwards, and
   * `apiErrorMessage` picks the words at render time.
   */
  const [failure, setFailure] = useState<{ error?: string; code?: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Every object URL we hand to an <img> has to be released, or previewing a few
  // images inside one archive leaks the whole decoded payload.
  const objectUrl = useRef<string | null>(null);
  const releaseObjectUrl = useCallback(() => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, []);
  useEffect(() => releaseObjectUrl, [releaseObjectUrl]);

  /** The container format, read off the name. A product name in every language. */
  const format = useMemo(() => {
    const ext = extOf(fileName);
    if (ext === "zip") return "ZIP";
    if (ext === "rar") return "RAR";
    if (ext === "7z") return "7-Zip";
    if (ext === "tar") return "TAR";
    if (ext === "gz" || ext === "tgz") return "GZip";
    return "";
  }, [fileName]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/files/${fileId}/archive/listing`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) {
          setData(json.data);
          setFailure(null);
        } else {
          setFailure({ error: json.error, code: json.code });
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailure({});
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, attempt]);

  const tree = useMemo(() => buildTree(data?.entries ?? []), [data]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !data) return null;
    return data.entries
      .filter((e) => !e.dir && e.path.toLowerCase().includes(needle))
      .slice(0, 200)
      .map<Node>((e) => ({
        name: e.path.replace(/^\/+/, ""),
        path: e.path,
        dir: false,
        size: e.size,
        children: [],
      }));
  }, [data, query]);

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openEntry = useCallback(
    async (node: Node) => {
      const ext = extOf(node.name);
      const isImage = IMAGE_EXTENSIONS.has(ext);
      releaseObjectUrl();
      setPreview(null);
      setPreviewFailed(false);
      setPreviewName(node.name);
      setPreviewLoading(true);
      try {
        const res = await fetch(
          `/api/files/${fileId}/archive/extract?path=${encodeURIComponent(node.path)}`
        );
        if (!res.ok) throw new Error(String(res.status));
        if (isImage) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          objectUrl.current = url;
          setPreview({ kind: "image", path: node.path, name: node.name, url });
        } else {
          const body = await res.text();
          setPreview({ kind: "text", path: node.path, name: node.name, body });
        }
      } catch {
        setPreviewFailed(true);
      } finally {
        setPreviewLoading(false);
      }
    },
    [fileId, releaseObjectUrl]
  );

  const closePreview = useCallback(() => {
    releaseObjectUrl();
    setPreview(null);
    setPreviewFailed(false);
    setPreviewName(null);
    setPreviewLoading(false);
  }, [releaseObjectUrl]);

  if (loading) return <ViewerLoading label={t("files.preview.loading.archive")} />;

  if (failure) {
    return (
      <ViewerMessage
        icon={Archive}
        tone="danger"
        title={t("files.viewer.archive.cannotList")}
        hint={apiErrorMessage(failure, t, "files.viewer.archive.listFailed")}
        onRetry={() => {
          setLoading(true);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (!data || data.entries.length === 0) {
    return (
      <ViewerMessage
        icon={Archive}
        title={t("files.viewer.archive.emptyTitle")}
        hint={t("files.viewer.archive.emptyHint")}
      />
    );
  }

  const { summary } = data;
  const ratio =
    summary.totalSize > 0
      ? Math.round((1 - summary.totalCompressedSize / summary.totalSize) * 100)
      : 0;
  const rows = matches ?? tree;

  return (
    <div className="relative flex h-full flex-col bg-surface">
      <ViewerBar
        icon={Archive}
        fileName={fileName}
        tone="warning"
        meta={
          <Badge tone="warning">
            {summary.format || format || t("files.type.archive")}
          </Badge>
        }
      />

      <div className="shrink-0 border-b border-border/40 px-3 py-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("files.viewer.archive.search")}
            aria-label={t("files.viewer.archive.search")}
            className="h-9 pl-9 pr-9"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("files.browser.clearSearch")}
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
        {matches && (
          <p role="status" className="mt-1.5 px-1 text-xs text-muted-foreground">
            {matches.length === 0
              ? t("files.viewer.archive.noMatch")
              : t("files.viewer.archive.matches", { count: matches.length })}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length > 0 && (
          <ArchiveRows
            nodes={rows}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            onOpen={(node) => void openEntry(node)}
          />
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 bg-surface/70 px-4 py-2 text-xs text-muted-foreground">
        <span>{t("files.viewer.archive.fileCount", { count: summary.totalFiles })}</span>
        <span>{t("files.viewer.archive.folderCount", { count: summary.totalFolders })}</span>
        <span>
          {t("files.viewer.archive.uncompressed", { size: formatBytes(summary.totalSize) })}
        </span>
        <span className="ml-auto">
          {t("files.viewer.archive.onDisk", { size: formatBytes(sizeBytes) })}
          {ratio > 0 && ` · ${t("files.viewer.archive.smaller", { count: ratio })}`}
        </span>
      </div>

      {(previewName || previewLoading) && (
        <ArchivePreview
          name={previewName ?? ""}
          loading={previewLoading}
          failed={previewFailed}
          preview={preview}
          onClose={closePreview}
        />
      )}
    </div>
  );
}

/**
 * Entry preview, layered over the tree rather than replacing it: the listing
 * stays scrolled where it was, so closing the preview returns the user to the
 * exact row they came from. Escape is left to the surrounding modal on purpose —
 * the explicit Back control is the way out of here.
 */
function ArchivePreview({
  name,
  loading,
  failed,
  preview,
  onClose,
}: {
  name: string;
  loading: boolean;
  failed: boolean;
  preview: Preview | null;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-surface/70 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.archive.back")}
          onClick={onClose}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={name}>
          {name}
        </span>
        {preview?.kind === "image" && (
          <a
            href={preview.url}
            download={preview.name}
            aria-label={t("files.viewer.archive.downloadEntry", { name: preview.name })}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <ViewerLoading label={t("files.viewer.archive.extracting")} />}

        {!loading && failed && (
          <ViewerMessage
            icon={Archive}
            tone="danger"
            title={t("files.viewer.archive.entryUnavailable")}
            hint={t("files.viewer.archive.entryFailed")}
          />
        )}

        {!loading && !failed && preview?.kind === "text" && (
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
            {preview.body || t("files.viewer.archive.entryEmpty")}
          </pre>
        )}

        {!loading && !failed && preview?.kind === "image" && (
          <div className="checkerboard flex h-full items-center justify-center p-4">
            {/* Extracted from an archive into a blob URL, so next/image cannot optimise it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview.url}
              alt={preview.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
      </div>
    </div>
  );
}
