"use client";

/**
 * Which brain the UI is currently looking at.
 *
 * Kept in localStorage (not React state) so the choice survives navigation and
 * reloads, and read through useSyncExternalStore so every mounted brain page —
 * sidebar, dashboard, memory list — agrees without prop drilling.
 */

const STORAGE_KEY = "brain_active_id";
const EVENT = "brain-active-changed";

type Listener = () => void;

const listeners = new Set<Listener>();

export function getActiveBrainId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveBrainId(brainId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (brainId) localStorage.setItem(STORAGE_KEY, brainId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode / quota — fall through, the in-memory listeners still fire
  }
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeActiveBrain(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    // `storage` covers other tabs; the custom event covers this one.
    window.addEventListener("storage", listener);
    window.addEventListener(EVENT, listener);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", listener);
      window.removeEventListener(EVENT, listener);
    }
  };
}

/** Server snapshot for useSyncExternalStore — no localStorage during SSR. */
export function getServerActiveBrainId(): null {
  return null;
}
