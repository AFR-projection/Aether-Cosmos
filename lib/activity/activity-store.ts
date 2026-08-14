"use client";

import { getCsrfToken } from "@/lib/api/client";

/**
 * Unified File Activity Store
 * Tracks all file operations: upload, download, delete, rename, move, copy, restore.
 * Completed history is persisted to localStorage so it survives page refreshes.
 */

export type ActivityType =
  | "upload"
  | "download"
  | "delete"
  | "rename"
  | "move"
  | "copy"
  | "restore"
  | "create_folder";

export type ActivityStatus =
  | "queued"
  | "preparing"
  | "processing"
  | "uploading"
  | "downloading"
  | "verifying"
  | "retrying"
  | "paused"
  | "active"
  | "done"
  | "completed"
  | "failed"
  | "cancelled";

export interface ActivityItem {
  id: string;
  type: ActivityType;
  status: ActivityStatus;
  /** Primary display name (file/folder name) */
  name: string;
  /** Secondary context: destination folder, new name, etc. */
  detail?: string;
  fileId?: string;
  source?: string;
  destination?: string;
  /** Explicit lifecycle state shown in the Activity Center. */
  phase?: ActivityStatus;
  /** Backend activity id when the entry came from activity_logs. */
  activityId?: string;
  /** Account-owned Activity Scope that produced this item. */
  scopeId?: string;
  /** Bytes transferred (upload / proxied download) */
  loaded?: number;
  /** Total bytes if known */
  total?: number;
  /** Transfer speed bytes/sec (smoothed) */
  speed?: number;
  /** 0–100 */
  progress?: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

type Listener = () => void;

const MAX_ITEMS = 200;
const STORAGE_KEY_PREFIX = "sbyafr_activity_v2:";
const LEGACY_STORAGE_KEY = "sbyafr_activity_v1";
const CHANNEL_NAME_PREFIX = "sbyafr_activity_channel_v2:";

// ─── Module-level state ──────────────────────────────────────────────────────

let items: ActivityItem[] = [];
const listeners = new Set<Listener>();
export const EMPTY_ACTIVITIES: readonly ActivityItem[] = Object.freeze([]);
let activeScopeId: string | null = null;
let activityChannel: BroadcastChannel | null = null;

function emit() { listeners.forEach((l) => l()); }
function uid() { return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function isFinished(status: ActivityStatus): boolean {
  return status === "done" || status === "completed" || status === "failed" || status === "cancelled";
}

type ActivityChannelMessage =
  | { kind: "request_snapshot"; scopeId: string }
  | { kind: "snapshot"; scopeId: string; items: ActivityItem[] }
  | { kind: "activity"; scopeId: string; item: ActivityItem };

function broadcast(message: ActivityChannelMessage) {
  try { activityChannel?.postMessage(message); } catch { /* another window may be closing */ }
}

function storageKey(scopeId: string): string {
  return `${STORAGE_KEY_PREFIX}${scopeId}`;
}

function closeActivityChannel() {
  activityChannel?.close();
  activityChannel = null;
}

function validScopeId(scopeId: string | null): scopeId is string {
  return !!scopeId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scopeId);
}

/** Switch the client store to an authenticated account-owned scope. */
export function configureActivityScope(scopeId: string | null): void {
  const nextScopeId = validScopeId(scopeId) ? scopeId : null;
  if (activeScopeId === nextScopeId) return;

  closeActivityChannel();
  activeScopeId = nextScopeId;
  items = nextScopeId ? loadHistory(nextScopeId) : [];

  if (typeof window !== "undefined") {
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore legacy cleanup failures */ }
  }

  if (nextScopeId && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    activityChannel = new BroadcastChannel(`${CHANNEL_NAME_PREFIX}${nextScopeId}`);
    activityChannel.onmessage = (event: MessageEvent<ActivityChannelMessage>) => {
      const message = event.data;
      if (!message || message.scopeId !== activeScopeId) return;
      if (message.kind === "request_snapshot") {
        broadcast({ kind: "snapshot", scopeId: nextScopeId, items });
      } else if (message.kind === "activity") {
        mergeExternalItem(message.item);
      } else if (message.kind === "snapshot") {
        for (const item of message.items) mergeExternalItem(item);
      }
    };
    broadcast({ kind: "request_snapshot", scopeId: nextScopeId });
  }
}

export function getActivityScopeId(): string | null {
  return activeScopeId;
}

function mergeExternalItem(incoming: ActivityItem) {
  if (!activeScopeId || (incoming.scopeId && incoming.scopeId !== activeScopeId)) return;
  incoming = { ...incoming, scopeId: activeScopeId };
  const existing = items.find((item) => item.id === incoming.id)
    ?? (incoming.fileId ? items.find((item) => item.fileId === incoming.fileId && item.type === incoming.type) : undefined);
  const id = existing?.id ?? incoming.id;
  items = [{ ...existing, ...incoming, id }, ...items.filter((item) => item.id !== id)].slice(0, MAX_ITEMS);
  emit();
  if (isFinished(incoming.status)) saveHistory();
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveHistory() {
  if (typeof window === "undefined") return;
  try {
    const finished = items.filter(
      (a) => isFinished(a.status)
    );
    if (activeScopeId) localStorage.setItem(storageKey(activeScopeId), JSON.stringify(finished.slice(0, MAX_ITEMS)));
  } catch { /* quota exceeded — silently ignore */ }
}

function loadHistory(scopeId: string): ActivityItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(scopeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityItem[];
    return parsed.filter(
      (a) => isFinished(a.status)
    );
  } catch { return []; }
}

// ─── Public read API ──────────────────────────────────────────────────────────

export function getActivities(): readonly ActivityItem[] { return activeScopeId ? items : EMPTY_ACTIVITIES; }

export function subscribeActivities(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveActivityCount(): number {
  return getActivities().filter((a) => !isFinished(a.status)).length;
}

// ─── Write API ────────────────────────────────────────────────────────────────

/** Start a long-running activity (upload/download). Returns its id. */
export function startActivity(
  type: ActivityType,
  name: string,
  opts: { detail?: string; total?: number } = {}
): string {
  const id = uid();
  if (!activeScopeId) return id;
  items = [
    { id, scopeId: activeScopeId, type, status: "active" as const, phase: "preparing" as const, name, detail: opts.detail, total: opts.total ?? 0,
      loaded: 0, speed: 0, progress: 0, startedAt: Date.now() },
    ...items,
  ].slice(0, MAX_ITEMS);
  broadcast({ kind: "activity", scopeId: activeScopeId, item: items[0] });
  emit();
  return id;
}

/** Upsert a live transfer using the engine's stable idempotency id. */
export function syncTransferActivity(input: {
  id: string;
  type: "upload" | "download";
  name: string;
  phase: ActivityStatus;
  loaded?: number;
  total?: number;
  speed?: number;
  error?: string;
  detail?: string;
  fileId?: string;
}) {
  if (!activeScopeId) return;
  const id = `transfer-${input.id}`;
  const existing = items.find((item) => item.id === id) ?? (input.fileId ? items.find((item) => item.fileId === input.fileId && item.type === input.type) : undefined);
  const resolvedId = existing?.id ?? id;
  const status: ActivityStatus = input.phase === "completed" ? "completed" : input.phase;
  const next: ActivityItem = {
    ...(existing ?? { id: resolvedId, type: input.type, name: input.name, startedAt: Date.now() }),
    type: input.type,
    scopeId: activeScopeId,
    name: input.name,
    status,
    phase: input.phase,
    loaded: input.loaded ?? existing?.loaded ?? 0,
    total: input.total ?? existing?.total ?? 0,
    speed: input.speed ?? existing?.speed ?? 0,
    progress: (input.total ?? existing?.total ?? 0) > 0
      ? Math.round(((input.loaded ?? existing?.loaded ?? 0) / (input.total ?? existing?.total ?? 1)) * 100)
      : status === "completed" ? 100 : existing?.progress ?? 0,
    error: input.error,
    detail: input.detail,
    fileId: input.fileId ?? existing?.fileId,
    endedAt: isFinished(status) ? existing?.endedAt ?? Date.now() : undefined,
  };
  items = [next, ...items.filter((item) => item.id !== resolvedId)].slice(0, MAX_ITEMS);
  broadcast({ kind: "activity", scopeId: activeScopeId, item: next });
  emit();
  if (isFinished(status)) saveHistory();
}

export function updateActivityProgress(id: string, loaded: number, total: number, speed: number) {
  const item = items.find((a) => a.id === id);
  if (!item || isFinished(item.status)) return;
  item.status = "active";
  item.phase = "processing";
  item.loaded = loaded;
  item.total = total;
  item.speed = speed;
  item.progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
  emit();
}

export function finishActivity(id: string) {
  const item = items.find((a) => a.id === id);
  if (!item) return;
  item.status = "done";
  item.phase = "completed";
  item.endedAt = Date.now();
  if ((item.total ?? 0) === 0) item.total = item.loaded ?? 0;
  item.progress = 100;
  emit();
  saveHistory();
}

export function failActivity(id: string, error: string) {
  const item = items.find((a) => a.id === id);
  if (!item) return;
  item.status = "failed";
  item.phase = "failed";
  item.error = error;
  item.endedAt = Date.now();
  emit();
  saveHistory();
}

/** Record a completed / instant action (rename, delete, move, copy, restore). */
export function recordActivity(
  type: ActivityType,
  name: string,
  status: "done" | "failed" | "cancelled",
  opts: { detail?: string; error?: string; total?: number; source?: string; destination?: string } = {}
): string {
  const id = uid();
  if (!activeScopeId) return id;
  const now = Date.now();
  items = [
      { id, scopeId: activeScopeId, type, status, phase: status, name, detail: opts.detail, error: opts.error,
      source: opts.source, destination: opts.destination,
      total: opts.total ?? 0, progress: status === "done" ? 100 : 0,
      startedAt: now, endedAt: now },
    ...items,
  ].slice(0, MAX_ITEMS);
  broadcast({ kind: "activity", scopeId: activeScopeId, item: items[0] });
  emit();
  saveHistory();
  return id;
}

/** Remove finished entries, keep active/queued ones. */
export function clearActivityHistory() {
  if (!activeScopeId) return;
  items = items.filter((a) => !isFinished(a.status));
  saveHistory();
  emit();
  void getCsrfToken()
    .then((token) => fetch(`/api/activity?scopeId=${encodeURIComponent(activeScopeId!)}`, { method: "DELETE", headers: { "x-csrf-token": token } }))
    .catch(() => {});
}

/** Remove a single entry by id. */
export function removeActivity(id: string) {
  items = items.filter((a) => a.id !== id);
  saveHistory();
  emit();
}

/** Merge backend history without replacing live client-side transfers. */
export function hydrateActivities(remoteItems: ActivityItem[], scopeId = activeScopeId) {
  if (!activeScopeId || scopeId !== activeScopeId) return;
  remoteItems = remoteItems.map((item) => ({ ...item, scopeId: activeScopeId! }));
  const existingIds = new Set(items.map((item) => item.activityId ?? item.id));
  const incoming = remoteItems.filter((item) => {
    if (existingIds.has(item.activityId ?? item.id)) return false;
    // A local transfer and its server audit row describe the same event when
    // they share the backend file id. Keep the live/local row as the source of
    // progress and avoid showing a duplicate completion entry.
    return !items.some((current) => current.fileId && item.fileId && current.fileId === item.fileId && current.type === item.type && isFinished(current.status) && isFinished(item.status));
  });
  if (incoming.length === 0) return;
  items = [...items, ...incoming]
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, MAX_ITEMS);
  saveHistory();
  emit();
}
