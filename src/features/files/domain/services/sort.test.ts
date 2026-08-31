import { describe, it, expect } from "vitest";
import { sortFiles, getSortValue } from "@files/domain/services/sort";
import type { File as FileRecord } from "@/shared/infrastructure/db/schema";

function mk(partial: Partial<FileRecord>): FileRecord {
  return {
    id: partial.id ?? "id",
    name: partial.name ?? "file",
    sizeBytes: partial.sizeBytes ?? 0,
    mimeType: partial.mimeType ?? "text/plain",
    updatedAt: partial.updatedAt ?? new Date("2020-01-01"),
    // fields not touched by sorting — cast through unknown to satisfy the type
  } as unknown as FileRecord;
}

describe("sortFiles", () => {
  const files = [
    mk({ id: "a", name: "Banana", sizeBytes: 30, updatedAt: new Date("2021-01-01") }),
    mk({ id: "b", name: "apple", sizeBytes: 10, updatedAt: new Date("2023-01-01") }),
    mk({ id: "c", name: "Cherry", sizeBytes: 20, updatedAt: new Date("2022-01-01") }),
  ];

  it("sorts by name case-insensitively ascending", () => {
    const out = sortFiles(files, "name", "asc").map((f) => f.id);
    expect(out).toEqual(["b", "a", "c"]); // apple, Banana, Cherry
  });

  it("sorts by name descending", () => {
    const out = sortFiles(files, "name", "desc").map((f) => f.id);
    expect(out).toEqual(["c", "a", "b"]);
  });

  it("sorts by size numerically", () => {
    expect(sortFiles(files, "size", "asc").map((f) => f.id)).toEqual(["b", "c", "a"]);
    expect(sortFiles(files, "size", "desc").map((f) => f.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts by date (updatedAt)", () => {
    expect(sortFiles(files, "date", "asc").map((f) => f.id)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate the input array", () => {
    const original = [...files];
    sortFiles(files, "name", "asc");
    expect(files).toEqual(original);
  });

  it("getSortValue lowercases names for stable comparison", () => {
    expect(getSortValue(mk({ name: "ABC" }), "name")).toBe("abc");
    expect(getSortValue(mk({ sizeBytes: 42 }), "size")).toBe(42);
  });
});
