import { describe, expect, it } from "vitest";
import { flattenKeys, hasKey, resolve } from "@/shared/lib/i18n/dictionary";
import { en } from "@/shared/lib/i18n/messages/en";

describe("resolve", () => {
  it("returns the English string for English", () => {
    expect(resolve("en", "common.save")).toBe("Save");
  });

  it("falls back to English key by key, not namespace by namespace", () => {
    expect(resolve("zh-CN", "errors.code.MEMORY_NOT_FOUND")).toBe("未找到记忆");
    expect(resolve("id", "common.somethingWentWrong")).toBe("Terjadi kesalahan");
  });

  it("returns the key itself when nothing matches, never undefined", () => {
    expect(resolve("en", "common.doesNotExist")).toBe("common.doesNotExist");
    expect(resolve("id", "nope.at.all")).toBe("nope.at.all");
  });

  it("does not walk into a non-object node", () => {
    expect(resolve("en", "common.save.deeper")).toBe("common.save.deeper");
  });
});

describe("hasKey", () => {
  it("is true for a real key and false otherwise", () => {
    expect(hasKey("errors.code.INVALID_ID")).toBe(true);
    expect(hasKey("errors.code.NOT_A_CODE")).toBe(false);
    expect(hasKey("errors.code")).toBe(false);
  });
});

describe("flattenKeys", () => {
  it("produces dotted paths and stops at string leaves", () => {
    const keys = flattenKeys(en);
    expect(keys).toContain("common.save");
    expect(keys).toContain("errors.code.INVALID_ID");
    expect(keys).not.toContain("common");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("treats a plural leaf as one key, not two", () => {
    const keys = flattenKeys(en);
    expect(keys).toContain("common.itemCount");
    expect(keys).not.toContain("common.itemCount.one");
  });
});
