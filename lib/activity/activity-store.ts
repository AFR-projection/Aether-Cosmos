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

/**
 * `items` is the working array: a progress update replaces one slot, so rows
 * keep their position instead of jumping to the front on every tick. React is
 * handed `snapshot` — a copy, so `useSyncExternalStore` sees a new reference and
 * re-renders, but one that still shares the untouched item objects, so memoised
 * rows don't.
 */
let snapshot: readonly ActivityItem[] = EMPTY_ACTIVITIES;
let snapshotDirty = false;

/** id → slot and `type:fileId` → slot, so a tick costs a Map lookup, not two scans. */
let slotById: Map<string, number> | null = null;
let slotByFile: Map<string, number> | null = null;

function fileKey(type: ActivityType, fileId: string): string {
  return `${type}:${fileId}`;
}

function ensureSlots() {
  if (slotById && slotByFile) return;
  const byId = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    byId.set(item.id, index);
    if (item.fileId) byFile.set(fileKey(item.type, item.fileId), index);
  }
  slotById = byId;
  slotByFile = byFile;
}

/** Returns the slot of a matching entry, or -1. */
function findSlot(id: string, type?: ActivityType, fileId?: string): number {
  ensureSlots();
  const direct = slotById!.get(id);
  if (direct !== undefined) return direct;
  if (!type || !fileId) return -1;
  return slotByFile!.get(fileKey(type, fileId)) ?? -1;
}

/** Use for anything that changes the shape of the list, not just a slot's contents. */
function replaceItems(next: ActivityItem[]) {
  items = next;
  slotById = null;
  slotByFile = null;
  snapshotDirty = true;
}

function isFinished(status: ActivityStatus): boolean {
  return status === "done" || status === "completed" || status === "failed" || status === "cancelled";
}

let emitRaf: number | null = null;
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function runListeners() {
  if (emitRaf !== null) {
    cancelAnimationFrame(emitRaf);
    emitRaf = null;
  }
  if (emitTimer !== null) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  listeners.forEach((l) => l());
}

/**
 * A folder upload writes here up to ten times a second per file, and every write
 * used to walk every React subscriber synchronously. Listeners are now notified
 * at most once per frame. The state write itself stays synchronous, so anything
 * reading getActivities() straight afterwards still sees it. rAF is the trigger;
 * the timer is the backstop for a hidden tab, where rAF never fires but
 * transfers keep running.
 */
function emit() {
  snapshotDirty = true;
  if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined") {
    listeners.forEach((l) => l());
    return;
  }
  if (emitRaf !== null || emitTimer !== null) return;
  emitRaf = requestAnimationFrame(runListeners);
  emitTimer = setTimeout(runListeners, 250);
}

function uid() { return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

type ActivityChannelMessage =
  | { kind: "request_snapshot"; scopeId: string }
  | { kind: "snapshot"; scopeId: string; items: ActivityItem[] }
  | { kind: "activity"; scopeId: string; item: ActivityItem };

function broadcast(message: ActivityChannelMessage) {
  try { activityChannel?.postMessage(message); } catch { /* another window may be closing */ }
}

const PROGRESS_BROADCAST_MS = 400;
const lastProgressBroadcast = new Map<string, number>();

/** True at most every PROGRESS_BROADCAST_MS per transfer. */
function allowProgressBroadcast(id: string): boolean {
  const now = Date.now();
  if (now - (lastProgressBroadcast.get(id) ?? 0) < PROGRESS_BROADCAST_MS) return false;
  lastProgressBroadcast.set(id, now);
  return true;
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

  // Written out under the scope it belongs to, before the switch swaps the key.
  flushHistory();
  closeActivityChannel();
  activeScopeId = nextScopeId;
  replaceItems(nextScopeId ? loadHistory(nextScopeId) : []);

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
  const slot = findSlot(incoming.id, incoming.type, incoming.fileId);
  if (slot >= 0) {
    // Same treatment as a local tick: the row is updated where it sits rather
    // than being lifted to the top of the list on every message.
    const existing = items[slot]!;
    items[slot] = { ...existing, ...incoming, id: existing.id };
    if (incoming.fileId && incoming.fileId !== existing.fileId) {
      slotByFile?.set(fileKey(incoming.type, incoming.fileId), slot);
    }
  } else {
    replaceItems([incoming, ...items].slice(0, MAX_ITEMS));
  }
  emit();
  if (isFinished(incoming.status)) saveHistory();
}

// ─── Persistence ─────────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function writeHistory() {
  saveTimer = null;
  if (typeof window === "undefined" || !activeScopeId) return;
  try {
    const finished: ActivityItem[] = [];
    for (const item of items) {
      if (!isFinished(item.status)) continue;
      finished.push(item);
      if (finished.length >= MAX_ITEMS) break;
    }
    localStorage.setItem(storageKey(activeScopeId), JSON.stringify(finished));
  } catch { /* quota exceeded — silently ignore */ }
}

/**
 * Serialising up to 200 rows and handing them to localStorage is synchronous
 * main-thread work, and the files in a folder upload finish back to back. The
 * write is coalesced; `flushHistory` covers the cases where it cannot wait.
 */
function saveHistory() {
  if (typeof window === "undefined") return;
  if (saveTimer !== null) return;
  saveTimer = setTimeout(writeHistory, 600);
}

function flushHistory() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeHistory();
}

if (typeof window !== "undefined") {
  // A pending write must not be lost to a tab close or a backgrounded tab.
  window.addEventListener("pagehide", flushHistory);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHistory();
  });
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

export function getActivities(): readonly ActivityItem[] {
  if (!activeScopeId) return EMPTY_ACTIVITIES;
  // Refreshed on read rather than on write: a burst of ten writes in one tick
  // costs one copy, and the reference stays stable while nothing changes so
  // useSyncExternalStore does not see a phantom update.
  if (snapshotDirty) {
    snapshot = items.slice();
    snapshotDirty = false;
  }
  return snapshot;
}

export function subscribeActivities(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveActivityCount(): number {
  let count = 0;
  for (const item of items) if (!isFinished(item.status)) count++;
  return activeScopeId ? count : 0;
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
  replaceItems([
    { id, scopeId: activeScopeId, type, status: "active" as const, phase: "preparing" as const, name, detail: opts.detail, total: opts.total ?? 0,
      loaded: 0, speed: 0, progress: 0, startedAt: Date.now() },
    ...items,
  ].slice(0, MAX_ITEMS));
  broadcast({ kind: "activity", scopeId: activeScopeId, item: items[0]! });
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
  const slot = findSlot(id, input.type, input.fileId);
  const existing = slot >= 0 ? items[slot]! : undefined;
  const resolvedId = existing?.id ?? id;
  const status: ActivityStatus = input.phase === "completed" ? "completed" : input.phase;
  const total = input.total ?? existing?.total ?? 0;
  const loaded = input.loaded ?? existing?.loaded ?? 0;
  const next: ActivityItem = {
    ...(existing ?? { id: resolvedId, type: input.type, name: input.name, startedAt: Date.now() }),
    type: input.type,
    scopeId: activeScopeId,
    name: input.name,
    status,
    phase: input.phase,
    loaded,
    total,
    speed: input.speed ?? existing?.speed ?? 0,
    progress: total > 0
      ? Math.round((loaded / total) * 100)
      : status === "completed" ? 100 : existing?.progress ?? 0,
    error: input.error,
    detail: input.detail,
    fileId: input.fileId ?? existing?.fileId,
    endedAt: isFinished(status) ? existing?.endedAt ?? Date.now() : undefined,
  };
  if (existing) {
    // One slot replaced. The old version rebuilt the whole array and moved the
    // row to the front, so a running list reshuffled on every tick.
    items[slot] = next;
    if (next.fileId && next.fileId !== existing.fileId) {
      slotByFile?.set(fileKey(next.type, next.fileId), slot);
    }
    snapshotDirty = true;
  } else {
    replaceItems([next, ...items].slice(0, MAX_ITEMS));
  }
  const finished = isFinished(status);
  // Every tick used to be a structured clone posted to every other tab. State
  // changes still go out at once; plain progress is sampled.
  if (finished || existing?.phase !== input.phase || allowProgressBroadcast(resolvedId)) {
    broadcast({ kind: "activity", scopeId: activeScopeId, item: next });
  }
  emit();
  if (finished) {
    lastProgressBroadcast.delete(resolvedId);
    saveHistory();
  }
}

export function updateActivityProgress(id: string, loaded: number, total: number, speed: number) {
  const slot = findSlot(id);
  const item = slot >= 0 ? items[slot]! : undefined;
  if (!item || isFinished(item.status)) return;
  // A replaced slot rather than a mutated object: a memoised row only re-renders
  // when its own entry actually changed identity.
  items[slot] = {
    ...item,
    status: "active",
    phase: "processing",
    loaded,
    total,
    speed,
    progress: total > 0 ? Math.round((loaded / total) * 100) : 0,
  };
  emit();
}

export function finishActivity(id: string) {
  const slot = findSlot(id);
  const item = slot >= 0 ? items[slot]! : undefined;
  if (!item) return;
  const total = (item.total ?? 0) === 0 ? item.loaded ?? 0 : item.total;
  items[slot] = { ...item, status: "done", phase: "completed", endedAt: Date.now(), total, progress: 100 };
  emit();
  saveHistory();
}

export function failActivity(id: string, error: string) {
  const slot = findSlot(id);
  const item = slot >= 0 ? items[slot]! : undefined;
  if (!item) return;
  items[slot] = { ...item, status: "failed", phase: "failed", error, endedAt: Date.now() };
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
  replaceItems([
      { id, scopeId: activeScopeId, type, status, phase: status, name, detail: opts.detail, error: opts.error,
      source: opts.source, destination: opts.destination,
      total: opts.total ?? 0, progress: status === "done" ? 100 : 0,
      startedAt: now, endedAt: now },
    ...items,
  ].slice(0, MAX_ITEMS));
  broadcast({ kind: "activity", scopeId: activeScopeId, item: items[0]! });
  emit();
  saveHistory();
  return id;
}

/** Remove finished entries, keep active/queued ones. */
export function clearActivityHistory() {
  if (!activeScopeId) return;
  replaceItems(items.filter((a) => !isFinished(a.status)));
  flushHistory();
  emit();
  void getCsrfToken()
    .then((token) => fetch(`/api/activity?scopeId=${encodeURIComponent(activeScopeId!)}`, { method: "DELETE", headers: { "x-csrf-token": token } }))
    .catch(() => {});
}

/** Remove a single entry by id. */
export function removeActivity(id: string) {
  replaceItems(items.filter((a) => a.id !== id));
  flushHistory();
  emit();
}

/** Merge backend history without replacing live client-side transfers. */
export function hydrateActivities(remoteItems: ActivityItem[], scopeId = activeScopeId) {
  if (!activeScopeId || scopeId !== activeScopeId) return;
  remoteItems = remoteItems.map((item) => ({ ...item, scopeId: activeScopeId! }));
  const existingIds = new Set(items.map((item) => item.activityId ?? item.id));
  // Built once instead of re-scanning `items` per remote row: hydration runs with
  // up to 200 local rows and a full page of server history.
  const finishedFileKeys = new Set<string>();
  for (const current of items) {
    if (current.fileId && isFinished(current.status)) finishedFileKeys.add(fileKey(current.type, current.fileId));
  }
  const incoming = remoteItems.filter((item) => {
    if (existingIds.has(item.activityId ?? item.id)) return false;
    // A local transfer and its server audit row describe the same event when
    // they share the backend file id. Keep the live/local row as the source of
    // progress and avoid showing a duplicate completion entry.
    return !(item.fileId && isFinished(item.status) && finishedFileKeys.has(fileKey(item.type, item.fileId)));
  });
  if (incoming.length === 0) return;
  replaceItems([...items, ...incoming]
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, MAX_ITEMS));
  saveHistory();
  emit();
}
