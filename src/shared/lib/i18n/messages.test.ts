import { describe, expect, it } from "vitest";
import { flattenKeys, resolve } from "@/shared/lib/i18n/dictionary";
import { en } from "@/shared/lib/i18n/messages/en";
import { id } from "@/shared/lib/i18n/messages/id";
import { zhCN } from "@/shared/lib/i18n/messages/zh-CN";

const englishKeys = new Set(flattenKeys(en));

/**
 * Characters whose Simplified form differs. A hit means Traditional text
 * reached zh-CN.ts, which the spec forbids.
 */
const TRADITIONAL =
  "們個這來說時會學對開關實體訊檔網頁設應該選擇檢視編輯儲刪資確認錯誤無請後沒權載顯隱標籤專記憶圖譜語變號碼證郵傳項頻連過現發帳壓縮問係動幀讀筆瀏覽處軌鐘識鏈兩輸員須暫";

describe.each([
  ["id", id],
  ["zh-CN", zhCN],
])("%s dictionary", (_name, dictionary) => {
  it("introduces no key that English does not have", () => {
    const extra = flattenKeys(dictionary).filter((key) => !englishKeys.has(key));
    expect(extra).toEqual([]);
  });

  it("gives every plural leaf an `other` form", () => {
    for (const key of flattenKeys(dictionary)) {
      const value = key.split(".").reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)?.[part],
        dictionary
      );
      if (typeof value === "object" && value !== null) {
        expect(Object.keys(value)).toContain("other");
      }
    }
  });
});

describe("zh-CN script", () => {
  it("uses Simplified characters only", () => {
    const offenders: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === "string") {
        for (const character of node) {
          if (TRADITIONAL.includes(character)) offenders.push(`${character} in "${node}"`);
        }
      } else if (typeof node === "object" && node !== null) {
        Object.values(node).forEach(walk);
      }
    };
    walk(zhCN);
    expect(offenders).toEqual([]);
  });
});

describe("fallback", () => {
  it("serves Indonesian and Chinese where present", () => {
    expect(resolve("id", "common.save")).toBe("Simpan");
    expect(resolve("zh-CN", "common.save")).toBe("保存");
  });

  it("serves English for a key neither locale has yet", () => {
    expect(resolve("id", "errors.code.NOT_SEEDED")).toBe("errors.code.NOT_SEEDED");
    expect(resolve("zh-CN", "common.copied")).toBe("已复制");
  });
});
