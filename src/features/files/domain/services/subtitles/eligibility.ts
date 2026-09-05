/**
 * Which files can have subtitles, and why one cannot.
 *
 * Every clause mirrors a refusal `POST /api/files/[id]/subtitles` will make, so a CC button
 * never appears on a file whose only possible outcome is an error. That is the same contract
 * `mediaEditorKindFor` in `../media-edit.ts` holds for the edit panels, and it is kept the same
 * way: one function, read by the component and by the route.
 *
 * Video only. An audio file could be transcribed by exactly this pipeline, and deliberately is
 * not offered yet — the overlay is drawn over a picture, and a transcript with nowhere to sit is
 * a feature that half exists. Adding it later is one clause here plus a place to render it.
 */

import { EXTRACT_AUDIO_SOURCE_MAX_BYTES } from "../edit-limits";
/**
 * Type-only, and pointed at the module rather than at `@/shared/lib/i18n` — the barrel is
 * `"use client"`, and this file is also imported by route handlers. A `import type` is erased,
 * so nothing client-only follows it into a server bundle. Same reasoning as `../media-edit.ts`.
 */
import type { TranslationKey } from "@/shared/lib/i18n/dictionary";

/** Why a file cannot have subtitles. Named, not worded — see the note above. */
export type SubtitleRefusal = "mime" | "encrypted" | "note" | "tooLarge";

/** What to say about each refusal. A literal map, so a typo here is a tsc error. */
export const SUBTITLE_REFUSAL_KEYS: Record<SubtitleRefusal, TranslationKey> = {
  mime: "files.subtitles.refusal.mime",
  encrypted: "files.subtitles.refusal.encrypted",
  note: "files.subtitles.refusal.note",
  tooLarge: "files.subtitles.refusal.tooLarge",
};

export type SubtitleSubject = {
  mimeType: string;
  encrypted: boolean;
  isNote: boolean;
  /** Accepts the string a `bigint` column arrives as. */
  sizeBytes: number | string;
};

/**
 * Why this file cannot have subtitles, or `null`.
 *
 * Ordered so the reason a user can do nothing about comes first: being told a file is too large
 * invites them to try a smaller one, which is useless advice if the real problem is that it is
 * encrypted and no size would help.
 */
export function subtitleRefusalFor(subject: SubtitleSubject): SubtitleRefusal | null {
  if (subject.isNote) return "note";
  // Client-side encryption means the server has ciphertext and no key, so ffmpeg would be
  // handed noise. The same refusal the trim and extract-audio routes already make.
  if (subject.encrypted) return "encrypted";
  if (!subject.mimeType.toLowerCase().split(";")[0].trim().startsWith("video/")) return "mime";

  const bytes = Number(subject.sizeBytes);
  // An unparseable size is treated as too big. Guessing small would trade a hidden control for
  // a 413 the user only discovers after waiting for the upload of a request.
  if (!Number.isFinite(bytes) || bytes > EXTRACT_AUDIO_SOURCE_MAX_BYTES) return "tooLarge";

  return null;
}

/** Whether this file can carry subtitle tracks at all — enough to show the CC control. */
export function supportsSubtitles(subject: SubtitleSubject): boolean {
  return subtitleRefusalFor(subject) === null;
}

/**
 * Whether this caller may have new subtitles made for this file.
 *
 * Write permission, because generating a track inserts rows against the file and spends the
 * instance's transcription budget — the same bar `POST /api/files/extract-audio` sets for
 * creating a file next to a video somebody shared with you.
 */
export function canGenerateSubtitles(subject: SubtitleSubject & { canEdit: boolean }): boolean {
  return subject.canEdit && supportsSubtitles(subject);
}
