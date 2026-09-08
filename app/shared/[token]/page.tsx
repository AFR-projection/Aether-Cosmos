"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Cloud,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
  Clock,
  Lock,
  ShieldAlert,
  Unlock,
} from "lucide-react";
import { cn, getMimeCategory, getFileExtension } from "@/shared/lib/utils";
import {
  apiErrorMessage,
  createTranslator,
  getLocale,
  useFormat,
  useT,
} from "@/shared/lib/i18n";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Spinner } from "@/ui/feedback/spinner";
import {
  decryptToBlob,
  type EncryptionMetaV1,
} from "@/shared/lib/crypto/client-encryption";
import type { VideoPlaybackHandle } from "@files/presentation/components/media-viewers/video-viewer";
import { usePlaybackSource } from "@files/presentation/hooks/use-playback-source";
import {
  sharedEncryptionMeta,
  sharedPlaybackTarget,
} from "@shares/domain/shared-encrypted-playback";
import dynamic from "next/dynamic";

const PdfViewer = dynamic(
  () =>
    import("@files/presentation/components/media-viewers/pdf-viewer").then(
      (m) => m.PdfViewer,
    ),
  { ssr: false },
);
const ImageViewer = dynamic(
  () =>
    import("@files/presentation/components/media-viewers/image-viewer").then(
      (m) => m.ImageViewer,
    ),
  { ssr: false },
);
const VideoViewer = dynamic(
  () =>
    import("@files/presentation/components/media-viewers/video-viewer").then(
      (m) => m.VideoViewer,
    ),
  { ssr: false },
);
const AudioViewer = dynamic(
  () =>
    import("@files/presentation/components/media-viewers/audio-viewer").then(
      (m) => m.AudioViewer,
    ),
  { ssr: false },
);
const TextViewer = dynamic(
  () =>
    import("@files/presentation/components/media-viewers/text-viewer").then(
      (m) => m.TextViewer,
    ),
  { ssr: false },
);
const SvgViewer = dynamic(
  () =>
    import("@files/presentation/components/media-viewers/svg-viewer").then(
      (m) => m.SvgViewer,
    ),
  { ssr: false },
);
const SharedNoteView = dynamic(
  () =>
    import("@files/presentation/components/editors/shared-note-view").then(
      (m) => m.SharedNoteView,
    ),
  { ssr: false },
);

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
  const t = useT();
  const { formatDate, formatNumber } = useFormat();
  const hasQuota = typeof maxAccessCount === "number" && maxAccessCount > 0;
  if (!hasQuota && !expiresAt) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
        center && "justify-center",
      )}
    >
      {hasQuota && (
        <span
          className="flex items-center gap-1"
          title={t("shares.public.viewsUsed")}
        >
          <Eye aria-hidden className="h-3 w-3 shrink-0" />
          <span className="tabular-nums">
            {formatNumber(accessCount ?? 0)} / {formatNumber(maxAccessCount)}
          </span>
          {/* The numbers alone read as "12 slash 20" and mean nothing without this. */}
          <span className="sr-only">{t("shares.public.viewsUsed")}</span>
        </span>
      )}
      {expiresAt && (
        <span
          className="flex items-center gap-1"
          title={t("shares.public.expiryTitle")}
        >
          <Clock aria-hidden className="h-3 w-3 shrink-0" />
          <span>{t("shares.expiresOn", { date: formatDate(expiresAt) })}</span>
        </span>
      )}
    </div>
  );
}

export default function PublicSharedPage() {
  const params = useParams();
  const t = useT();
  const { formatBytes } = useFormat();
  const token = params.token as string;
  const [data, setData] = useState<{
    file: {
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      isNote?: boolean;
      encrypted?: boolean;
      encryptionMeta?: unknown;
    };
    note?: { content: unknown } | null;
    permission?: string;
    accessCount?: number;
    maxAccessCount?: number;
    lastAccessedAt?: string;
    expiresAt?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/shared/${token}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setData(json.data);
        // Built here rather than captured from render: the effect runs once per
        // token, so a `t` from the first render would freeze this sentence in
        // whatever language was active then.
        else
          setError(
            apiErrorMessage(
              json,
              createTranslator(getLocale()),
              "shares.public.loadFailed",
            ),
          );
      })
      .catch(() =>
        setError(createTranslator(getLocale())("shares.public.loadFailed")),
      );
  }, [token]);

  /**
   * Plaintext video gets a short-lived direct-R2 capability. Encrypted video must
   * stay on the proxy until this browser decrypts it into a local Blob URL.
   */
  const playbackTarget = useMemo(
    () => sharedPlaybackTarget(data?.file ?? null, token),
    [data, token],
  );
  const playback = usePlaybackSource({
    target: playbackTarget,
    fallbackUrl: data?.file.encrypted
      ? decryptedUrl
      : `/api/shared/${token}/preview`,
    bypass: !!data?.file.encrypted,
  });

  useEffect(() => {
    return () => {
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
    };
  }, [decryptedUrl]);

  async function handleUnlock(event: React.FormEvent) {
    event.preventDefault();
    if (!data || !passphrase.trim()) return;

    const meta = sharedEncryptionMeta(data.file);
    if (!meta) {
      setUnlockError(t("files.preview.noMeta"));
      return;
    }

    setUnlocking(true);
    setUnlockError(null);
    try {
      const response = await fetch(`/api/shared/${token}/preview`);
      if (!response.ok) {
        setUnlockError(t("files.preview.fetchFailed"));
        return;
      }
      const blob = await decryptToBlob(
        await response.arrayBuffer(),
        passphrase,
        meta as EncryptionMetaV1,
        data.file.mimeType,
      );
      if (decryptedUrl) URL.revokeObjectURL(decryptedUrl);
      setDecryptedUrl(URL.createObjectURL(blob));
    } catch {
      setUnlockError(t("files.preview.unlockFailed"));
    } finally {
      setUnlocking(false);
    }
  }

  if (!data) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <div className="text-center">
          {error ? (
            <>
              <AlertCircle
                aria-hidden
                className="mx-auto mb-4 h-12 w-12 text-muted-foreground/30"
              />
              {/* A share that refuses to open is the whole page, so the reason has to be
                  announced rather than just drawn. */}
              <p role="alert" className="text-muted-foreground">
                {error}
              </p>
            </>
          ) : (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2
                aria-hidden
                className="h-4 w-4 animate-spin text-accent-ink"
              />
              {t("shares.public.loading")}
            </p>
          )}
        </div>
      </main>
    );
  }

  const category = getMimeCategory(data.file.mimeType);
  const ext = getFileExtension(data.file.name);
  const isSvg = data.file.mimeType === "image/svg+xml" || ext === "svg";
  const isText =
    data.file.mimeType.startsWith("text/") ||
    data.file.mimeType === "application/json" ||
    data.file.mimeType === "application/xml";

  const isNote = !!data.file.isNote;
  const canEdit = data.permission === "edit";

  const canPreview =
    category === "pdf" ||
    category === "image" ||
    category === "video" ||
    category === "audio" ||
    isSvg ||
    isText;

  // Public streaming endpoint — view only, never a download URL.
  const previewUrl = `/api/shared/${token}/preview`;

  const sharePlayback: VideoPlaybackHandle = data.file.encrypted
    ? {
        source: "encrypted_blob",
        fileId: null,
        telemetry: false,
        errorCode: null,
        urlLatencyMs: null,
        refreshCount: 0,
        refresh: () => {},
      }
    : {
        source: playback.delivery,
        fileId: null,
        telemetry: false,
        errorCode: playback.errorCode,
        urlLatencyMs: playback.urlLatencyMs,
        refreshCount: playback.refreshCount,
        refresh: playback.refresh,
      };

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
              <Cloud aria-hidden className="h-5 w-5 shrink-0 text-accent-ink" />
              <h1 className="truncate text-sm font-semibold">{noteTitle}</h1>
            </div>
            <ShareMeta
              accessCount={data.accessCount}
              maxAccessCount={data.maxAccessCount}
              expiresAt={data.expiresAt}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            <SharedNoteView
              token={token}
              content={data.note?.content ?? null}
              canEdit={canEdit}
            />
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
              <Cloud aria-hidden className="h-5 w-5 shrink-0 text-accent-ink" />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">
                  {data.file.name}
                </h1>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(data.file.sizeBytes)}
                </p>
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
            {category === "pdf" && (
              <PdfViewer fileId={data.file.id} previewUrl={previewUrl} />
            )}
            {category === "image" && !isSvg && (
              <ImageViewer
                src={previewUrl}
                fileName={data.file.name}
                mimeType={data.file.mimeType}
              />
            )}
            {isSvg && <SvgViewer src={previewUrl} fileName={data.file.name} />}
            {category === "video" && data.file.encrypted && !decryptedUrl && (
              <div className="flex h-full flex-col items-center justify-center bg-surface px-4 text-center">
                <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-warning/10 ring-1 ring-warning/20">
                  <Lock
                    className="h-7 w-7 text-warning-ink"
                    aria-hidden="true"
                  />
                </span>
                <p className="text-sm font-semibold text-foreground">
                  {t("files.preview.encryptedTitle")}
                </p>
                <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {t("files.preview.encryptedBody")}
                </p>
                <form
                  onSubmit={handleUnlock}
                  className="mt-4 w-full max-w-xs space-y-2"
                >
                  <div className="relative">
                    <Input
                      type={showPassphrase ? "text" : "password"}
                      placeholder={t("files.preview.passphrase")}
                      aria-label={t("files.preview.passphrase")}
                      autoComplete="off"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      autoFocus
                      className="pr-11"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        showPassphrase
                          ? t("files.preview.hidePassphrase")
                          : t("files.preview.showPassphrase")
                      }
                      aria-pressed={showPassphrase}
                      onClick={() => setShowPassphrase((visible) => !visible)}
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
                    <p
                      role="alert"
                      className="flex items-center justify-center gap-1.5 text-xs text-danger-ink"
                    >
                      <ShieldAlert
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {unlockError}
                    </p>
                  )}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={unlocking || !passphrase}
                  >
                    {unlocking ? (
                      <Spinner size="sm" />
                    ) : (
                      <Unlock className="h-4 w-4" aria-hidden="true" />
                    )}
                    {unlocking
                      ? t("files.preview.decrypting")
                      : t("files.preview.unlock")}
                  </Button>
                </form>
              </div>
            )}
            {category === "video" && (!data.file.encrypted || decryptedUrl) && (
              <VideoViewer
                src={playback.url}
                fileName={data.file.name}
                /* The token IS the capability, exactly as it is for a shared note — and it grants
                   reading the tracks, nothing more. A `share` source has no fileId to generate,
                   edit or delete against, so the menu physically cannot offer any of those. */
                subtitleSource={{ kind: "share", token }}
                /* No fileId and no telemetry: an anonymous reader has no session to attribute a
                   report to, and `/api/playback/telemetry` would refuse it. The rest of the handle
                   still matters — this is where a used-up link becomes a sentence about a used-up
                   link instead of a black rectangle. */
                playback={sharePlayback}
              />
            )}
            {category === "audio" && (
              <AudioViewer src={previewUrl} fileName={data.file.name} />
            )}
            {isText && (
              <TextViewer
                src={previewUrl}
                fileName={data.file.name}
                mimeType={data.file.mimeType}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-dvh items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-medium">
            <Cloud
              aria-hidden
              className="mx-auto mb-4 h-12 w-12 text-accent-ink"
            />
            <h1 className="truncate text-xl font-bold">{data.file.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatBytes(data.file.sizeBytes)}
            </p>
            <div className="mt-4">
              <ShareMeta
                center
                accessCount={data.accessCount}
                maxAccessCount={data.maxAccessCount}
                expiresAt={data.expiresAt}
              />
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              {t("shares.public.noPreview")}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
