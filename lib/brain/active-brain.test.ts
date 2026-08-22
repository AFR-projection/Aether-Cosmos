import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getActiveBrainId,
  setActiveBrainId,
  subscribeActiveBrain,
  getServerActiveBrainId,
} from "./active-brain";

/**
 * Which brain the UI is looking at.
 *
 * The choice lives in localStorage so it survives navigation and reloads, and every
 * mounted brain page reads it through the same store. Two failure modes are what the
 * tests are for: a browser that refuses localStorage (private mode, quota) must not
 * take the UI down — the selection still has to propagate in-memory — and SSR, where
 * there is no window at all, must return null rather than throw.
 */

type Store = { store: Map<string, string>; throws: boolean };

const local: Store = { store: new Map(), throws: false };
const handlers = new Map<string, Set<(event: Event) => void>>();
const unsubscribes: Array<() => void> = [];

function stubBrowser(): void {
  vi.stubGlobal("localStorage", {
    getItem(key: string) {
      if (local.throws) throw new Error("SecurityError");
      return local.store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (local.throws) throw new Error("QuotaExceededError");
      local.store.set(key, value);
    },
    removeItem(key: string) {
      if (local.throws) throw new Error("SecurityError");
      local.store.delete(key);
    },
  });
  vi.stubGlobal("window", {
    addEventListener(type: string, handler: (event: Event) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: Event) => void) {
      handlers.get(type)?.delete(handler);
    },
    dispatchEvent(event: Event) {
      for (const handler of handlers.get(event.type) ?? []) handler(event);
      return true;
    },
    localStorage,
  });
}

/** Registers a listener and remembers how to tear it down. */
function listen(): ReturnType<typeof vi.fn> {
  const listener = vi.fn();
  unsubscribes.push(subscribeActiveBrain(listener));
  return listener;
}

beforeEach(() => {
  local.store.clear();
  local.throws = false;
  handlers.clear();
  stubBrowser();
});

afterEach(() => {
  while (unsubscribes.length > 0) unsubscribes.pop()!();
  vi.unstubAllGlobals();
});
describe("reading the active brain", () => {
  it("returns what was stored", () => {
    local.store.set("brain_active_id", "brain-1");
    expect(getActiveBrainId()).toBe("brain-1");
  });

  it("returns null when nothing was chosen yet", () => {
    expect(getActiveBrainId()).toBeNull();
  });

  it("returns null instead of throwing when the browser refuses storage", () => {
    // Private mode: the app must still render, just without a remembered choice.
    local.throws = true;
    expect(getActiveBrainId()).toBeNull();
  });

  it("returns null during SSR, where there is no window", () => {
    vi.unstubAllGlobals();
    expect(getActiveBrainId()).toBeNull();
    expect(getServerActiveBrainId()).toBeNull();
  });
});

describe("changing the active brain", () => {
  it("stores the id and tells every mounted page", () => {
    const listener = listen();

    setActiveBrainId("brain-1");

    expect(local.store.get("brain_active_id")).toBe("brain-1");
    expect(getActiveBrainId()).toBe("brain-1");
    // Once through the internal set, once through the dispatched event.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears the choice on null", () => {
    local.store.set("brain_active_id", "brain-1");

    setActiveBrainId(null);

    expect(local.store.has("brain_active_id")).toBe(false);
    expect(getActiveBrainId()).toBeNull();
  });

  it("still notifies listeners when the write itself failed", () => {
    // The selection has to work for this session even if it cannot be persisted.
    local.throws = true;
    const listener = listen();

    expect(() => setActiveBrainId("brain-1")).not.toThrow();
    expect(listener).toHaveBeenCalled();
  });

  it("does nothing at all on the server", () => {
    const listener = listen();
    vi.unstubAllGlobals();

    setActiveBrainId("brain-1");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("subscribing", () => {
  it("listens for other tabs as well as this one", () => {
    listen();

    expect(handlers.get("storage")?.size).toBe(1);
    expect(handlers.get("brain-active-changed")?.size).toBe(1);
  });

  it("fires when another tab changes the value", () => {
    const listener = listen();

    window.dispatchEvent(new Event("storage"));

    expect(listener).toHaveBeenCalledOnce();
  });

  it("stops firing after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveBrain(listener);

    unsubscribe();
    setActiveBrainId("brain-1");
    window.dispatchEvent(new Event("storage"));

    expect(listener).not.toHaveBeenCalled();
    expect(handlers.get("storage")?.size).toBe(0);
    expect(handlers.get("brain-active-changed")?.size).toBe(0);
  });

  it("keeps other subscribers alive when one unsubscribes", () => {
    const staying = listen();
    const leaving = vi.fn();
    subscribeActiveBrain(leaving)();

    setActiveBrainId("brain-2");

    expect(staying).toHaveBeenCalled();
    expect(leaving).not.toHaveBeenCalled();
  });
});

