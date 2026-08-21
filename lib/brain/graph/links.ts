/**
 * Every URL the graph produces, in one place.
 *
 * Two rules hold here. A link the graph hands out must actually resolve to the
 * thing it names — an entity has no page of its own in this app, so `memoryHref`
 * returns null for one rather than inventing a route. And a shared link must not
 * depend on hidden state: the workspace URL carries the brain id, so pasting it
 * anywhere opens that brain's graph on that node regardless of which brain the
 * session happens to have active.
 *
 * The workspace lives outside /brain because every route under it is wrapped in
 * the app shell (sidebar, header, padding), and the point of the pop-out window is
 * a graph with nothing else in it. Its own layout still authenticates, and the
 * snapshot endpoint authorizes the brain id independently, so a hand-typed id in
 * the URL buys nothing.
 */

import type { GraphNode } from "./types";

export const GRAPH_POPUP_PATH = "/graph-workspace";
/** Named target, so a second pop-out reuses the same window instead of stacking. */
export const GRAPH_POPUP_WINDOW = "second-brain-graph";

export function graphWorkspacePath(
  brainId: string,
  focusNodeId?: string | null
): string {
  const params = new URLSearchParams({ brain: brainId });
  if (focusNodeId) params.set("focus", focusNodeId);
  return `${GRAPH_POPUP_PATH}?${params.toString()}`;
}

/** Deep link into the memories list. Entities have no page, hence the null. */
export function memoryHref(node: GraphNode): string | null {
  return node.kind === "memory" ? `/brain/memories?q=${encodeURIComponent(node.label)}` : null;
}

/** Absolute URL that reopens this graph centred on one node. */
export function nodeShareUrl(brainId: string | undefined, node: GraphNode): string | null {
  if (!brainId || typeof window === "undefined") return null;
  return `${window.location.origin}${graphWorkspacePath(brainId, node.id)}`;
}

/**
 * Opens the standalone workspace. Returns false when the browser blocked it, so
 * the caller can say so instead of leaving the click looking broken.
 */
export function openGraphPopup(
  brainId: string | undefined,
  focusNodeId?: string | null
): boolean {
  if (!brainId || typeof window === "undefined") return false;
  // Sized to the screen rather than to fixed pixels: a graph is worth the room,
  // and a hardcoded 1600x1000 is either cramped or off-screen depending on the
  // display. `popup=yes` is what makes Chromium give a chromeless window.
  const width = Math.min(1600, Math.max(900, Math.round(window.screen.availWidth * 0.8)));
  const height = Math.min(1000, Math.max(600, Math.round(window.screen.availHeight * 0.85)));
  const left = Math.max(0, Math.round((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.round((window.screen.availHeight - height) / 2));
  const features = [
    "popup=yes",
    "resizable=yes",
    "scrollbars=no",
    "toolbar=no",
    "menubar=no",
    "location=no",
    "status=no",
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
  ].join(",");
  const opened = window.open(
    graphWorkspacePath(brainId, focusNodeId),
    GRAPH_POPUP_WINDOW,
    features
  );
  if (!opened) return false;
  opened.focus();
  return true;
}
