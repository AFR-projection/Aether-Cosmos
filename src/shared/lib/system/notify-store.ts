"use client";

export type NotifyTone = "info" | "success" | "warning" | "error" | "system";

export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline"
  | "idle";

export type SystemNotice = {
  id: string;
  title: string;
  description?: string;
  tone: NotifyTone;
  duration: number;
  createdAt: number;
  /** How many times this same message arrived while it was on screen. */
  count: number;
};

type Listener = () => void;

type NotifyInput = {
  title: string;
  description?: string;
  tone?: NotifyTone;
  duration?: number;
};

const MAX_TOASTS = 4;
/**
 * Two subsystems can describe the same event — a local upload queue finishing
 * and the realtime channel reporting the same file, "Back online" and
 * "Reconnected" — and the user reads that as the app stuttering. An identical
 * message that lands while the first is still on screen bumps a counter
 * instead of stacking a second card.
 */
const DEDUP_WINDOW_MS = 8000;

/** Stable empty snapshot for useSyncExternalStore getServerSnapshot (never allocate a new []). */
export const EMPTY_NOTICES: readonly SystemNotice[] = Object.freeze([]);

let notices: SystemNotice[] = [];
let connection: ConnectionStatus = "idle";
let navBusy = false;
let apiBusyCount = 0;

const noticeListeners = new Set<Listener>();
const connectionListeners = new Set<Listener>();
const busyListeners = new Set<Listener>();

function emit(set: Set<Listener>) {
  set.forEach((l) => l());
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getSystemNotices() {
  return notices;
}

export function subscribeSystemNotices(listener: Listener) {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

/** Auto-dismiss timers, kept so a collapsed repeat can restart its own clock. */
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDismiss(id: string) {
  const timer = dismissTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  dismissTimers.delete(id);
}

function scheduleDismiss(notice: SystemNotice) {
  clearDismiss(notice.id);
  if (notice.duration <= 0 || typeof window === "undefined") return;
  dismissTimers.set(
    notice.id,
    setTimeout(() => dismissNotice(notice.id), notice.duration)
  );
}

export function notify(input: NotifyInput): string {
  const description = input.description;
  const duration = input.duration ?? 4200;
  const now = Date.now();

  const twin = notices.find(
    (candidate) =>
      candidate.title === input.title &&
      candidate.description === description &&
      now - candidate.createdAt < DEDUP_WINDOW_MS
  );
  if (twin) {
    const merged: SystemNotice = { ...twin, count: twin.count + 1, createdAt: now, duration };
    notices = notices.map((candidate) => (candidate.id === twin.id ? merged : candidate));
    emit(noticeListeners);
    scheduleDismiss(merged);
    return twin.id;
  }

  const id = uid();
  const notice: SystemNotice = {
    id,
    title: input.title,
    description,
    tone: input.tone ?? "system",
    duration,
    createdAt: now,
    count: 1,
  };
  const dropped = notices.slice(MAX_TOASTS - 1);
  notices = [notice, ...notices].slice(0, MAX_TOASTS);
  for (const gone of dropped) clearDismiss(gone.id);
  emit(noticeListeners);
  scheduleDismiss(notice);
  return id;
}

export function dismissNotice(id: string) {
  const next = notices.filter((n) => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  clearDismiss(id);
  emit(noticeListeners);
}

export function getConnectionStatus() {
  return connection;
}

export function subscribeConnectionStatus(listener: Listener) {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function setConnectionStatus(status: ConnectionStatus) {
  if (connection === status) return;
  connection = status;
  emit(connectionListeners);
}

export function getSystemBusy() {
  return navBusy || apiBusyCount > 0;
}

export function subscribeSystemBusy(listener: Listener) {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}

export function setNavigationBusy(busy: boolean) {
  if (navBusy === busy) return;
  navBusy = busy;
  emit(busyListeners);
}

export function beginApiBusy() {
  apiBusyCount += 1;
  emit(busyListeners);
}

export function endApiBusy() {
  apiBusyCount = Math.max(0, apiBusyCount - 1);
  emit(busyListeners);
}

/** Compatibility helper used by older call sites. */
export function showSystemToast(message: string, durationMs = 4200) {
  notify({ title: message, tone: "system", duration: durationMs });
}
