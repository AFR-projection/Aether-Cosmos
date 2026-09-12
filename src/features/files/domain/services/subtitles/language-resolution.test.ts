import { describe, expect, it } from "vitest";
import { resolveWeightedSubtitleLanguage } from "@files/domain/services/subtitles/language-resolution";

describe("resolveWeightedSubtitleLanguage", () => {
  it("weights evidence by audio duration instead of chunk count", () => {
    expect(
      resolveWeightedSubtitleLanguage([
        { language: "id", durationMs: 600_000 },
        { language: "English", durationMs: 60_000 },
        { language: "en-US", durationMs: 60_000 },
      ])
    ).toBe("id");
  });

  it("combines canonical variants and applies confidence", () => {
    expect(
      resolveWeightedSubtitleLanguage([
        { language: "en-US", durationMs: 300_000, confidence: 0.5 },
        { language: "English", durationMs: 300_000, confidence: 0.5 },
        { language: "id", durationMs: 250_000, confidence: 1 },
      ])
    ).toBe("en");
  });

  it("uses first observation as a deterministic tie break", () => {
    const evidence = [
      { language: "ja", durationMs: 100_000 },
      { language: "id", durationMs: 100_000 },
    ];
    expect(resolveWeightedSubtitleLanguage(evidence)).toBe("ja");
    expect(resolveWeightedSubtitleLanguage(evidence)).toBe("ja");
  });

  it("ignores invalid evidence and returns null when none remains", () => {
    expect(
      resolveWeightedSubtitleLanguage([
        { language: "und", durationMs: 100_000 },
        { language: "klingon", durationMs: 100_000 },
        { language: "en", durationMs: 0 },
        { language: "id", durationMs: Number.NaN },
      ])
    ).toBeNull();
  });
});
