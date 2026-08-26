"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Download, Eye, EyeOff, FileText, Info, Keyboard, Lock, Maximize2, Minimize2,
  Share2, ShieldAlert, SlidersHorizontal, Unlock, X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/system/spinner";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import type { File as FileRecord } from "@/lib/db/schema";
import {
  decryptToBlob,
  isEncryptionMeta,
  type EncryptionMetaV1,
} from "@/lib/crypto/client-encryption";
import { detectPreviewKind, previewKindLabel } from "@/lib/preview/detect-preview-type";
import { mediaEditorKindFor } from "@/lib/files/media-edit";
import { requestDownload } from "@/lib/download/download-actions";
import { isTypingTarget } from "@/components/media-viewers/viewer-chrome";
import { ShareDialog } from "./share-dialog";
import { FileVersionsPanel } from "./file-versions-panel";

const ImageViewer = dynamic(() => import("@/components/media-viewers/image-viewer").then((m) => m.ImageViewer), { ssr: false, loading: () => <PreviewSkeleton label="Image" /> });
const VideoViewer = dynamic(() => import("@/components/media-viewers/video-viewer").then((m) => m.VideoViewer), { ssr: false, loading: () => <PreviewSkeleton label="Video" /> });
const AudioViewer = dynamic(() => import("@/components/media-viewers/audio-viewer").then((m) => m.AudioViewer), { ssr: false, loading: () => <PreviewSkeleton label="Audio" /> });
const PdfViewer = dynamic(() => import("@/components/media-viewers/pdf-viewer").then((m) => m.PdfViewer), { ssr: false, loading: () => <PreviewSkeleton label="PDF" /> });
const TextViewer = dynamic(() => import("@/components/media-viewers/text-viewer").then((m) => m.TextViewer), { ssr: false, loading: () => <PreviewSkeleton label="Code" /> });
const CsvViewer = dynamic(() => import("@/components/media-viewers/csv-viewer").then((m) => m.CsvViewer), { ssr: false, loading: () => <PreviewSkeleton label="Table" /> });
const SpreadsheetViewer = dynamic(() => import("@/components/media-viewers/spreadsheet-viewer").then((m) => m.SpreadsheetViewer), { ssr: false, loading: () => <PreviewSkeleton label="Spreadsheet" /> });
const DocxViewer = dynamic(() => import("@/components/media-viewers/docx-viewer").then((m) => m.DocxViewer), { ssr: false, loading: () => <PreviewSkeleton label="Document" /> });
const PptxViewer = dynamic(() => import("@/components/media-viewers/pptx-viewer").then((m) => m.PptxViewer), { ssr: false, loading: () => <PreviewSkeleton label="Presentation" /> });
const SvgViewer = dynamic(() => import("@/components/media-viewers/svg-viewer").then((m) => m.SvgViewer), { ssr: false, loading: () => <PreviewSkeleton label="SVG" /> });
const ArchiveViewer = dynamic(() => import("@/components/media-viewers/archive-viewer").then((m) => m.ArchiveViewer), { ssr: false, loading: () => <PreviewSkeleton label="Archive" /> });
const ImageEditPanel = dynamic(() => import("@/components/editors/image-edit-panel"), { ssr: false, loading: () => <PreviewSkeleton label="Editor" /> });
const MediaTrimPanel = dynamic(() => import("@/components/editors/media-trim-panel"), { ssr: false, loading: () => <PreviewSkeleton label="Trimmer" /> });

interface FilePreviewProps {
  file: FileRecord;
  onClose: () => void;
  /**
   * Whether this viewer may write back over the file. Off by default so a surface that
   * has not thought about permissions cannot hand out an editor.
   */
  canEdit?: boolean;
  /** A viewer saved the file; the listing behind this preview is now stale. */
  onSaved?: () => void;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Visual media reads best on a dark stage; everything else gets the checkerboard. */
const STAGE_KINDS = new Set(["image", "svg", "video", "presentation"]);

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Esc", action: "Close the preview" },
  { keys: "Space", action: "Play or pause media" },
  { keys: "← →", action: "Seek media, or change PDF page" },
  { keys: "+ −", action: "Zoom an image" },
  { keys: "?", action: "Show or hide this list" },
];

function PreviewSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <Spinner size="lg" />
      <p role="status" className="text-xs text-muted-foreground">
        <span className="loading-text-shimmer">Loading {label.toLowerCase()}…</span>
      </p>
    </div>
  );
}

export function FilePreview({ file, onClose, canEdit = false, onSaved }: FilePreviewProps) {
  const previewKind = useMemo(
    () => detectPreviewKind(file.mimeType, file.name),
    [file.mimeType, file.name]
  );

  const [fullscreen, setFullscreen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** Set by an inner editor while its draft differs from what the server holds. */
  const [editorDirty, setEditorDirty] = useState(false);
  /**
   * Which exit is waiting on an answer, or `null`.
   *
   * Closing the preview and leaving the editor both throw an unsent draft away, so both
   * ask first — and the prompt has to say which one it is about.
   */
  const [unsavedPrompt, setUnsavedPrompt] = useState<"close" | "editor" | null>(null);
  /** The media editor is showing instead of the plain viewer. */
  const [editing, setEditing] = useState(false);
  /**
   * Bumped after an edit that rewrote the object.
   *
   * The preview route answers with `Cache-Control: private, max-age=300`, so the browser
   * would keep serving the pre-edit bytes from its own cache. The route ignores unknown
   * query parameters, which makes this the cheapest honest cache-buster available.
   */
  const [reloadToken, setReloadToken] = useState(0);

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const uid = useId();
  const titleId = `${uid}-title`;
  const infoTitleId = `${uid}-info`;
  const shortcutsTitleId = `${uid}-shortcuts`;
  const unsavedTitleId = `${uid}-unsaved`;

  const isEncrypted = !!file.encrypted;

  const streamUrl = useMemo(() => {
    if (file.isNote) return null;
    if (isEncrypted) return decryptedUrl;
    const base = `/api/files/${file.id}/preview`;
    return reloadToken > 0 ? `${base}?v=${reloadToken}` : base;
  }, [file.id, file.isNote, isEncrypted, decryptedUrl, reloadToken]);

  /**
   * Which editor this file can have, if any. The rule itself lives beside the geometry it
   * guards, so the panel, this button and the route cannot drift apart.
   */
  const editKind = useMemo(
    () =>
      mediaEditorKindFor({
        canEdit,
        encrypted: isEncrypted,
        isNote: !!file.isNote,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        previewKind,
      }),
    [canEdit, isEncrypted, file.isNote, file.sizeBytes, file.mimeType, previewKind]
  );

  /**
   * The editor mode outlives a single file — the preview can be handed a different row —
   * so the flag is read through what this file can actually offer instead of on its own.
   */
  const inEditor = editing && editKind !== null;

  useEffect(() => {
    return () => {
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
    };
  }, [decryptedUrl]);
  // The preview covers the page, so the page behind it must not scroll, and the
  // keyboard user has to land back on the row they opened when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const restore = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = restore;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  /**
   * The one door out. Escape, the backdrop and the X button all go through here, because
   * every one of them is a single gesture away from throwing an unsaved edit away — the
   * inner editor reports its draft state, and closing asks before discarding it.
   */
  const requestClose = useCallback(() => {
    if (editorDirty) {
      setUnsavedPrompt("close");
      return;
    }
    onClose();
  }, [editorDirty, onClose]);

  /** Leaving the editor loses the same draft closing would, so it asks the same question. */
  const toggleEditing = useCallback(() => {
    if (inEditor && editorDirty) {
      setUnsavedPrompt("editor");
      return;
    }
    setEditing(!inEditor);
  }, [inEditor, editorDirty]);

  /** The editor is gone, so nothing is holding a draft any more. */
  const leaveEditor = useCallback(() => {
    setUnsavedPrompt(null);
    setEditorDirty(false);
    setEditing(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Innermost layer first. The share dialog is not listed: it owns Escape
        // while open and stops the event before it reaches this listener.
        if (showShortcuts) setShowShortcuts(false);
        else if (showInfo) setShowInfo(false);
        else if (unsavedPrompt) setUnsavedPrompt(null);
        else if (fullscreen) setFullscreen(false);
        else requestClose();
        return;
      }
      if (e.key === "?" && !isTypingTarget(e.target)) {
        setShowShortcuts((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, fullscreen, showInfo, showShortcuts, unsavedPrompt]);

  /** Focus stays inside the preview while it is up. */
  const trapTab = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const handleDownload = useCallback(() => requestDownload(file), [file]);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const meta = file.encryptionMeta;
      if (!isEncryptionMeta(meta)) {
        throw new Error("This file has no usable encryption metadata.");
      }
      const res = await fetch(`/api/files/${file.id}/preview`);
      if (!res.ok) throw new Error("The encrypted file could not be fetched.");
      const cipher = await res.arrayBuffer();
      const blob = await decryptToBlob(cipher, passphrase, meta as EncryptionMetaV1, file.mimeType);
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
      setDecryptedUrl(URL.createObjectURL(blob));
    } catch (err) {
      setUnlockError(
        err instanceof Error ? err.message : "That passphrase did not unlock this file."
      );
    } finally {
      setUnlocking(false);
    }
  }

  function renderContent() {
    if (isEncrypted && !decryptedUrl) {
      return (
        <div className="flex h-full flex-col items-center justify-center bg-surface px-4 text-center">
          <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-warning/10 ring-1 ring-warning/20">
            <Lock className="h-7 w-7 text-warning" aria-hidden="true" />
          </span>
          <p className="text-sm font-semibold text-foreground">This file is encrypted</p>
          <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
            Enter the passphrase you set when uploading it. Decryption happens in this
            browser — the passphrase is never sent anywhere.
          </p>
          <form onSubmit={handleUnlock} className="mt-4 w-full max-w-xs space-y-2">
            <div className="relative">
              <Input
                type={showPassphrase ? "text" : "password"}
                placeholder="Passphrase"
                aria-label="Passphrase"
                autoComplete="off"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoFocus
                className="pr-11"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                aria-pressed={showPassphrase}
                onClick={() => setShowPassphrase((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
              >
                {showPassphrase ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </div>
            {unlockError && (
              <p role="alert" className="flex items-center justify-center gap-1.5 text-xs text-danger">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {unlockError}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={unlocking || !passphrase}>
              {unlocking ? (
                <Spinner size="sm" />
              ) : (
                <Unlock className="h-4 w-4" aria-hidden="true" />
              )}
              {unlocking ? "Decrypting…" : "Unlock"}
            </Button>
          </form>
        </div>
      );
    }

    const unsupported = (
      <div className="flex h-full flex-col items-center justify-center bg-surface px-6 text-center">
        <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <FileText className="h-7 w-7" aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-foreground">No preview for this file type</p>
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
          {file.isNote
            ? "Open this note in the editor to read it."
            : `${previewKindLabel(previewKind)} files cannot be shown inline yet. Download it to open it locally.`}
        </p>
        {!file.isNote && (
          <Button className="mt-4" onClick={handleDownload}>
            <Download className="h-4 w-4" aria-hidden="true" /> Download
          </Button>
        )}
      </div>
    );

    // Notes keep their body in the database and archives are read server-side, so
    // those are the only kinds that can legitimately arrive without a stream URL.
    if (!streamUrl && previewKind !== "archive") return unsupported;

    // The editor replaces the viewer rather than sitting beside it: both want the whole
    // stage, and an edit is a deliberate mode the user turned on from the header.
    if (inEditor && streamUrl && editKind === "image") {
      return (
        <ImageEditPanel
          /* Keyed by file: a new file must never inherit the previous draft. */
          key={file.id}
          src={streamUrl}
          fileId={file.id}
          fileName={file.name}
          mimeType={file.mimeType}
          onDirtyChange={setEditorDirty}
          onSaved={(result) => {
            // An in-place save rewrote the object behind a URL the browser has cached
            // for five minutes, so the stream needs a new query to be re-fetched. A copy
            // left this file's bytes alone, so the current view is still correct.
            if (!result.savedAsCopy) setReloadToken((token) => token + 1);
            onSaved?.();
          }}
        />
      );
    }

    if (inEditor && streamUrl && editKind === "trim") {
      return (
        <MediaTrimPanel
          key={file.id}
          src={streamUrl}
          fileId={file.id}
          fileName={file.name}
          mimeType={file.mimeType}
          onDirtyChange={setEditorDirty}
          /* Queued, not done — the worker still has to remux, so there is nothing new to
             re-fetch yet. The row is re-read so its version and size catch up when it is. */
          onQueued={() => onSaved?.()}
        />
      );
    }

    switch (previewKind) {
      case "pdf":
        return streamUrl ? <PdfViewer fileId={file.id} previewUrl={streamUrl} fileName={file.name} /> : null;
      case "image":
        return streamUrl ? <ImageViewer src={streamUrl} fileName={file.name} mimeType={file.mimeType} /> : null;
      case "svg":
        return streamUrl ? <SvgViewer src={streamUrl} fileName={file.name} /> : null;
      case "video":
        return streamUrl ? <VideoViewer src={streamUrl} fileName={file.name} /> : null;
      case "audio":
        return streamUrl ? <AudioViewer src={streamUrl} fileName={file.name} /> : null;
      case "text":
        return streamUrl ? (
          <TextViewer
            /* Keyed by file: a new file must never inherit the previous draft. */
            key={file.id}
            src={streamUrl}
            fileName={file.name}
            mimeType={file.mimeType}
            /* Editing needs a target and a permission. An encrypted file is decrypted in
               this browser, so what the viewer holds is plaintext that must not be written
               back over the ciphertext — no id here means read-only. */
            fileId={canEdit && !isEncrypted ? file.id : undefined}
            version={file.version}
            canEdit={canEdit && !isEncrypted}
            onDirtyChange={setEditorDirty}
            onSaved={onSaved}
          />
        ) : null;
      case "csv":
        return streamUrl ? <CsvViewer src={streamUrl} fileName={file.name} /> : null;
      case "spreadsheet":
        return streamUrl ? (
          <SpreadsheetViewer src={streamUrl} fileName={file.name} fileId={file.id} />
        ) : null;
      case "document":
        return streamUrl ? (
          <DocxViewer src={streamUrl} fileName={file.name} fileId={file.id} />
        ) : null;
      case "presentation":
        return streamUrl ? (
          <PptxViewer src={streamUrl} fileName={file.name} fileId={file.id} />
        ) : null;
      case "archive":
        // Archives are read server-side from the stored object, so they need no
        // stream URL — but an encrypted one cannot be opened without the key.
        if (!isEncrypted) {
          return (
            <ArchiveViewer
              fileName={file.name}
              mimeType={file.mimeType}
              sizeBytes={file.sizeBytes}
              fileId={file.id}
            />
          );
        }
        break;
    }

    return unsupported;
  }

  const kindLabel = previewKindLabel(previewKind);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.15 }}
      // z-50 is the documented layer for full-screen surfaces; dialogs opened
      // from here (share) sit above it at z-80.
      className={cn("scrim fixed inset-0 z-50 flex", fullscreen ? "p-0" : "p-2 sm:p-4 lg:p-8")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        initial={reduceMotion ? { opacity: 0 } : { scale: 0.97, opacity: 0, y: 8 }}
        animate={reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { scale: 0.97, opacity: 0, y: 8 }}
        transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }}
        className={cn(
          "relative mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden",
          "rounded-2xl border border-border/40 bg-surface shadow-2xl",
          fullscreen && "max-w-none rounded-none"
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-surface/95 px-3 py-2 backdrop-blur-sm sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Badge tone="accent" className="uppercase tracking-wide">
              {kindLabel}
            </Badge>
            <div className="min-w-0">
              <h2
                id={titleId}
                className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground"
              >
                {isEncrypted && (
                  <>
                    <Lock className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
                    <span className="sr-only">Encrypted.</span>
                  </>
                )}
                <span className="truncate">{file.name}</span>
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {editKind && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={editKind === "image" ? "Edit this image" : "Trim this clip"}
                aria-pressed={inEditor}
                className={cn(inEditor && "text-accent")}
                onClick={toggleEditing}
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Keyboard shortcuts"
              aria-expanded={showShortcuts}
              onClick={() => setShowShortcuts((v) => !v)}
            >
              <Keyboard className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Download file" onClick={handleDownload}>
              <Download className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Share this file"
              onClick={() => setShowShare(true)}
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="File details"
              aria-expanded={showInfo}
              onClick={() => setShowInfo((v) => !v)}
            >
              <Info className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={fullscreen ? "Exit full screen" : "Fill the screen"}
              aria-pressed={fullscreen}
              onClick={() => setFullscreen((v) => !v)}
            >
              {fullscreen ? (
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <Button variant="ghost" size="icon" aria-label="Close preview" onClick={requestClose}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 flex-1",
            STAGE_KINDS.has(previewKind) ? "bg-viewer-stage" : "checkerboard"
          )}
        >
          {renderContent()}
        </div>

        {unsavedPrompt && (
          <div
            role="alertdialog"
            aria-labelledby={unsavedTitleId}
            className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-warning/20 bg-warning/5 px-4 py-3"
          >
            <p id={unsavedTitleId} className="text-xs text-warning">
              {unsavedPrompt === "editor"
                ? "This edit hasn't been saved. Leaving the editor discards it."
                : "This file has unsaved changes. Closing the preview discards them."}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setUnsavedPrompt(null)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={unsavedPrompt === "editor" ? leaveEditor : onClose}
              >
                {unsavedPrompt === "editor" ? "Discard the edit" : "Discard and close"}
              </Button>
            </div>
          </div>
        )}

        <AnimatePresence>
          {showShortcuts && (
            <motion.div
              role="group"
              aria-labelledby={shortcutsTitleId}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              transition={{ duration: reduceMotion ? 0 : 0.15 }}
              className="absolute bottom-4 left-4 z-20 w-64 rounded-xl border border-border/40 bg-surface-elevated/95 p-3 shadow-lg backdrop-blur-sm"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <p id={shortcutsTitleId} className="text-xs font-semibold text-foreground">
                  Keyboard
                </p>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Hide keyboard shortcuts"
                  onClick={() => setShowShortcuts(false)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
              <dl className="space-y-1.5">
                {SHORTCUTS.map((s) => (
                  <div key={s.keys} className="flex items-center justify-between gap-3">
                    <dt>
                      <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {s.keys}
                      </kbd>
                    </dt>
                    <dd className="text-xs text-muted-foreground">{s.action}</dd>
                  </div>
                ))}
              </dl>
            </motion.div>
          )}
        </AnimatePresence>

        {showInfo && (
          <div
            role="group"
            aria-labelledby={infoTitleId}
            className="absolute right-3 top-14 z-20 max-h-[70vh] w-80 max-w-[calc(100%-1.5rem)] space-y-4 overflow-y-auto rounded-xl border border-border/50 bg-surface-elevated p-4 shadow-xl"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3
                  id={infoTitleId}
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  File details
                </h3>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Hide file details"
                  onClick={() => setShowInfo(false)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
              <dl className="space-y-1.5 text-xs">
                <Row label="Name">
                  <span className="truncate font-mono" title={file.name}>
                    {file.name}
                  </span>
                </Row>
                <Row label="Type">
                  <span className="truncate font-mono" title={file.mimeType}>
                    {file.mimeType}
                  </span>
                </Row>
                <Row label="Preview">{kindLabel}</Row>
                <Row label="Size">{formatBytes(file.sizeBytes)}</Row>
                <Row label="Created">{formatDate(file.createdAt)}</Row>
                {isEncrypted && (
                  <Row label="Encryption">
                    <Badge tone="warning">AES-GCM</Badge>
                  </Row>
                )}
              </dl>
            </div>
            {!file.isNote && <FileVersionsPanel fileId={file.id} />}
          </div>
        )}

        {showShare && (
          <ShareDialog
            fileId={file.id}
            fileName={file.name}
            fileType={file.mimeType}
            isNote={file.isNote}
            onClose={() => setShowShare(false)}
          />
        )}
      </motion.div>
    </motion.div>
  );
}

/** One label/value pair in the details panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 justify-end text-foreground">{children}</dd>
    </div>
  );
}
