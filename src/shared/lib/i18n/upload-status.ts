/**
 * Wording for the upload queue, shared by the three surfaces that draw it: the
 * floating panel, the activity page, and the activity centre.
 *
 * `src/features/files/application/commands/upload-queue.ts` keeps its English `formatETA` for non-UI callers (it is
 * imported by the worker and by tests, where a translation key would be
 * meaningless). Everything a person reads on screen comes from here.
 */

import type { TranslationKey, Translator } from "./dictionary";
import type { UploadItemStatus } from "@files/application/commands/upload-queue";

/** Keyed by the queue's own status value, which never changes with the language. */
const STATUS_KEYS: Record<UploadItemStatus, TranslationKey> = {
  queued: "files.upload.status.queued",
  preparing: "files.upload.status.preparing",
  uploading: "files.upload.status.uploading",
  verifying: "files.upload.status.verifying",
  done: "files.upload.status.done",
  error: "files.upload.status.error",
  cancelled: "files.upload.status.cancelled",
  resume_requires_file: "files.upload.status.resumeRequiresFile",
};

export function uploadStatusKey(status: UploadItemStatus): TranslationKey {
  return STATUS_KEYS[status];
}

/**
 * Time remaining, as one sentence.
 *
 * The same thresholds as `formatETA`, but "left" is inside the sentence rather
 * than appended by the caller — where each language puts it is not English's
 * decision to make.
 */
export function uploadEtaLabel(seconds: number, t: Translator): string {
  if (seconds < 1) return t("files.upload.etaAlmostDone");
  if (seconds < 60) return t("files.upload.etaSeconds", { count: Math.round(seconds) });
  if (seconds < 3600) {
    return t("files.upload.etaMinutes", {
      minutes: Math.floor(seconds / 60),
      seconds: Math.floor(seconds % 60),
    });
  }
  return t("files.upload.etaHours", {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
  });
}
