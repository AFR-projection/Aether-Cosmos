"use client";

/**
 * Lightweight cross-component signals for the mobile quick-actions FAB.
 *
 * The FileBrowser owns all upload/note/folder logic. Rather than duplicate any
 * of it, the mobile bottom-nav "+" dispatches one of these window events; the
 * FileBrowser (when mounted on /files) listens and runs its existing handler.
 * When the user triggers an action from another page, the bottom-nav navigates
 * to /files first, then dispatches once the browser has mounted.
 */
export const QUICK_ACTION_EVENT = "storagebyafr:quick-action";

export type QuickAction = "upload" | "note" | "folder";

export function emitQuickAction(action: QuickAction) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(QUICK_ACTION_EVENT, { detail: action }));
}
