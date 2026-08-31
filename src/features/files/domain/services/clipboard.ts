"use client";

import { useSyncExternalStore } from "react";

/**
 * A tiny file "clipboard" for the browser session — mirrors Windows Explorer
 * copy/cut → paste. Copy duplicates into the target folder; cut moves. Holds
 * only ids + display info; the actual copy/move happens via the files API on paste.
 */

export type ClipboardMode = "copy" | "cut";

export type FileClipboard = {
  mode: ClipboardMode;
  ids: string[];
  /** For the toolbar hint ("2 files ready to paste"). */
  count: number;
  label: string;
} | null;

let clipboard: FileClipboard = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setClipboard(mode: ClipboardMode, ids: string[], label: string): void {
  if (ids.length === 0) {
    clipboard = null;
  } else {
    clipboard = { mode, ids, count: ids.length, label };
  }
  emit();
}

export function clearClipboard(): void {
  clipboard = null;
  emit();
}

export function getClipboard(): FileClipboard {
  return clipboard;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook to read the current clipboard reactively. */
export function useFileClipboard(): FileClipboard {
  return useSyncExternalStore(subscribe, getClipboard, () => null);
}
