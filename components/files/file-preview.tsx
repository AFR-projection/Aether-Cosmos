"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo } from "react";
import {
  Download, Share2, Info, Maximize2, Minimize2, X,
  AlertCircle, FileText, Lock, Unlock, Loader2, Keyboard,
  Eye, EyeOff, ShieldAlert,
} from "lucide-react";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { File as FileRecord } from "@/lib/db/schema";
import dynamic from "next/dynamic";
import { ShareDialog } from "./share-dialog";
import { FileVersionsPanel } from "./file-versions-panel";
import {
  decryptToBlob,
  isEncryptionMeta,
  type EncryptionMetaV1,
} from "@/lib/crypto/client-encryption";
import { detectPreviewKind, previewKindLabel } from "@/lib/preview/detect-preview-type";
import { requestDownload } from "@/lib/download/download-actions";
import { Spinner } from "@/components/system/spinner";

const ImageViewer = dynamic(() => import("@/components/media-viewers/image-viewer").then((m) => m.ImageViewer), { ssr: false, loading: () => <PreviewSkeleton label="Image" /> });
const VideoViewer = dynamic(() => import("@/components/media-viewers/video-viewer").then((m) => m.VideoViewer), { ssr: false, loading: () => <PreviewSkeleton label="Video" /> });
const AudioViewer = dynamic(() => import("@/components/media-viewers/audio-viewer").then((m) => m.AudioViewer), { ssr: false, loading: () => <PreviewSkeleton label="Audio" /> });
const PdfViewer = dynamic(() => import("@/components/media-viewers/pdf-viewer").then((m) => m.PdfViewer), { ssr: false, loading: () => <PreviewSkeleton label="PDF" /> });
const TextViewer = dynamic(() => import("@/components/media-viewers/text-viewer").then((m) => m.TextViewer), { ssr: false, loading: () => <PreviewSkeleton label="Code" /> });
const CsvViewer = dynamic(() => import("@/components/media-viewers/csv-viewer").then((m) => m.CsvViewer), { ssr: false, loading: () => <PreviewSkeleton label="Table" /> });
const SpreadsheetViewer = dynamic(() => import("@/components/media-viewers/spreadsheet-viewer").then((m) => m.SpreadsheetViewer), { ssr: false, loading: () => <PreviewSkeleton label="Excel" /> });
const DocxViewer = dynamic(() => import("@/components/media-viewers/docx-viewer").then((m) => m.DocxViewer), { ssr: false, loading: () => <PreviewSkeleton label="Word" /> });
const PptxViewer = dynamic(() => import("@/components/media-viewers/pptx-viewer").then((m) => m.PptxViewer), { ssr: false, loading: () => <PreviewSkeleton label="PowerPoint" /> });
const SvgViewer = dynamic(() => import("@/components/media-viewers/svg-viewer").then((m) => m.SvgViewer), { ssr: false, loading: () => <PreviewSkeleton label="SVG" /> });
const ArchiveViewer = dynamic(() => import("@/components/media-viewers/archive-viewer").then((m) => m.ArchiveViewer), { ssr: false, loading: () => <PreviewSkeleton label="Archive" /> });

interface FilePreviewProps {
  file: FileRecord;
  onClose: () => void;
}

function PreviewSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <Spinner size="lg" />
      <p className="text-xs text-muted-foreground">
        <span className="loading-text-shimmer">Loading {label.toLowerCase()}…</span>
      </p>
    </div>
  );
}

export function FilePreview({ file, onClose }: FilePreviewProps) {
  const previewKind = useMemo(
    () => detectPreviewKind(file.mimeType, file.name),
    [file.mimeType, file.name]
  );

  const [fullscreen, setFullscreen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);

  const isEncrypted = !!file.encrypted;

  const streamUrl = useMemo(() => {
    if (file.isNote) return null;
    if (isEncrypted) return decryptedUrl;
    return `/api/files/${file.id}/preview`;
  }, [file.id, file.isNote, isEncrypted, decryptedUrl]);

  useEffect(() => {
    return () => {
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
    };
  }, [decryptedUrl]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showInfo) setShowInfo(false);
        else if (showShare) setShowShare(false);
        else if (fullscreen) setFullscreen(false);
        else onClose();
      }
      if (e.key === "?" && e.shiftKey) setShowShortcuts((v) => !v);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, fullscreen, showInfo, showShare]);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const meta = file.encryptionMeta;
      if (!isEncryptionMeta(meta)) {
        throw new Error("Missing encryption metadata");
      }
      const res = await fetch(`/api/files/${file.id}/preview`);
      if (!res.ok) throw new Error("Failed to fetch encrypted file");
      const cipher = await res.arrayBuffer();
      const blob = await decryptToBlob(cipher, passphrase, meta as EncryptionMetaV1, file.mimeType);
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
      setDecryptedUrl(URL.createObjectURL(blob));
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Unlock failed");
    } finally {
      setUnlocking(false);
    }
  }

  function renderContent() {
    if (isEncrypted && !decryptedUrl) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center px-4 bg-card">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/20">
            <Lock className="h-8 w-8 text-amber-500" />
          </div>
          <p className="text-sm font-semibold">Encrypted file</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter your passphrase to decrypt and preview
          </p>
          <form onSubmit={handleUnlock} className="mt-4 w-full max-w-xs space-y-2">
            <div className="relative">
              <Input
                type={showPassphrase ? "text" : "password"}
                placeholder="Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoFocus
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassphrase((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {unlockError && (
              <p className="flex items-center justify-center gap-1 text-xs text-danger">
                <ShieldAlert className="h-3.5 w-3.5" /> {unlockError}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={unlocking || !passphrase}>
              {unlocking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlock className="mr-2 h-4 w-4" />}
              {unlocking ? "Decrypting…" : "Unlock"}
            </Button>
          </form>
        </div>
      );
    }

    if (!streamUrl && previewKind !== "archive") {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-card">
          <FileText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm">Preview tidak tersedia</p>
        </div>
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
        return streamUrl ? <TextViewer src={streamUrl} fileName={file.name} mimeType={file.mimeType} /> : null;
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
        if (!isEncrypted) {
          return <ArchiveViewer fileName={file.name} mimeType={file.mimeType} sizeBytes={file.sizeBytes} fileId={file.id} />;
        }
        break;
    }

    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-card">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/5">
          <FileText className="h-8 w-8 text-accent/40" />
        </div>
        <p className="text-sm font-medium">Preview tidak tersedia</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Tipe file ini belum didukung untuk preview inline</p>
        <Button className="mt-4" onClick={() => requestDownload(file)}>
          <Download className="h-4 w-4 mr-1.5" /> Download
        </Button>
      </div>
    );
  }

  const kindLabel = previewKindLabel(previewKind);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className={cn(
          "scrim fixed inset-0 z-50 flex",
          fullscreen ? "p-0" : "p-2 sm:p-4 lg:p-8"
        )}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.97, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.97, opacity: 0, y: 8 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className={cn(
            "relative flex flex-col bg-card border border-border/40 shadow-2xl overflow-hidden mx-auto",
            "rounded-2xl w-full max-w-6xl h-full",
            fullscreen && "max-w-none rounded-none"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40 bg-card/95 backdrop-blur-sm shrink-0">
            <div className="flex-1 min-w-0 flex items-center gap-2.5">
              <span className="shrink-0 rounded-md bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                {kindLabel}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold truncate flex items-center gap-1.5">
                  {isEncrypted && <Lock className="h-3 w-3 text-amber-500 shrink-0" />}
                  {file.name}
                </h3>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-0.5 ml-3 shrink-0">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowShortcuts((v) => !v)} title="Shortcuts">
                <Keyboard className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => requestDownload(file)} title="Download">
                <Download className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowShare(true)} title="Share">
                <Share2 className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowInfo(!showInfo)} title="Info">
                <Info className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setFullscreen(!fullscreen)} title="Fullscreen">
                {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} title="Close (Esc)">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className={cn(
            "flex-1 min-h-0",
            previewKind === "video" || previewKind === "image" || previewKind === "svg" || previewKind === "presentation"
              ? "bg-black"
              : "bg-[repeating-conic-gradient(#262626_0%_25%,#1a1a1a_0%_50%)] bg-[length:16px_16px]"
          )}>
            {renderContent()}
          </div>

          {/* Shortcuts hint */}
          <AnimatePresence>
            {showShortcuts && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                className="absolute bottom-4 left-4 rounded-xl border border-border/40 bg-card/95 backdrop-blur-sm shadow-lg p-3 text-[11px] space-y-1 z-20"
              >
                <p className="font-semibold text-xs mb-2">Keyboard</p>
                <p><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">Esc</kbd> Tutup</p>
                <p><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">Space</kbd> Play/Pause (media)</p>
                <p><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">← →</kbd> Seek / halaman PDF</p>
                <p><kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">+ -</kbd> Zoom</p>
              </motion.div>
            )}
          </AnimatePresence>

          {showInfo && (
            <div className="absolute top-12 right-4 w-80 max-h-[70vh] overflow-y-auto bg-card border border-border/50 rounded-xl shadow-xl p-4 z-10 space-y-4">
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">File Info</h4>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span className="font-mono truncate ml-2 max-w-[160px]">{file.name}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Type</span><span className="font-mono text-xs">{file.mimeType}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Preview</span><span className="text-xs">{kindLabel}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span>{formatBytes(file.sizeBytes)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{formatDate(file.createdAt)}</span></div>
                  {isEncrypted && (
                    <div className="flex justify-between"><span className="text-muted-foreground">Encryption</span><span className="text-amber-500">AES-GCM</span></div>
                  )}
                </div>
              </div>
              {!file.isNote && <FileVersionsPanel fileId={file.id} />}
            </div>
          )}

          {showShare && (
            <ShareDialog fileId={file.id} fileName={file.name} fileType={file.mimeType} isNote={file.isNote} onClose={() => setShowShare(false)} />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
