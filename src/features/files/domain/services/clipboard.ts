"use client";

import { useSyncExternalStore } from "react";

/**
 * The `/files` clipboard — copy / cut → paste, the way Windows Explorer does it.
 *
 * Holds references only: ids, names and what kind of thing each one is. Nothing is
 * copied or moved until a paste, and the server re-resolves every id then, so a
 * clipboard that has gone stale (source trashed, share revoked, another account
 * signed in on this browser) can only ever produce a refusal — never a wrong write.
 *
 * Three things this owns that the previous version did not:
 *
 * 1. **Folders.** An entry carries its `kind`, because pasting a folder means copying
 *    a whole subtree and the paste has to know that before it starts.
 * 2. **Where it came from.** `sourceFolderId` is what makes "cut, then paste into the
 *    same folder" a no-op instead of a move that reports success and changes nothing.
 * 3. **Survival.** Backed by `localStorage`, so a reload keeps it and a second tab sees
 *    it — Explorer's clipboard is not scoped to one window either. Entries expire after
 *    `CLIPBOARD_TTL_MS` so a clipboard forgotten overnight does not resurface as a
 *    surprise paste against ids that may no longer exist.
 */

export type ClipboardMode = "copy" | "cut";

export type ClipboardEntryKind = "file" | "folder";

export type ClipboardEntry = {
  kind: ClipboardEntryKind;
  id: string;
  name: string;
};

export type FileClipboard = {
  mode: ClipboardMode;
  entries: ClipboardEntry[];
  /** Folder the entries were taken from; `null` at the account root. */
  sourceFolderId: string | null;
  /** For the toolbar hint ("2 items ready to paste"). */
  count: number;
  label: string;
  /** Epoch ms of the write, used only to expire a forgotten clipboard. */
  savedAt: number;
} | null;

const STORAGE_KEY = "afr.files.clipboard.v1";

/**
 * How long a clipboard stays valid.
 *
 * `localStorage` outlives the browser session, which is more persistence than a
 * clipboard should have: a paste from three days ago is far more likely to be a
 * mis-click than an intention.
 */
export const CLIPBOARD_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Matches the `ids` cap on `/api/files/batch`, so a clipboard can never hold more
 * than one request is allowed to carry.
 */
export const MAX_CLIPBOARD_ENTRIES = 500;

let clipboard: FileClipboard = null;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/* ─────────────────────────────  Persistence  ───────────────────────────── */

/**
 * Rebuild a clipboard from whatever is in storage.
 *
 * Every field is checked rather than cast: this string was written by another tab,
 * possibly by an older build of the app, and a malformed entry that reached a paste
 * would send junk ids to the server. Anything unrecognised resolves to `null`, which
 * reads as "no clipboard" — the safe default.
 */
export function parseStoredClipboard(raw: string | null, now: number): FileClipboard {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { mode, entries, sourceFolderId, label, savedAt } = parsed as Record<string, unknown>;

  if (mode !== "copy" && mode !== "cut") return null;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (entries.length > MAX_CLIPBOARD_ENTRIES) return null;
  if (typeof label !== "string") return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (sourceFolderId !== null && typeof sourceFolderId !== "string") return null;
  if (now - savedAt > CLIPBOARD_TTL_MS) return null;

  const clean: ClipboardEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const { kind, id, name } = entry as Record<string, unknown>;
    if (kind !== "file" && kind !== "folder") return null;
    if (typeof id !== "string" || id === "") return null;
    if (typeof name !== "string") return null;
    clean.push({ kind, id, name });
  }

  return {
    mode,
    entries: clean,
    sourceFolderId: sourceFolderId ?? null,
    count: clean.length,
    label,
    savedAt,
  };
}

function persist(value: FileClipboard): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private mode, quota, or a blocked origin. The in-memory clipboard still works
    // for this tab; only cross-tab and reload survival are lost.
  }
}

function readStorage(): FileClipboard {
  if (typeof window === "undefined") return null;
  try {
    return parseStoredClipboard(window.localStorage.getItem(STORAGE_KEY), Date.now());
  } catch {
    return null;
  }
}

/**
 * Load the persisted clipboard into memory, once.
 *
 * `getSnapshot` has to return a referentially stable value or `useSyncExternalStore`
 * re-renders forever, so storage is read here — into the module variable — and never
 * from inside the snapshot.
 */
function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  clipboard = readStorage();

  // Another tab wrote the clipboard. `storage` fires only in the tabs that did NOT
  // perform the write, which is exactly the set that needs telling.
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const next = readStorage();
    if (sameClipboard(clipboard, next)) return;
    clipboard = next;
    emit();
  });
}

function sameClipboard(a: FileClipboard, b: FileClipboard): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.mode === b.mode &&
    a.savedAt === b.savedAt &&
    a.sourceFolderId === b.sourceFolderId &&
    a.count === b.count
  );
}

/* ─────────────────────────────  Writes  ───────────────────────────── */

export function setClipboard(
  mode: ClipboardMode,
  entries: ClipboardEntry[],
  sourceFolderId: string | null,
  label: string
): void {
  hydrate();
  if (entries.length === 0) {
    clipboard = null;
  } else {
    clipboard = {
      mode,
      entries: entries.slice(0, MAX_CLIPBOARD_ENTRIES),
      sourceFolderId,
      count: Math.min(entries.length, MAX_CLIPBOARD_ENTRIES),
      label,
      savedAt: Date.now(),
    };
  }
  persist(clipboard);
  emit();
}

export function clearClipboard(): void {
  hydrate();
  clipboard = null;
  persist(null);
  emit();
}

/**
 * Drop specific entries, keeping the rest.
 *
 * Used after a paste reports that some sources no longer exist: silently pasting the
 * survivors and leaving the dead ids on the clipboard would fail again on every
 * subsequent paste, with the same unexplained failure count each time.
 */
export function dropClipboardEntries(ids: readonly string[]): void {
  hydrate();
  if (!clipboard || ids.length === 0) return;
  const drop = new Set(ids);
  const kept = clipboard.entries.filter((e) => !drop.has(e.id));
  if (kept.length === clipboard.entries.length) return;
  if (kept.length === 0) {
    clearClipboard();
    return;
  }
  clipboard = { ...clipboard, entries: kept, count: kept.length };
  persist(clipboard);
  emit();
}

/* ─────────────────────────────  Reads  ───────────────────────────── */

export function getClipboard(): FileClipboard {
  hydrate();
  // A clipboard held in memory past its TTL is as stale as one read from storage.
  if (clipboard && Date.now() - clipboard.savedAt > CLIPBOARD_TTL_MS) {
    clipboard = null;
    persist(null);
  }
  return clipboard;
}

/** Ids the clipboard would MOVE — the set Explorer paints ghosted. */
export function cutIds(clip: FileClipboard): Set<string> {
  if (!clip || clip.mode !== "cut") return EMPTY_SET;
  return new Set(clip.entries.map((e) => e.id));
}

const EMPTY_SET: Set<string> = new Set();

/**
 * Subscribe to clipboard changes.
 *
 * Exported so the store can be exercised without mounting a component — the hook below
 * is the only production caller.
 */
export function subscribeClipboard(cb: () => void): () => void {
  hydrate();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook to read the current clipboard reactively. */
export function useFileClipboard(): FileClipboard {
  return useSyncExternalStore(subscribeClipboard, getClipboard, () => null);
}

/** Test seam: forget everything, including the persisted copy and the hydration flag. */
export function resetClipboardForTests(): void {
  clipboard = null;
  hydrated = false;
  listeners.clear();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage was never available.
    }
  }
}
