"use client";

const ACTIVITY_WINDOW_NAME = "FileActivityCenter";
const ACTIVITY_WINDOW_FEATURES = [
  "width=1000",
  "height=750",
  "left=100",
  "top=80",
  "resizable=yes",
  "scrollbars=yes",
  "noopener=no",
].join(",");

let activityWindow: Window | null = null;

export function canUseActivityPopup(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(min-width: 1024px) and (pointer: fine)").matches;
}

/** Open or focus the single named desktop Activity Center window. */
export function openActivityPopup(scopeId?: string | null): boolean {
  if (typeof window === "undefined" || !canUseActivityPopup()) return false;

  try {
    const path = scopeId ? `/files/activity/${encodeURIComponent(scopeId)}` : "/files/activity";
    if (activityWindow && !activityWindow.closed) {
      if (activityWindow.location.pathname !== path) activityWindow.location.href = path;
      activityWindow.focus();
      return true;
    }

    const next = window.open(path, ACTIVITY_WINDOW_NAME, ACTIVITY_WINDOW_FEATURES);
    if (!next) return false;
    activityWindow = next;
    next.focus();
    return true;
  } catch {
    // A browser extension or security policy may reject window.open.
    return false;
  }
}
