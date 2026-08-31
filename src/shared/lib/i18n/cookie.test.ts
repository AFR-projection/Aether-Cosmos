import { describe, expect, it } from "vitest";
import { buildLocaleCookie, readLocaleFromCookieString } from "@/shared/lib/i18n/cookie";

describe("readLocaleFromCookieString", () => {
  it("reads a stored locale", () => {
    expect(readLocaleFromCookieString("locale=id")).toBe("id");
  });

  it("finds the cookie among others, in any position", () => {
    expect(readLocaleFromCookieString("theme=dark; locale=zh-CN; lite_mode=on")).toBe("zh-CN");
    expect(readLocaleFromCookieString("locale=zh-CN; theme=dark")).toBe("zh-CN");
  });

  it("ignores a cookie whose name merely ends with the key", () => {
    expect(readLocaleFromCookieString("my_locale=id; theme=dark")).toBe("en");
  });

  it("tolerates whitespace and URL encoding", () => {
    expect(readLocaleFromCookieString("  locale = zh-CN ")).toBe("zh-CN");
    expect(readLocaleFromCookieString("locale=zh%2DCN")).toBe("zh-CN");
  });

  it("falls back to English for absent, empty, or unknown values", () => {
    for (const raw of [undefined, null, "", "theme=dark", "locale=", "locale=fr", "locale=zh-TW"]) {
      expect(readLocaleFromCookieString(raw)).toBe("en");
    }
  });
});

describe("buildLocaleCookie", () => {
  it("writes a site-wide cookie that lasts a year", () => {
    expect(buildLocaleCookie("id", false)).toBe(
      "locale=id; Path=/; Max-Age=31536000; SameSite=Lax"
    );
  });

  it("adds Secure only when the page is https", () => {
    expect(buildLocaleCookie("zh-CN", true)).toBe(
      "locale=zh-CN; Path=/; Max-Age=31536000; SameSite=Lax; Secure"
    );
  });

  it("never marks the cookie httpOnly, because the client must read it", () => {
    expect(buildLocaleCookie("en", true)).not.toContain("HttpOnly");
  });
});
