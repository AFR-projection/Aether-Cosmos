import { describe, it, expect } from "vitest";
import { LOCALES } from "@/shared/lib/i18n/config";
import { SUBTITLE_LANGUAGES } from "@files/domain/services/subtitles/languages";
import {
  SUGGESTED_SUBTITLE_LANGUAGES,
  suggestedSubtitleLanguages,
} from "@files/domain/services/subtitles/suggested-languages";

/**
 * Which languages the CC menu offers without being asked.
 *
 * The full table is 103 entries, and a menu that opens onto 103 entries is a menu nobody reads —
 * which is exactly the complaint that produced this file. Every video player people already know
 * shows a short list and hides the rest behind one more step, so the first press lands on the
 * language they wanted.
 *
 * The reader's own interface language always comes first. Somebody using the app in Indonesian is
 * overwhelmingly likely to want Indonesian subtitles, and making them scroll for it is the whole
 * problem restated.
 */

describe("suggestedSubtitleLanguages", () => {
  it("puts the reader's own interface language first", () => {
    expect(suggestedSubtitleLanguages("id", new Set())[0]).toBe("id");
    expect(suggestedSubtitleLanguages("en", new Set())[0]).toBe("en");
    expect(suggestedSubtitleLanguages("zh-CN", new Set())[0]).toBe("zh-CN");
  });

  it("offers a list short enough to read at a glance", () => {
    const list = suggestedSubtitleLanguages("id", new Set());
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.length).toBeLessThanOrEqual(9);
  });

  it("names every language exactly once, however the locale reorders them", () => {
    for (const locale of LOCALES) {
      const list = suggestedSubtitleLanguages(locale, new Set());
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("leaves out a language the file already has, so nothing is offered twice", () => {
    const list = suggestedSubtitleLanguages("id", new Set(["id", "ja"]));
    expect(list).not.toContain("id");
    expect(list).not.toContain("ja");
  });

  it("still fills the list up when the obvious choices are taken", () => {
    // Dropping three entries must not leave a three-item menu: the shortlist is longer than what
    // it shows, precisely so it can backfill.
    const full = suggestedSubtitleLanguages("id", new Set());
    const trimmed = suggestedSubtitleLanguages("id", new Set(["id", "en", "zh-CN"]));
    expect(trimmed.length).toBe(full.length);
  });

  it("only ever names tags the language table actually carries", () => {
    // A suggested tag that is not in SUBTITLE_LANGUAGES would render as a bare code and fail the
    // route's validation on click.
    const known = new Set(SUBTITLE_LANGUAGES.map((language) => language.tag));
    for (const tag of SUGGESTED_SUBTITLE_LANGUAGES) {
      expect(known.has(tag), tag).toBe(true);
    }
  });

  it("returns something usable for a locale that is not in the shortlist at all", () => {
    const list = suggestedSubtitleLanguages("sw", new Set());
    expect(list[0]).toBe("sw");
    expect(list.length).toBeGreaterThan(1);
  });

  it("survives a locale this app does not know", () => {
    const list = suggestedSubtitleLanguages("klingon", new Set());
    expect(list.length).toBeGreaterThan(1);
    expect(list).not.toContain("klingon");
  });
});
