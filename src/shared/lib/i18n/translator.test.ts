import { describe, expect, it } from "vitest";
import { apiErrorMessage, createTranslator } from "@/shared/lib/i18n/dictionary";

describe("createTranslator", () => {
  const t = createTranslator("en");

  it("returns plain strings", () => {
    expect(t("common.cancel")).toBe("Cancel");
  });

  it("pluralizes and interpolates in one pass", () => {
    expect(t("common.itemCount", { count: 1 })).toBe("1 item");
    expect(t("common.itemCount", { count: 5 })).toBe("5 items");
  });

  it("uses the single form for Chinese", () => {
    expect(createTranslator("zh-CN")("common.itemCount", { count: 1 })).toBe("1 项");
  });
});

describe("apiErrorMessage", () => {
  const t = createTranslator("en");

  it("prefers a translated code over the server string", () => {
    const message = apiErrorMessage(
      { error: "Memory not found", code: "MEMORY_NOT_FOUND" },
      t,
      "errors.unexpected"
    );
    expect(message).toBe("Memory not found");
  });

  it("shows the server string verbatim when the code has no translation", () => {
    const message = apiErrorMessage(
      { error: "Bucket is on fire", code: "NOT_SEEDED_YET" },
      t,
      "errors.unexpected"
    );
    expect(message).toBe("Bucket is on fire");
  });

  it("shows the server string when there is no code at all", () => {
    expect(apiErrorMessage({ error: "raw text" }, t, "errors.unexpected")).toBe("raw text");
  });

  it("falls back to the caller's key when the response carries nothing", () => {
    expect(apiErrorMessage({}, t, "errors.network")).toBe(
      "Check your connection and try again."
    );
  });

  it("never matches on message text", () => {
    // Same text, no code: it must pass through, not be recognised.
    const message = apiErrorMessage({ error: "Memory not found" }, t, "errors.unexpected");
    expect(message).toBe("Memory not found");
  });

  it("translates a seeded code into the active locale", () => {
    const zh = createTranslator("zh-CN");
    const message = apiErrorMessage(
      { error: "Memory not found", code: "MEMORY_NOT_FOUND" },
      zh,
      "errors.unexpected"
    );
    expect(message).toBe("未找到记忆");
  });
});
