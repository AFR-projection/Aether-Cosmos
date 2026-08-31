"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_GROUP_RULES } from "@brain/presentation/canvas/groups";
import {
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_FORCE_SETTINGS,
  type DisplaySettings,
  type ForceSettings,
  type GroupRule,
} from "@brain/presentation/canvas/types";

/**
 * Graph settings, persisted per brain.
 *
 * The key is scoped by brain id: brain A's groups and filters have nothing to do
 * with brain B's, and sharing one key would silently apply one brain's colour rules
 * to another's nodes. Storage is read through useSyncExternalStore rather than
 * copied into state in an effect, which keeps SSR honest (the server snapshot is
 * the defaults) and means a second window — the popped-out graph — picks up a
 * settings change from the main window through the `storage` event, live.
 *
 * The camera is deliberately absent. Node positions are not persisted, so a
 * restored pan would frame wherever those nodes happened to land this time: a
 * control that looks like it works and does not. Fit-on-load is the honest
 * behaviour.
 */

const STORAGE_PREFIX = "brain-graph-settings-v3:";

export type PersistedSettings = {
  query: string;
  groups: GroupRule[];
  force: ForceSettings;
  display: DisplaySettings;
  localMode: boolean;
  localDepth: number;
  /** Node id the local graph is centred on, so local mode survives a reload. */
  localFocalId: string | null;
  /**
   * Node ids hidden by hand from the context menu. Ids, not a text filter: hiding
   * "Ada" must not also hide every memory that mentions her.
   */
  hiddenIds: string[];
};

export const DEFAULT_PERSISTED_SETTINGS: PersistedSettings = {
  query: "",
  groups: DEFAULT_GROUP_RULES,
  force: DEFAULT_FORCE_SETTINGS,
  display: DEFAULT_DISPLAY_SETTINGS,
  localMode: false,
  localDepth: 2,
  localFocalId: null,
  hiddenIds: [],
};

type Listener = () => void;

const listeners = new Set<Listener>();
/** Parsed settings per brain. Identity must be stable for useSyncExternalStore. */
const cache = new Map<string, PersistedSettings>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let storageBound = false;

function keyFor(brainId: string): string {
  return `${STORAGE_PREFIX}${brainId}`;
}

function clampDepth(value: unknown): number {
  const depth = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 2;
  return Math.min(6, Math.max(1, depth));
}

/** Defaults-merged so a payload written by an older build cannot omit a field. */
function read(brainId: string): PersistedSettings {
  try {
    const raw = localStorage.getItem(keyFor(brainId));
    if (!raw) return DEFAULT_PERSISTED_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      groups: Array.isArray(parsed.groups) ? parsed.groups : DEFAULT_GROUP_RULES,
      force: { ...DEFAULT_FORCE_SETTINGS, ...(parsed.force ?? {}) },
      display: { ...DEFAULT_DISPLAY_SETTINGS, ...(parsed.display ?? {}) },
      localMode: parsed.localMode === true,
      localDepth: clampDepth(parsed.localDepth),
      localFocalId: typeof parsed.localFocalId === "string" ? parsed.localFocalId : null,
      hiddenIds: Array.isArray(parsed.hiddenIds)
        ? parsed.hiddenIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return DEFAULT_PERSISTED_SETTINGS;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key && !event.key.startsWith(STORAGE_PREFIX)) return;
  // Another document wrote settings: drop the parse cache so the next snapshot
  // re-reads, then let every subscriber render the new values.
  cache.clear();
  notify();
}

export function getGraphSettings(brainId: string | undefined): PersistedSettings {
  if (!brainId || typeof window === "undefined") return DEFAULT_PERSISTED_SETTINGS;
  const hit = cache.get(brainId);
  if (hit) return hit;
  const loaded = read(brainId);
  cache.set(brainId, loaded);
  return loaded;
}

export function updateGraphSettings(
  brainId: string | undefined,
  patch: Partial<PersistedSettings>
): void {
  if (!brainId) return;
  const merged = { ...getGraphSettings(brainId), ...patch };
  cache.set(brainId, merged);
  const pending = timers.get(brainId);
  if (pending !== undefined) clearTimeout(pending);
  // Debounced: dragging a slider is one write, not sixty. The value is captured
  // here, so a cache clear from another document cannot lose this edit.
  timers.set(
    brainId,
    setTimeout(() => {
      timers.delete(brainId);
      try {
        localStorage.setItem(keyFor(brainId), JSON.stringify(merged));
      } catch {
        // storage full or private mode — the in-memory cache still holds the value
      }
    }, 400)
  );
  notify();
}

export function subscribeGraphSettings(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined" && !storageBound) {
    storageBound = true;
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
  };
}

function serverSnapshot(): PersistedSettings {
  return DEFAULT_PERSISTED_SETTINGS;
}

export function useGraphSettings(brainId: string | undefined) {
  const settings = useSyncExternalStore(
    subscribeGraphSettings,
    () => getGraphSettings(brainId),
    serverSnapshot
  );

  const update = useCallback(
    (patch: Partial<PersistedSettings>) => updateGraphSettings(brainId, patch),
    [brainId]
  );

  return { settings, update };
}
