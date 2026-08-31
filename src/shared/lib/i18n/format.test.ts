import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatNumber,
  interpolate,
  pluralCategory,
  selectPlural,
} from "@/shared/lib/i18n/format";

describe("interpolate", () => {
  it("substitutes named placeholders", () => {
    expect(interpolate("Delete {name}?", { name: "notes.txt" })).toBe("Delete notes.txt?");
  });

  it("substitutes every occurrence", () => {
    expect(interpolate("{a} then {a}", { a: "x" })).toBe("x then x");
  });

  it("keeps zero and the empty string rather than treating them as absent", () => {
    expect(interpolate("{n} items", { n: 0 })).toBe("0 items");
    expect(interpolate("[{s}]", { s: "" })).toBe("[]");
  });

  it("leaves an unknown placeholder visible so the gap is obvious", () => {
    expect(interpolate("Hi {who}", { name: "x" })).toBe("Hi {who}");
  });

  it("returns the template untouched when there are no params", () => {
    expect(interpolate("plain text")).toBe("plain text");
  });

  it("does not re-scan substituted text", () => {
    expect(interpolate("{a}", { a: "{a}" })).toBe("{a}");
  });
});

describe("pluralCategory", () => {
  it("distinguishes one from other in English", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 0)).toBe("other");
    expect(pluralCategory("en", 2)).toBe("other");
  });

  it("uses a single form for Indonesian and Chinese", () => {
    for (const count of [0, 1, 2, 99]) {
      expect(pluralCategory("id", count)).toBe("other");
      expect(pluralCategory("zh-CN", count)).toBe("other");
    }
  });
});

describe("selectPlural", () => {
  const forms = { one: "1 file", other: "{count} files" };

  it("picks the English singular", () => {
    expect(selectPlural("en", forms, 1)).toBe("1 file");
    expect(selectPlural("en", forms, 3)).toBe("{count} files");
  });

  it("always picks other for single-form locales", () => {
    expect(selectPlural("id", forms, 1)).toBe("{count} files");
  });

  it("falls back to other when the category is missing", () => {
    expect(selectPlural("en", { other: "{count} files" }, 1)).toBe("{count} files");
  });

  it("returns undefined when there is no usable form", () => {
    expect(selectPlural("en", { one: "1 file" }, 5)).toBeUndefined();
  });
});

describe("formatNumber and formatBytes", () => {
  it("uses the locale separator", () => {
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatNumber("id", 1234.5)).toBe("1.234,5");
  });

  it("formats byte sizes with the locale decimal mark", () => {
    expect(formatBytes("en", 0)).toBe("0 B");
    expect(formatBytes("en", 1023)).toBe("1,023 B");
    expect(formatBytes("en", 1024)).toBe("1 KB");
    expect(formatBytes("en", 1_610_612_736)).toBe("1.5 GB");
    expect(formatBytes("id", 1_610_612_736)).toBe("1,5 GB");
  });

  it("does not produce NaN for a bad input", () => {
    expect(formatBytes("en", Number.NaN)).toBe("0 B");
    expect(formatBytes("en", -1)).toBe("0 B");
  });
});
