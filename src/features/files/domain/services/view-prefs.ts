"use client";

/**
 * Tiny localStorage-backed preferences for the file browser (view mode, sort,
 * folder-tree pane). SSR-safe: reads return the fallback on the server, writes
 * are no-ops there.
 */

import type { TranslationKey } from "@/shared/lib/i18n/dictionary";

const VIEW_KEY = "files:view";
const SORT_BY_KEY = "files:sortBy";
const SORT_ORDER_KEY = "files:sortOrder";
const TREE_OPEN_KEY = "files:treeOpen";
const TREE_WIDTH_KEY = "files:treeWidth";

export type FileView = "grid" | "list";
export type SortOrder = "asc" | "desc";

const SORT_KEYS = ["name", "size", "date", "type"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage full / blocked — ignore */
  }
}

export function loadView(fallback: FileView = "grid"): FileView {
  return read(VIEW_KEY) === "list" ? "list" : read(VIEW_KEY) === "grid" ? "grid" : fallback;
}

export function saveView(view: FileView): void {
  write(VIEW_KEY, view);
}

export function loadSortBy(fallback: SortKey = "name"): SortKey {
  const v = read(SORT_BY_KEY);
  return (SORT_KEYS as readonly string[]).includes(v ?? "") ? (v as SortKey) : fallback;
}

export function saveSortBy(sortBy: string): void {
  write(SORT_BY_KEY, sortBy);
}

export function loadSortOrder(fallback: SortOrder = "asc"): SortOrder {
  return read(SORT_ORDER_KEY) === "desc" ? "desc" : read(SORT_ORDER_KEY) === "asc" ? "asc" : fallback;
}

export function saveSortOrder(order: SortOrder): void {
  write(SORT_ORDER_KEY, order);
}

/**
 * The sort menu, in the order it is offered. Each option carries a translation
 * key rather than a label: the list is module scope, evaluated once before any
 * locale is known, so the words can only be resolved at render.
 */
export const SORT_OPTIONS: { key: SortKey; labelKey: TranslationKey }[] = [
  { key: "name", labelKey: "common.name" },
  { key: "date", labelKey: "files.browser.sortLastModified" },
  { key: "size", labelKey: "files.list.colSize" },
  { key: "type", labelKey: "files.list.colType" },
];

/**
 * Folder-tree pane width, in px.
 *
 * The floor is where a folder name stops being readable next to its chevron; the
 * ceiling keeps the pane from squeezing the grid down to one column on a laptop.
 * A stored width is clamped on the way in as well as on the way out, so a value
 * hand-edited in devtools — or left behind by an older build with a different
 * range — cannot wedge the pane at an unusable size.
 */
export const TREE_WIDTH_MIN = 176;
export const TREE_WIDTH_MAX = 420;
export const TREE_WIDTH_DEFAULT = 248;

export function clampTreeWidth(px: number): number {
  if (!Number.isFinite(px)) return TREE_WIDTH_DEFAULT;
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(px)));
}

export function loadTreeWidth(fallback: number = TREE_WIDTH_DEFAULT): number {
  const raw = read(TREE_WIDTH_KEY);
  if (raw === null) return clampTreeWidth(fallback);
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? clampTreeWidth(fallback) : clampTreeWidth(parsed);
}

export function saveTreeWidth(px: number): void {
  write(TREE_WIDTH_KEY, String(clampTreeWidth(px)));
}

export function loadTreeOpen(fallback = true): boolean {
  const raw = read(TREE_OPEN_KEY);
  return raw === "1" ? true : raw === "0" ? false : fallback;
}

export function saveTreeOpen(open: boolean): void {
  write(TREE_OPEN_KEY, open ? "1" : "0");
}
