import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CLIPBOARD_TTL_MS,
  MAX_CLIPBOARD_ENTRIES,
  clearClipboard,
  cutIds,
  dropClipboardEntries,
  getClipboard,
  parseStoredClipboard,
  resetClipboardForTests,
  setClipboard,
  subscribeClipboard,
  type ClipboardEntry,
} from "@files/domain/services/clipboard";

/**
 * The clipboard is the only piece of paste state that outlives a page, so the tests that
 * matter here are the ones about *not trusting it*: a payload written by another tab or
 * an older build must never reach a paste, and a clipboard nobody pasted must expire.
 *
 * The suite runs in the `node` environment, so `window` and `localStorage` are stubbed
 * by hand — small enough that a real DOM would only hide what the module depends on.
 */

const STORAGE_KEY = "afr.files.clipboard.v1";

type StorageHandler = (event: { key: string | null }) => void;

let store: Map<string, string>;
let handlers: StorageHandler[];
let throwOnWrite = false;

function installWindow(): void {
  store = new Map();
  handlers = [];
  throwOnWrite = false;

  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (throwOnWrite) throw new Error("quota exceeded");
        store.set(key, value);
      },
      removeItem: (key: string) => {
        if (throwOnWrite) throw new Error("quota exceeded");
        store.delete(key);
      },
    },
    addEventListener: (type: string, handler: StorageHandler) => {
      if (type === "storage") handlers.push(handler);
    },
  };

  Object.defineProperty(globalThis, "window", {
    value: fakeWindow,
    configurable: true,
    writable: true,
  });
}

/** Simulate a write performed by a different tab. */
function otherTabWrote(value: unknown): void {
  if (value === null) store.delete(STORAGE_KEY);
  else store.set(STORAGE_KEY, JSON.stringify(value));
  for (const handler of handlers) handler({ key: STORAGE_KEY });
}

const FILE: ClipboardEntry = { kind: "file", id: "file-1", name: "report.pdf" };
const FOLDER: ClipboardEntry = { kind: "folder", id: "folder-1", name: "Projects" };

beforeEach(() => {
  installWindow();
  resetClipboardForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetClipboardForTests();
  Reflect.deleteProperty(globalThis, "window");
});

describe("setClipboard", () => {
  it("records the mode, entries and where they came from", () => {
    setClipboard("cut", [FILE, FOLDER], "source-folder", "2 items");

    expect(getClipboard()).toMatchObject({
      mode: "cut",
      entries: [FILE, FOLDER],
      sourceFolderId: "source-folder",
      count: 2,
      label: "2 items",
    });
  });

  it("treats an empty selection as no clipboard at all", () => {
    setClipboard("copy", [FILE], null, "one");
    setClipboard("copy", [], null, "none");
    expect(getClipboard()).toBeNull();
  });

  it("caps entries at the batch limit so a paste cannot exceed one request", () => {
    const many: ClipboardEntry[] = Array.from({ length: MAX_CLIPBOARD_ENTRIES + 10 }, (_, i) => ({
      kind: "file",
      id: `file-${i}`,
      name: `f${i}.txt`,
    }));

    setClipboard("copy", many, null, "many");
    const clip = getClipboard();
    expect(clip?.entries).toHaveLength(MAX_CLIPBOARD_ENTRIES);
    expect(clip?.count).toBe(MAX_CLIPBOARD_ENTRIES);
  });

  it("survives a reload by writing through to storage", () => {
    setClipboard("copy", [FILE], "source-folder", "one");

    const persisted = store.get(STORAGE_KEY);
    expect(persisted).toBeTruthy();

    // A reload: in-memory state is gone, storage is not.
    resetClipboardForTests();
    store.set(STORAGE_KEY, persisted as string);

    expect(getClipboard()).toMatchObject({ mode: "copy", entries: [FILE] });
  });

  it("still works for this tab when storage refuses the write", () => {
    throwOnWrite = true;
    setClipboard("copy", [FILE], null, "one");
    expect(getClipboard()).toMatchObject({ entries: [FILE] });
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});

describe("clearClipboard", () => {
  it("empties memory and storage", () => {
    setClipboard("cut", [FILE], null, "one");
    clearClipboard();

    expect(getClipboard()).toBeNull();
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});

describe("expiry", () => {
  it("forgets a clipboard nobody pasted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T08:00:00Z"));
    setClipboard("copy", [FILE], null, "one");
    expect(getClipboard()).not.toBeNull();

    vi.setSystemTime(new Date("2026-09-01T08:00:00Z").getTime() + CLIPBOARD_TTL_MS + 1);
    expect(getClipboard()).toBeNull();
  });

  it("keeps a clipboard that is still inside its window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T08:00:00Z"));
    setClipboard("copy", [FILE], null, "one");

    vi.setSystemTime(new Date("2026-09-01T08:00:00Z").getTime() + CLIPBOARD_TTL_MS - 1000);
    expect(getClipboard()).not.toBeNull();
  });
});

describe("dropClipboardEntries", () => {
  it("keeps the entries that were not named", () => {
    setClipboard("copy", [FILE, FOLDER], null, "2 items");
    dropClipboardEntries(["file-1"]);

    expect(getClipboard()).toMatchObject({ entries: [FOLDER], count: 1 });
  });

  it("clears the clipboard when nothing is left", () => {
    setClipboard("copy", [FILE], null, "one");
    dropClipboardEntries(["file-1"]);
    expect(getClipboard()).toBeNull();
  });

  it("leaves an unrelated clipboard untouched", () => {
    setClipboard("copy", [FILE], null, "one");
    const before = getClipboard();
    dropClipboardEntries(["someone-else"]);
    expect(getClipboard()).toBe(before);
  });

  it("does nothing when there is no clipboard", () => {
    dropClipboardEntries(["file-1"]);
    expect(getClipboard()).toBeNull();
  });
});

describe("cutIds", () => {
  it("is empty for a copy — a copy leaves the original where it is", () => {
    setClipboard("copy", [FILE], null, "one");
    expect(cutIds(getClipboard()).size).toBe(0);
  });

  it("lists everything a cut would move", () => {
    setClipboard("cut", [FILE, FOLDER], null, "2 items");
    expect([...cutIds(getClipboard())].sort()).toEqual(["file-1", "folder-1"]);
  });

  it("is empty with no clipboard", () => {
    expect(cutIds(null).size).toBe(0);
  });
});

describe("cross-tab sync", () => {
  it("picks up a clipboard written by another tab and notifies subscribers", () => {
    const seen = vi.fn();
    const unsubscribe = subscribeClipboard(seen);

    otherTabWrote({
      mode: "cut",
      entries: [FOLDER],
      sourceFolderId: "other",
      count: 1,
      label: "1 item",
      savedAt: Date.now(),
    });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(getClipboard()).toMatchObject({ mode: "cut", entries: [FOLDER] });
    unsubscribe();
  });

  it("notices another tab clearing the clipboard", () => {
    setClipboard("copy", [FILE], null, "one");
    const seen = vi.fn();
    subscribeClipboard(seen);

    otherTabWrote(null);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(getClipboard()).toBeNull();
  });

  it("ignores a storage event for an unrelated key", () => {
    setClipboard("copy", [FILE], null, "one");
    const seen = vi.fn();
    subscribeClipboard(seen);

    for (const handler of handlers) handler({ key: "some.other.key" });

    expect(seen).not.toHaveBeenCalled();
    expect(getClipboard()).toMatchObject({ entries: [FILE] });
  });

  it("does not re-notify when the other tab wrote the same clipboard", () => {
    setClipboard("copy", [FILE], "source", "one");
    const current = getClipboard();
    const seen = vi.fn();
    subscribeClipboard(seen);

    otherTabWrote(current);

    expect(seen).not.toHaveBeenCalled();
  });
});

describe("parseStoredClipboard", () => {
  const now = Date.UTC(2026, 8, 1, 8, 0, 0);
  const valid = {
    mode: "copy",
    entries: [FILE],
    sourceFolderId: "source",
    count: 1,
    label: "one",
    savedAt: now - 1000,
  };

  it("accepts a well-formed payload", () => {
    expect(parseStoredClipboard(JSON.stringify(valid), now)).toMatchObject({
      mode: "copy",
      entries: [FILE],
      sourceFolderId: "source",
      count: 1,
    });
  });

  it("recomputes count from the entries rather than trusting it", () => {
    const lying = { ...valid, entries: [FILE, FOLDER], count: 99 };
    expect(parseStoredClipboard(JSON.stringify(lying), now)?.count).toBe(2);
  });

  it.each([
    ["nothing stored", null],
    ["not JSON", "{oops"],
    ["not an object", "42"],
    ["null", "null"],
  ])("rejects %s", (_label, raw) => {
    expect(parseStoredClipboard(raw, now)).toBeNull();
  });

  it.each([
    ["an unknown mode", { ...valid, mode: "paste" }],
    ["no entries", { ...valid, entries: [] }],
    ["entries that are not an array", { ...valid, entries: "report.pdf" }],
    ["a non-string label", { ...valid, label: 7 }],
    ["a missing savedAt", { ...valid, savedAt: undefined }],
    ["a non-finite savedAt", { ...valid, savedAt: Number.NaN }],
    ["a numeric sourceFolderId", { ...valid, sourceFolderId: 12 }],
    ["an entry that is not an object", { ...valid, entries: ["file-1"] }],
    ["an unknown entry kind", { ...valid, entries: [{ ...FILE, kind: "link" }] }],
    ["an empty entry id", { ...valid, entries: [{ ...FILE, id: "" }] }],
    ["a non-string entry name", { ...valid, entries: [{ ...FILE, name: null }] }],
  ])("rejects a payload with %s", (_label, payload) => {
    expect(parseStoredClipboard(JSON.stringify(payload), now)).toBeNull();
  });

  it("rejects more entries than a paste request may carry", () => {
    const entries = Array.from({ length: MAX_CLIPBOARD_ENTRIES + 1 }, (_, i) => ({
      kind: "file",
      id: `file-${i}`,
      name: `f${i}.txt`,
    }));
    expect(parseStoredClipboard(JSON.stringify({ ...valid, entries }), now)).toBeNull();
  });

  it("rejects a payload older than the TTL", () => {
    const stale = { ...valid, savedAt: now - CLIPBOARD_TTL_MS - 1 };
    expect(parseStoredClipboard(JSON.stringify(stale), now)).toBeNull();
  });

  it("rejects a payload with no sourceFolderId — every write we make includes one", () => {
    const withoutSource = {
      mode: "copy",
      entries: [FILE],
      count: 1,
      label: "one",
      savedAt: now - 1000,
    };
    expect(parseStoredClipboard(JSON.stringify(withoutSource), now)).toBeNull();
  });
});
