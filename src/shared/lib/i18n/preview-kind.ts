/**
 * Wording for the preview kinds detected by `src/features/files/domain/services/detect-preview-type.ts`.
 *
 * The detector itself stays free of translation: it is imported by tests and by
 * server code that only needs the kind, never its name.
 */

import type { TranslationKey } from "./dictionary";
import type { PreviewKind } from "@files/domain/services/detect-preview-type";

const KIND_KEYS: Record<PreviewKind, TranslationKey> = {
  image: "files.preview.kind.image",
  video: "files.preview.kind.video",
  audio: "files.preview.kind.audio",
  pdf: "files.preview.kind.pdf",
  text: "files.preview.kind.code",
  csv: "files.preview.kind.csv",
  spreadsheet: "files.preview.kind.spreadsheet",
  document: "files.preview.kind.document",
  presentation: "files.preview.kind.presentation",
  svg: "files.preview.kind.svg",
  archive: "files.preview.kind.archive",
  unsupported: "files.preview.kind.file",
};

export function previewKindKey(kind: PreviewKind): TranslationKey {
  return KIND_KEYS[kind] ?? "files.preview.kind.file";
}
