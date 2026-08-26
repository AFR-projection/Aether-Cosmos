/**
 * Bounds and eligibility for editing a stored file's text in the browser.
 *
 * Uploaded text and code files were read-only: to change one line of a project you
 * had to download it, edit it locally and upload it again. Saving text back to R2 is
 * a write over the caller's own bytes, so it needs the same three answers every other
 * edit path gives — what may be edited, how much of it, and whether the editor was
 * looking at the whole file when the user pressed Save.
 *
 * The third question is the one that loses data if it is skipped. The previewer
 * truncates, and saving an edited truncation would erase everything past the cut, so
 * the truncation ceiling and the edit ceiling are the SAME constant, consumed by both
 * the viewer and the save route: anything editable was loaded whole, and anything too
 * large to load whole is not editable.
 */

import { detectPreviewKind } from "@/lib/preview/detect-preview-type";

/**
 * Largest text file we will load whole, and therefore the largest we will save.
 *
 * 512 KB is far above any hand-written source file and keeps the editor's cost
 * bounded — a `<textarea>` holding the whole document is re-measured on every
 * keystroke, so this number is a latency budget, not a storage one. Files past it
 * still preview (truncated) and still download.
 */
export const TEXT_EDIT_MAX_BYTES = 512 * 1024;

/**
 * Which files the text editor may write.
 *
 * `text` and `csv` are the kinds the previewer already renders as characters. SVG is
 * markup and would qualify on those grounds, but it stays out for the same reason
 * `EDIT_REFUSED_MIME_TYPES` keeps it away from the image pipeline — it is a document
 * format that executes, and this route is not where that argument gets reopened.
 */
export function isTextEditable(mimeType: string, fileName: string): boolean {
  const kind = detectPreviewKind(mimeType, fileName);
  return kind === "text" || kind === "csv";
}

/** UTF-8 length, which is what the object store and the quota count. */
export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Is this edited body small enough to store? */
export function withinTextEditBounds(text: string): boolean {
  return textByteLength(text) <= TEXT_EDIT_MAX_BYTES;
}

export type ClampedText = {
  /** What the viewer should render. */
  text: string;
  /** Characters were dropped, so what is on screen is not the whole file. */
  truncated: boolean;
  /** The whole file is present AND small enough to save back. */
  editable: boolean;
};

/**
 * Decide, in one place, what the viewer shows and whether Save may be offered.
 *
 * `truncated` and `editable` are separate answers because they can disagree: a file
 * of many multi-byte characters can be over the byte ceiling while still being short
 * enough that nothing is cut from the display. Saving is refused in both cases; only
 * `truncated` warns that text is missing.
 */
export function clampTextForPreview(text: string): ClampedText {
  if (withinTextEditBounds(text)) return { text, truncated: false, editable: true };

  // The slice is by characters — a character is the unit that costs render time, and
  // an over-ceiling file is non-editable regardless of how its bytes divide up.
  const clipped = text.slice(0, TEXT_EDIT_MAX_BYTES);
  return { text: clipped, truncated: clipped.length < text.length, editable: false };
}
