"use client";

import { notify } from "@/lib/system/notify-store";
import { syncTransferActivity } from "@/lib/activity/activity-store";

/**
 * Client-side download manager: a small external store (same pattern as
 * notify-store) that tracks active and recent downloads so the UI can show a
 * badge count and a history panel, and surfaces toasts at key moments.
 *
 * Downloads that go straight to R2 (single-file, via a browser navigation) are
 * fire-and-forget: we mark them "started" then "done" optimistically, since the
 * browser owns the transfer and does not report progress back to JS. Proxied
 * downloads (ZIP, or opt-in progress mode) update `loaded`/`total`/`speed` live.
 */

export type DownloadStatus = "active" | "done" | "error" | "canceled";

export type DownloadItem = {
  id: string;
  name: string;
  status: DownloadStatus;
  /** Bytes transferred so far (proxied downloads only). */
  loaded: number;
  /** Total bytes if known (0 when unknown, e.g. streamed ZIP). */
  total: number;
  /** Bytes/sec, smoothed (proxied downloads only). */
  speed: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
};

type Listener = () => void;

const MAX_HISTORY = 30;

export const EMPTY_DOWNLOADS: readonly DownloadItem[] = Object.freeze([]);

let items: DownloadItem[] = [];
const listeners = new Set<Listener>();
let activeScopeId: string | null = null;

function emit() {
  listeners.forEach((l) => l());
}

function uid() {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getDownloads(): readonly DownloadItem[] {
  return activeScopeId || typeof window === "undefined" ? items : EMPTY_DOWNLOADS;
}

export function configureDownloadScope(scopeId: string | null): void {
  if (activeScopeId === scopeId) return;
  activeScopeId = scopeId;
  items = [];
}

export function subscribeDownloads(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Count of downloads currently in progress — drives the sidebar badge. */
export function getActiveDownloadCount(): number {
  return items.reduce((n, d) => (d.status === "active" ? n + 1 : n), 0);
}

export function startDownload(name: string, total = 0): string {
  const id = uid();
  if (!activeScopeId && typeof window !== "undefined") return id;
  const item: DownloadItem = {
    id,
    name,
    status: "active",
    loaded: 0,
    total,
    speed: 0,
    startedAt: Date.now(),
  };
  items = [item, ...items].slice(0, MAX_HISTORY);
  syncTransferActivity({ id, type: "download", name, phase: "downloading", loaded: 0, total, speed: 0 });
  emit();
  notify({ title: "Download started", description: name, tone: "info", duration: 3000 });
  return id;
}

export function updateDownloadProgress(
  id: string,
  loaded: number,
  total: number,
  speed: number
) {
  const item = items.find((d) => d.id === id);
  if (!item || item.status !== "active") return;
  item.loaded = loaded;
  item.total = total;
  item.speed = speed;
  syncTransferActivity({ id, type: "download", name: item.name, phase: "downloading", loaded, total, speed });
  emit();
}

export function finishDownload(id: string) {
  const item = items.find((d) => d.id === id);
  if (!item) return;
  item.status = "done";
  item.endedAt = Date.now();
  if (item.total === 0) item.total = item.loaded;
  syncTransferActivity({ id, type: "download", name: item.name, phase: "completed", loaded: item.loaded, total: item.total, speed: item.speed });
  emit();
  notify({ title: "Download complete", description: item.name, tone: "success", duration: 3000 });
}

export function failDownload(id: string, error: string) {
  const item = items.find((d) => d.id === id);
  if (!item) return;
  item.status = "error";
  item.error = error;
  item.endedAt = Date.now();
  syncTransferActivity({ id, type: "download", name: item.name, phase: "failed", loaded: item.loaded, total: item.total, speed: item.speed, error });
  emit();
  notify({ title: "Download failed", description: `${item.name} — ${error}`, tone: "error", duration: 5000 });
}

export function cancelDownload(id: string) {
  const item = items.find((d) => d.id === id);
  if (!item || item.status !== "active") return;
  item.status = "canceled";
  item.endedAt = Date.now();
  syncTransferActivity({ id, type: "download", name: item.name, phase: "cancelled", loaded: item.loaded, total: item.total, speed: item.speed });
  emit();
}

/** Remove finished/failed entries from history (keeps active ones). */
export function clearDownloadHistory() {
  const next = items.filter((d) => d.status === "active");
  if (next.length === items.length) return;
  items = next;
  emit();
}
