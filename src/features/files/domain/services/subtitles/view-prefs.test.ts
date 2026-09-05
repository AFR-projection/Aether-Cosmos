import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SUBTITLE_PREFS,
  SUBTITLE_OFFSET_MAX,
  clampSubtitleOffset,
  loadSubtitlePrefs,
  saveSubtitlePrefs,
} from "@files/domain/services/subtitles/view-prefs";

/**
 * What the viewer remembers about subtitles between videos.
 *
 * The stored language is the part that matters: "turn subtitles on and they appear" only feels
 * automatic the second time if the choice survives the file being closed. Everything else here is
 * appearance, which is a preference in the ordinary sense.
 *
 * A stored value is never trusted. These keys are user-writable — a hand-edited localStorage entry
 * reaches the CSS that positions the overlay, and an unusable offset would push the text off the
 * bottom of the picture with no way to get it back except clearing site data.
 */

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  // `environment: "node"`, so there is no window until one is put here.
  (globalThis as { window?: unknown }).window = { localStorage: fakeStorage() };
});

describe("clampSubtitleOffset", () => {
  it("keeps a normal offset", () => {
    expect(clampSubtitleOffset(12)).toBe(12);
  });

  it("pulls an offset outside the picture back inside it", () => {
    expect(clampSubtitleOffset(-10)).toBe(0);
    expect(clampSubtitleOffset(999)).toBe(SUBTITLE_OFFSET_MAX);
  });

  it("falls back rather than letting a NaN reach a style", () => {
    expect(clampSubtitleOffset(Number.NaN)).toBe(DEFAULT_SUBTITLE_PREFS.offset);
    expect(clampSubtitleOffset(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SUBTITLE_PREFS.offset);
  });

  it("rounds a dragged value to whole percent", () => {
    expect(clampSubtitleOffset(8.6)).toBe(9);
  });
});

describe("loadSubtitlePrefs", () => {
  it("returns the defaults when nothing has been stored", () => {
    expect(loadSubtitlePrefs()).toEqual(DEFAULT_SUBTITLE_PREFS);
  });

  it("returns the defaults on the server, where there is no storage at all", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(loadSubtitlePrefs()).toEqual(DEFAULT_SUBTITLE_PREFS);
  });

  it("round-trips everything it stores", () => {
    saveSubtitlePrefs({ size: "xl", backdrop: "solid", offset: 20, language: "id", enabled: true });
    expect(loadSubtitlePrefs()).toEqual({
      size: "xl",
      backdrop: "solid",
      offset: 20,
      language: "id",
      enabled: true,
    });
  });

  it("merges a partial save over what was already there", () => {
    saveSubtitlePrefs({ language: "ja", enabled: true });
    saveSubtitlePrefs({ size: "lg" });
    expect(loadSubtitlePrefs()).toMatchObject({ language: "ja", enabled: true, size: "lg" });
  });

  it("ignores a size or backdrop that is not one of the options", () => {
    window.localStorage.setItem("subtitles:size", "enormous");
    window.localStorage.setItem("subtitles:backdrop", "rainbow");
    expect(loadSubtitlePrefs()).toMatchObject({
      size: DEFAULT_SUBTITLE_PREFS.size,
      backdrop: DEFAULT_SUBTITLE_PREFS.backdrop,
    });
  });

  it("ignores a language tag this app does not know", () => {
    window.localStorage.setItem("subtitles:language", "klingon");
    expect(loadSubtitlePrefs().language).toBeNull();
  });

  it("clamps an offset somebody edited by hand", () => {
    window.localStorage.setItem("subtitles:offset", "9999");
    expect(loadSubtitlePrefs().offset).toBe(SUBTITLE_OFFSET_MAX);
  });

  it("survives storage that throws on every access", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    };
    expect(loadSubtitlePrefs()).toEqual(DEFAULT_SUBTITLE_PREFS);
    expect(() => saveSubtitlePrefs({ size: "lg" })).not.toThrow();
  });

  it("clears the remembered language when subtitles are turned off", () => {
    // Off means off: leaving a language behind would make the next video turn itself on.
    saveSubtitlePrefs({ language: "id", enabled: true });
    saveSubtitlePrefs({ enabled: false });
    expect(loadSubtitlePrefs()).toMatchObject({ enabled: false, language: null });
  });
});
