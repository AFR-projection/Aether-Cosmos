import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, LOCALES, LOCALE_META } from "@/shared/lib/i18n/config";

describe("locale config", () => {
  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("lists exactly the three supported locales", () => {
    expect([...LOCALES]).toEqual(["en", "id", "zh-CN"]);
  });

  it("accepts supported locales", () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
  });

  it("rejects near misses and non-strings", () => {
    for (const value of ["en-US", "zh", "zh-TW", "ID", "", null, undefined, 3, {}]) {
      expect(isLocale(value)).toBe(false);
    }
  });

  it("carries an Intl tag and a native label for every locale", () => {
    for (const locale of LOCALES) {
      expect(LOCALE_META[locale].intlTag.length).toBeGreaterThan(0);
      expect(LOCALE_META[locale].native.length).toBeGreaterThan(0);
      expect(LOCALE_META[locale].short.length).toBeGreaterThan(0);
      expect(LOCALE_META[locale].short.length).toBeLessThanOrEqual(3);
    }
  });
});
