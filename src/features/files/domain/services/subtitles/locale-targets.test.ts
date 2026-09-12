import { describe, expect, it } from "vitest";
import { LOCALES } from "@/shared/lib/i18n/config";
import {
  deriveAutomaticSubtitleTargets,
  subtitleLanguagesEquivalent,
  subtitleLocaleSetHash,
} from "@files/domain/services/subtitles/locale-targets";

describe("subtitle locale targets", () => {
  it("derives every automatic target directly from LOCALES", () => {
    expect(deriveAutomaticSubtitleTargets("ja").map((target) => target.language)).toEqual([...LOCALES]);
  });

  it("marks a source-equivalent locale satisfied without dropping it", () => {
    expect(deriveAutomaticSubtitleTargets("en-US")).toEqual([
      { language: "en", satisfiedBySource: true },
      { language: "id", satisfiedBySource: false },
      { language: "zh-CN", satisfiedBySource: false },
    ]);
  });

  it("translates every app locale when source language is undetermined", () => {
    expect(deriveAutomaticSubtitleTargets("und").every((target) => !target.satisfiedBySource)).toBe(true);
  });

  it("deduplicates equivalent future locale variants", () => {
    expect(deriveAutomaticSubtitleTargets("de", ["en", "en-US", "id"]).map((item) => item.language)).toEqual([
      "en",
      "id",
    ]);
  });

  it("compares canonical regional and provider spellings", () => {
    expect(subtitleLanguagesEquivalent("English", "en-US")).toBe(true);
    expect(subtitleLanguagesEquivalent("zh_CN", "Chinese")).toBe(true);
    expect(subtitleLanguagesEquivalent("pt-BR", "pt-PT")).toBe(false);
    expect(subtitleLanguagesEquivalent("und", "und")).toBe(false);
  });

  it("hashes locale sets independent of order and duplicates", () => {
    const hash = subtitleLocaleSetHash(["zh-CN", "en", "id"]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(subtitleLocaleSetHash(["id", "en", "zh_CN", "en-US"]));
    expect(hash).not.toBe(subtitleLocaleSetHash(["en", "id"]));
  });

  it("rejects an app locale that cannot become a subtitle target", () => {
    expect(() => deriveAutomaticSubtitleTargets("en", ["en", "xx-ZZ"])).toThrow(/xx-ZZ/);
    expect(() => subtitleLocaleSetHash(["en", "xx-ZZ"])).toThrow(/app locale/i);
  });
});
