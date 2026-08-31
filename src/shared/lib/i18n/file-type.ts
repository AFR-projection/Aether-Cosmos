/**
 * Wording for the file-type badge, keyed by the categories `getMimeCategory`
 * returns.
 *
 * `src/shared/lib/file-type-utils.tsx` keeps the icon, the accent colour and the gradient —
 * none of which change with language — but the label lives here, so the badge is
 * translated at the call site rather than baked into a shared helper.
 *
 * The category is a plain `string` rather than a union, so the table is open and
 * an unrecognised MIME type falls back to the generic word.
 */

import type { TranslationKey } from "./dictionary";
import { getMimeCategory } from "@/shared/lib/utils";

const CATEGORY_KEYS: Record<string, TranslationKey> = {
  image: "files.type.image",
  video: "files.type.video",
  audio: "files.type.audio",
  pdf: "files.type.pdf",
  document: "files.type.document",
  spreadsheet: "files.type.spreadsheet",
  presentation: "files.type.presentation",
  archive: "files.type.archive",
  text: "files.type.text",
};

export function fileTypeKey(mimeType: string): TranslationKey {
  return CATEGORY_KEYS[getMimeCategory(mimeType)] ?? "files.type.file";
}
