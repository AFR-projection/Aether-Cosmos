"use client";

import { useRef, useState } from "react";
import { Paperclip, Upload } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/feedback/spinner";
import { useFormat, useT } from "@/shared/lib/i18n";
import { SUBTITLE_UPLOAD_MAX_BYTES } from "@files/domain/services/subtitles/limits";
import { SUBTITLE_LANGUAGES } from "@files/domain/services/subtitles/languages";

/**
 * Attach a `.srt`/`.vtt` the user already has.
 *
 * The one part of this feature that works with no provider configured and costs nothing, which is
 * why it is offered next to generating rather than buried: somebody who downloaded subtitles for a
 * film elsewhere should be able to watch with them here. It is also the way back in for a track
 * that was downloaded before an account restore, since the archive format cannot carry one.
 *
 * The language is a required choice rather than a guess from the filename. `Movie.id.srt` is a
 * convention, not a rule, and a track labelled with the wrong language is worse than one the user
 * had to name: the player would offer it under a language it is not, and `<track srclang>` would
 * lie to a screen reader.
 */

export type SubtitleUploadDialogProps = {
  open: boolean;
  onClose: () => void;
  onAttach: (
    file: File,
    language: string
  ) => Promise<{ ok: true; cueCount: number } | { ok: false; error?: string; code?: string }>;
};

export function SubtitleUploadDialog({ open, onClose, onAttach }: SubtitleUploadDialogProps) {
  const t = useT();
  const { formatBytes } = useFormat();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("id");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooLarge = file !== null && file.size > SUBTITLE_UPLOAD_MAX_BYTES;

  async function submit() {
    if (!file || tooLarge) return;
    setBusy(true);
    setError(null);
    const result = await onAttach(file, language);
    setBusy(false);
    if (result.ok) {
      setFile(null);
      onClose();
      return;
    }
    // Every refusal the route can make has its own sentence, so the code decides the wording and
    // the server's prose is the fallback rather than the answer.
    setError(
      result.code === "SUBTITLE_UPLOAD_EMPTY"
        ? t("files.subtitles.upload.empty")
        : result.code === "SUBTITLE_UPLOAD_WRONG_TYPE"
          ? t("files.subtitles.upload.wrongType")
          : result.code === "SUBTITLE_UPLOAD_TOO_LARGE"
            ? t("files.subtitles.upload.tooLarge", { max: formatBytes(SUBTITLE_UPLOAD_MAX_BYTES) })
            : (result.error ?? t("common.somethingWentWrong"))
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("files.subtitles.upload.title")}
      icon={Paperclip}
      size="sm"
      dismissible={!busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !file || tooLarge}>
            {busy ? <Spinner size="sm" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
            {t("files.subtitles.upload.attach")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <input
            ref={inputRef}
            type="file"
            accept=".srt,.vtt,text/vtt,application/x-subrip"
            className="sr-only"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
          />
          <Button variant="secondary" className="w-full" onClick={() => inputRef.current?.click()}>
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            {file ? t("files.subtitles.upload.chosen", { name: file.name, size: formatBytes(file.size) }) : t("files.subtitles.upload.pick")}
          </Button>
          {tooLarge && (
            <p role="alert" className="mt-1.5 text-xs text-danger-ink">
              {t("files.subtitles.upload.tooLarge", { max: formatBytes(SUBTITLE_UPLOAD_MAX_BYTES) })}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="subtitle-upload-language" className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("files.subtitles.upload.language")}
          </label>
          <select
            id="subtitle-upload-language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            // 16px on mobile: a smaller control makes iOS zoom the page on focus.
            className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40 sm:text-sm"
          >
            {SUBTITLE_LANGUAGES.map((option) => (
              <option key={option.tag} value={option.tag}>
                {option.native} — {option.english}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger-ink">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
