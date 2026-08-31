import { describe, it, expect, vi } from "vitest";
import {
  DRAFT_PREFIX,
  MAX_DRAFT_BYTES,
  clearDraft,
  docsEqual,
  draftKey,
  isDirty,
  isSaveShortcut,
  readDraft,
  serializeDoc,
  shouldOfferDraft,
  writeDraft,
  type DraftStorage,
} from "./note-draft";

/**
 * These helpers are the safety net that replaced autosave, so the tests are written around
 * the two ways the old editor lost a note: a pending write cancelled on close, and an empty
 * document overwriting the stored one after a failed load.
 */

/** In-memory stand-in for `localStorage`, with hooks to simulate a hostile store. */
function fakeStorage(opts: { failWrites?: boolean; failReads?: boolean } = {}) {
  const map = new Map<string, string>();
  const store: DraftStorage & { map: Map<string, string> } = {
    map,
    getItem: (k: string) => {
      if (opts.failReads) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.failWrites) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  return store;
}

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("draftKey", () => {
  it("namespaces per file so two open notes never share a draft", () => {
    expect(draftKey("abc")).toBe(`${DRAFT_PREFIX}abc`);
    expect(draftKey("abc")).not.toBe(draftKey("abd"));
  });
});

describe("serializeDoc / docsEqual", () => {
  it("treats structurally identical documents as equal", () => {
    expect(docsEqual(doc("hello"), doc("hello"))).toBe(true);
  });

  it("detects a one-character edit", () => {
    expect(docsEqual(doc("hello"), doc("hellos"))).toBe(false);
  });

  it("treats null and undefined as the same empty document", () => {
    expect(docsEqual(null, undefined)).toBe(true);
  });

  it("never reports two unserializable documents as equal", () => {
    // A circular document would throw inside JSON.stringify. Reporting "no changes" there
    // would silently discard the author's work, so the comparison must fail loudly instead.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeDoc(circular)).toContain("unserializable");
    expect(docsEqual(circular, circular)).toBe(false);
  });
});

describe("isDirty", () => {
  it("is false right after a save, when the snapshot matches", () => {
    const snapshot = serializeDoc(doc("saved"));
    expect(isDirty(doc("saved"), snapshot)).toBe(false);
  });

  it("is true once the document moves away from the snapshot", () => {
    const snapshot = serializeDoc(doc("saved"));
    expect(isDirty(doc("saved and edited"), snapshot)).toBe(true);
  });

  it("is true when the snapshot is empty, i.e. nothing has been saved yet", () => {
    expect(isDirty(doc("first words"), "")).toBe(true);
  });
});

describe("isSaveShortcut", () => {
  it("accepts Ctrl+S and Cmd+S", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSaveShortcut({ key: "s", ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("accepts a capital S, which is what the browser reports with Caps Lock on", () => {
    expect(isSaveShortcut({ key: "S", ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("ignores a bare s so typing never triggers a save", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: false, metaKey: false })).toBe(false);
  });

  it("ignores other modified keys", () => {
    expect(isSaveShortcut({ key: "b", ctrlKey: true, metaKey: false })).toBe(false);
  });

  it("leaves Alt+S alone", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });
});

describe("writeDraft / readDraft round trip", () => {
  it("returns exactly what was stored, with its timestamp", () => {
    const storage = fakeStorage();
    expect(writeDraft(storage, "f1", doc("draft body"), 1_700_000_000_000)).toBe(true);
    expect(readDraft(storage, "f1")).toEqual({
      json: doc("draft body"),
      savedAt: 1_700_000_000_000,
    });
  });

  it("keeps drafts of different files apart", () => {
    const storage = fakeStorage();
    writeDraft(storage, "f1", doc("one"), 1);
    writeDraft(storage, "f2", doc("two"), 2);
    expect(readDraft(storage, "f1")?.json).toEqual(doc("one"));
    expect(readDraft(storage, "f2")?.json).toEqual(doc("two"));
  });

  it("returns null when there is no draft", () => {
    expect(readDraft(fakeStorage(), "nope")).toBeNull();
  });

  it("reports failure instead of throwing when storage refuses the write", () => {
    // Private-browsing / quota errors must not take the editor down mid-keystroke.
    expect(writeDraft(fakeStorage({ failWrites: true }), "f1", doc("x"))).toBe(false);
  });

  it("skips drafts larger than the cap rather than risking a quota error", () => {
    const storage = fakeStorage();
    const huge = doc("x".repeat(MAX_DRAFT_BYTES + 100));
    expect(writeDraft(storage, "f1", huge)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it("survives a storage that throws on read", () => {
    expect(readDraft(fakeStorage({ failReads: true }), "f1")).toBeNull();
  });

  it("stamps the current time when no clock is injected", () => {
    const storage = fakeStorage();
    const before = Date.now();
    writeDraft(storage, "f1", doc("now"));
    const savedAt = readDraft(storage, "f1")?.savedAt ?? 0;
    expect(savedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("readDraft with damaged storage entries", () => {
  const cases: Array<[string, string]> = [
    ["not JSON at all", "{{{"],
    ["a JSON string", '"just a string"'],
    ["null", "null"],
    ["an object with no json field", '{"savedAt":123}'],
    ["a non-numeric timestamp", '{"json":{},"savedAt":"yesterday"}'],
    ["a NaN timestamp", '{"json":{},"savedAt":null}'],
  ];

  it.each(cases)("ignores %s instead of offering it as recoverable work", (_label, raw) => {
    const storage = fakeStorage();
    storage.setItem(draftKey("f1"), raw);
    expect(readDraft(storage, "f1")).toBeNull();
  });

  it("accepts a draft whose body is legitimately null", () => {
    const storage = fakeStorage();
    storage.setItem(draftKey("f1"), '{"json":null,"savedAt":5}');
    expect(readDraft(storage, "f1")).toEqual({ json: null, savedAt: 5 });
  });
});

describe("clearDraft", () => {
  it("removes the draft after a successful save", () => {
    const storage = fakeStorage();
    writeDraft(storage, "f1", doc("x"), 1);
    clearDraft(storage, "f1");
    expect(readDraft(storage, "f1")).toBeNull();
  });

  it("leaves other files' drafts in place", () => {
    const storage = fakeStorage();
    writeDraft(storage, "f1", doc("one"), 1);
    writeDraft(storage, "f2", doc("two"), 2);
    clearDraft(storage, "f1");
    expect(readDraft(storage, "f2")).not.toBeNull();
  });

  it("does not throw when storage removal fails", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => clearDraft(storage, "f1")).not.toThrow();
  });
});

describe("shouldOfferDraft", () => {
  it("offers a draft that is ahead of the server copy", () => {
    const draft = { json: doc("newer local text"), savedAt: 10 };
    expect(shouldOfferDraft(draft, doc("older server text"))).toBe(true);
  });

  it("stays quiet when the draft matches what the server already has", () => {
    const draft = { json: doc("same"), savedAt: 10 };
    expect(shouldOfferDraft(draft, doc("same"))).toBe(false);
  });

  it("stays quiet when there is no draft", () => {
    expect(shouldOfferDraft(null, doc("anything"))).toBe(false);
  });

  it("offers a draft when the server returned nothing — the failed-load case", () => {
    // This is the scenario that used to destroy the note: an empty editor plus autosave. Now
    // the local copy is surfaced instead of being overwritten.
    const draft = { json: doc("work in progress"), savedAt: 10 };
    expect(shouldOfferDraft(draft, null)).toBe(true);
  });

  it("stays quiet for an empty draft against an empty server document", () => {
    expect(shouldOfferDraft({ json: null, savedAt: 10 }, undefined)).toBe(false);
  });
});

describe("the data-loss scenarios that motivated the rewrite", () => {
  it("keeps the typed text recoverable when the editor closes before any save", () => {
    // Old behaviour: the pending debounced write was cancelled on unmount and the text was
    // gone. Now the draft is already on disk the moment it is typed.
    const storage = fakeStorage();
    writeDraft(storage, "f1", doc("typed then closed immediately"), 1);
    // …editor unmounts here, no server call at all…
    const recovered = readDraft(storage, "f1");
    expect(recovered?.json).toEqual(doc("typed then closed immediately"));
    expect(shouldOfferDraft(recovered, doc("older server text"))).toBe(true);
  });

  it("clears the draft only after the save the author asked for", () => {
    const storage = fakeStorage();
    const saved = doc("final text");
    writeDraft(storage, "f1", saved, 1);
    const save = vi.fn(() => true);
    if (save()) clearDraft(storage, "f1");
    expect(save).toHaveBeenCalledOnce();
    expect(readDraft(storage, "f1")).toBeNull();
    expect(isDirty(saved, serializeDoc(saved))).toBe(false);
  });
});
