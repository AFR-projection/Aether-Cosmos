import { describe, it, expect } from "vitest";
import { LOCALES } from "@/shared/lib/i18n/config";
import {
  SUBTITLE_LANGUAGES,
  UNDETERMINED_LANGUAGE,
  findSubtitleLanguage,
  isSubtitleLanguage,
  normalizeLanguageTag,
  subtitleLanguageLabel,
} from "@files/domain/services/subtitles/languages";

/**
 * The language table is data, and the tests over it are invariants rather than examples: a
 * duplicate tag would put two identical rows in the picker, a missing native name would show a
 * reader a language named in a language they do not read, and a tag the transcription provider
 * hands back that this table cannot place would leave a finished track labelled with a code.
 *
 * {@link normalizeLanguageTag} carries the weight here. Whisper's `verbose_json` reports the
 * detected language as an English *word* (`"japanese"`), a `<track srclang>` needs a BCP-47
 * *tag* (`"ja"`), and a user's browser may offer either spelling of a regional variant. One
 * function reconciles all of that, so nothing downstream has to guess.
 */

describe("SUBTITLE_LANGUAGES", () => {
  it("offers enough languages to be worth calling multilingual", () => {
    expect(SUBTITLE_LANGUAGES.length).toBeGreaterThanOrEqual(90);
  });

  it("names every tag exactly once", () => {
    const tags = SUBTITLE_LANGUAGES.map((language) => language.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("names every language in itself and in English", () => {
    for (const language of SUBTITLE_LANGUAGES) {
      expect(language.native.trim().length).toBeGreaterThan(0);
      expect(language.english.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses tags a `<track srclang>` attribute accepts", () => {
    for (const language of SUBTITLE_LANGUAGES) {
      expect(language.tag).toMatch(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/);
    }
  });

  it("names every English name exactly once, so a name always resolves to one tag", () => {
    const names = SUBTITLE_LANGUAGES.map((language) => language.english.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers every language this app's own interface is offered in", () => {
    for (const locale of LOCALES) {
      expect(findSubtitleLanguage(locale), locale).toBeDefined();
    }
  });

  it("includes the languages the feature was asked for", () => {
    for (const tag of ["ja", "id", "en", "ko", "zh-CN", "zh-TW", "ar", "hi", "es"]) {
      expect(findSubtitleLanguage(tag), tag).toBeDefined();
    }
  });

  it("marks right-to-left scripts, since the overlay has to align them", () => {
    expect(findSubtitleLanguage("ar")?.rtl).toBe(true);
    expect(findSubtitleLanguage("he")?.rtl).toBe(true);
    expect(findSubtitleLanguage("fa")?.rtl).toBe(true);
    expect(findSubtitleLanguage("en")?.rtl).toBeUndefined();
  });

  it("lists the languages in alphabetical order of their English name", () => {
    const names = SUBTITLE_LANGUAGES.map((language) => language.english);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });
});

describe("normalizeLanguageTag", () => {
  it("passes a tag this table already knows straight through", () => {
    expect(normalizeLanguageTag("ja")).toBe("ja");
    expect(normalizeLanguageTag("zh-CN")).toBe("zh-CN");
  });

  it("corrects the case a client sent rather than rejecting it", () => {
    expect(normalizeLanguageTag("JA")).toBe("ja");
    expect(normalizeLanguageTag("zh-cn")).toBe("zh-CN");
    expect(normalizeLanguageTag("PT-br")).toBe("pt-BR");
  });

  it("accepts an underscore where a hyphen belongs", () => {
    expect(normalizeLanguageTag("zh_CN")).toBe("zh-CN");
  });

  it("resolves the English name Whisper reports as the detected language", () => {
    expect(normalizeLanguageTag("japanese")).toBe("ja");
    expect(normalizeLanguageTag("Indonesian")).toBe("id");
    expect(normalizeLanguageTag("chinese (simplified)")).toBe("zh-CN");
  });

  it("falls back to the base language for a region this table does not carry", () => {
    expect(normalizeLanguageTag("en-US")).toBe("en");
    expect(normalizeLanguageTag("de-AT")).toBe("de");
  });

  it("prefers an exact regional match over the base language", () => {
    expect(normalizeLanguageTag("pt-BR")).toBe("pt-BR");
    expect(normalizeLanguageTag("pt-PT")).toBe("pt");
  });

  it("refuses what it cannot place instead of inventing a tag", () => {
    expect(normalizeLanguageTag("")).toBeNull();
    expect(normalizeLanguageTag("   ")).toBeNull();
    expect(normalizeLanguageTag("klingon")).toBeNull();
    expect(normalizeLanguageTag("zz")).toBeNull();
  });
});

describe("isSubtitleLanguage", () => {
  it("accepts a tag exactly as this table spells it", () => {
    expect(isSubtitleLanguage("ja")).toBe(true);
    expect(isSubtitleLanguage("zh-CN")).toBe(true);
  });

  it("rejects a tag that only differs in case, so stored tags stay canonical", () => {
    expect(isSubtitleLanguage("JA")).toBe(false);
  });

  it("rejects anything that is not a string", () => {
    expect(isSubtitleLanguage(undefined)).toBe(false);
    expect(isSubtitleLanguage(42)).toBe(false);
    expect(isSubtitleLanguage(null)).toBe(false);
  });
});

describe("subtitleLanguageLabel", () => {
  it("names a language in itself", () => {
    expect(subtitleLanguageLabel("ja")).toBe("日本語");
    expect(subtitleLanguageLabel("id")).toBe("Indonesia");
  });

  it("shows the tag itself rather than nothing for a language it cannot place", () => {
    expect(subtitleLanguageLabel("zz")).toBe("zz");
  });
});

describe("UNDETERMINED_LANGUAGE", () => {
  it("is never offered in the picker", () => {
    expect(findSubtitleLanguage(UNDETERMINED_LANGUAGE)).toBeUndefined();
    expect(isSubtitleLanguage(UNDETERMINED_LANGUAGE)).toBe(false);
  });

  it("is never what a detection resolves to, so a placeholder cannot overwrite a real answer", () => {
    expect(normalizeLanguageTag(UNDETERMINED_LANGUAGE)).toBeNull();
  });
});
