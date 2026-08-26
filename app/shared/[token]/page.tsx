"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Cloud, Loader2, AlertCircle, Eye, Clock } from "lucide-react";
import { cn, formatBytes, getMimeCategory, getFileExtension } from "@/lib/utils";
import dynamic from "next/dynamic";

const PdfViewer = dynamic(() => import("@/components/media-viewers/pdf-viewer").then((m) => m.PdfViewer), { ssr: false });
const ImageViewer = dynamic(() => import("@/components/media-viewers/image-viewer").then((m) => m.ImageViewer), { ssr: false });
const VideoViewer = dynamic(() => import("@/components/media-viewers/video-viewer").then((m) => m.VideoViewer), { ssr: false });
const AudioViewer = dynamic(() => import("@/components/media-viewers/audio-viewer").then((m) => m.AudioViewer), { ssr: false });
const TextViewer = dynamic(() => import("@/components/media-viewers/text-viewer").then((m) => m.TextViewer), { ssr: false });
const SvgViewer = dynamic(() => import("@/components/media-viewers/svg-viewer").then((m) => m.SvgViewer), { ssr: false });
const SharedNoteView = dynamic(() => import("@/components/editors/shared-note-view").then((m) => m.SharedNoteView), { ssr: false });

/**
 * The limits attached to the link, as the recipient sees them: how many views are left and
 * when it stops working. Written once and used by all three layouts below — the same two
 * facts were hand-repeated in each, which is how "12 / 20" ended up meaning nothing on its
 * own and how a quota of 0 used to render a stray "0" instead of the row.
 */
function ShareMeta({
  accessCount,
  maxAccessCount,
  expiresAt,
  center,
}: {
  accessCount?: number;
  maxAccessCount?: number;
  expiresAt?: string;
  center?: boolean;
}) {
  const hasQuota = typeof maxAccessCount === "number" && maxAccessCount > 0;
  if (!hasQuota && !expiresAt) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
        center && "justify-center"
      )}
    >
      {hasQuota && (
        <span className="flex items-center gap-1" title="Views used">
          <Eye aria-hidden className="h-3 w-3 shrink-0" />
          <span className="tabular-nums">
            {accessCount ?? 0} / {maxAccessCount}
          </span>
          {/* The numbers alone read as "12 slash 20" and mean nothing without this. */}
          <span className="sr-only">views used</span>
        </span>
      )}
      {expiresAt && (
        <span className="flex items-center gap-1" title="When this link stops working">
          <Clock aria-hidden className="h-3 w-3 shrink-0" />
          <span>Expires {new Date(expiresAt).toLocaleString()}</span>
        </span>
      )}
    </div>
  );
}

export default function PublicSharedPage() {
  const params = useParams();
  const token = params.token as string;
  const [data, setData] = useState<{
    file: { id: string; name: string; mimeType: string; sizeBytes: number; isNote?: boolean };
    note?: { content: unknown } | null;
    permission?: string;
    accessCount?: number;
    maxAccessCount?: number;
    lastAccessedAt?: string;
    expiresAt?: string;
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/shared/${token}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
        else setError(json.error ?? "Not found");
      })
      .catch(() => setError("Failed to load shared file"));
  }, [token]);

  if (!data) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <div className="text-center">
          {error ? (
            <>
              <AlertCircle aria-hidden className="mx-auto mb-4 h-12 w-12 text-muted-foreground/30" />
              {/* A share that refuses to open is the whole page, so the reason has to be
                  announced rather than just drawn. */}
              <p role="alert" className="text-muted-foreground">
                {error}
              </p>
            </>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin text-accent" />
              Loading shared file…
            </p>
          )}
        </div>
      </main>
    );
  }

  const category = getMimeCategory(data.file.mimeType);
  const ext = getFileExtension(data.file.name);
  const isSvg = data.file.mimeType === "image/svg+xml" || ext === "svg";
  const isText = data.file.mimeType.startsWith("text/") || data.file.mimeType === "application/json" || data.file.mimeType === "application/xml";

  const isNote = !!data.file.isNote;
  const canEdit = data.permission === "edit";

  const canPreview = category === "pdf" || category === "image" || category === "video" || category === "audio" || isSvg || isText;

  // Public streaming endpoint — view only, never a download URL.
  const previewUrl = `/api/shared/${token}/preview`;

  const noteTitle = data.file.name.replace(/\.note$/, "");

  // Notes have no R2 object — render their Tiptap body directly instead of
  // streaming a file that doesn't exist.
  if (isNote) {
    return (
      <main className="min-h-dvh bg-background">
        <div className="flex min-h-dvh flex-col">
          {/* Header */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Cloud aria-hidden className="h-5 w-5 shrink-0 text-accent" />
              <h1 className="truncate text-sm font-semibold">{noteTitle}</h1>
            </div>
            <ShareMeta
              accessCount={data.accessCount}
              maxAccessCount={data.maxAccessCount}
              expiresAt={data.expiresAt}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            <SharedNoteView token={token} content={data.note?.content ?? null} canEdit={canEdit} />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background">
      {canPreview ? (
        // dvh, not vh: the phone's own chrome counts towards vh, so the viewer's bottom
        // edge — and its controls — sat under the address bar.
        <div className="flex h-dvh flex-col">
          {/* Header */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Cloud aria-hidden className="h-5 w-5 shrink-0 text-accent" />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">{data.file.name}</h1>
                <p className="text-xs text-muted-foreground">{formatBytes(data.file.sizeBytes)}</p>
              </div>
            </div>
            <ShareMeta
              accessCount={data.accessCount}
              maxAccessCount={data.maxAccessCount}
              expiresAt={data.expiresAt}
            />
          </div>

          {/* Preview — view only, no download button */}
          <div className="flex-1 min-h-0">
            {category === "pdf" && <PdfViewer fileId={data.file.id} previewUrl={previewUrl} />}
            {category === "image" && !isSvg && <ImageViewer src={previewUrl} fileName={data.file.name} mimeType={data.file.mimeType} />}
            {isSvg && <SvgViewer src={previewUrl} fileName={data.file.name} />}
            {category === "video" && <VideoViewer src={previewUrl} fileName={data.file.name} />}
            {category === "audio" && <AudioViewer src={previewUrl} fileName={data.file.name} />}
            {isText && <TextViewer src={previewUrl} fileName={data.file.name} mimeType={data.file.mimeType} />}
          </div>
        </div>
      ) : (
        <div className="flex min-h-dvh items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-medium">
            <Cloud aria-hidden className="mx-auto mb-4 h-12 w-12 text-accent" />
            <h1 className="truncate text-xl font-bold">{data.file.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{formatBytes(data.file.sizeBytes)}</p>
            <div className="mt-4">
              <ShareMeta
                center
                accessCount={data.accessCount}
                maxAccessCount={data.maxAccessCount}
                expiresAt={data.expiresAt}
              />
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              This file type can&apos;t be previewed here.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
