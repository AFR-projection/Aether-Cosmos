import { describe, it, expect } from "vitest";
import {
  FOLDER_BATCH_SIZE,
  chunkPaths,
  collectFolderPaths,
  normalizeRelativePath,
  parentPathOf,
  resolveFileFolderIds,
  splitCommonRoot,
  type UploadEntry,
} from "@files/domain/services/folder-tree-upload";

/**
 * Uploading a nested project used to arrive flat: the folder-creation request was
 * rejected for sending too many paths at once, `apiFetch` resolved rather than threw,
 * and every file fell through to a `?? rootId` fallback. The upload reported success
 * and the structure was gone. These tests pin the three behaviours that prevent it:
 * chunking, parents-before-children ordering, and no silent fallback.
 */

/** `File` is a DOM type; the pure functions only ever pass it through. */
const f = (name: string) => ({ name }) as unknown as File;

const entry = (relativePath: string): UploadEntry => ({
  file: f(relativePath.split("/").pop() ?? relativePath),
  relativePath,
});

describe("normalizeRelativePath", () => {
  it("converts Windows separators to forward slashes", () => {
    expect(normalizeRelativePath("src\\lib\\index.ts")).toBe("src/lib/index.ts");
  });

  it("drops leading, trailing and doubled separators", () => {
    expect(normalizeRelativePath("/src//lib/")).toBe("src/lib");
  });

  it("drops no-op current-directory segments", () => {
    expect(normalizeRelativePath("./src/./index.ts")).toBe("src/index.ts");
  });

  it("leaves a bare filename alone", () => {
    expect(normalizeRelativePath("index.ts")).toBe("index.ts");
  });
});

describe("collectFolderPaths", () => {
  it("returns every ancestor directory, not just the deepest", () => {
    expect(collectFolderPaths(["a/b/c/file.ts"])).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("orders parents before children", () => {
    const paths = collectFolderPaths([
      "app/api/folders/route.ts",
      "app/page.tsx",
      "src/shared/infrastructure/db/schema.ts",
    ]);
    for (const path of paths) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent === "") continue;
      expect(paths.indexOf(parent)).toBeLessThan(paths.indexOf(path));
    }
  });

  it("de-duplicates directories shared by many files", () => {
    expect(collectFolderPaths(["src/a.ts", "src/b.ts", "src/c.ts"])).toEqual(["src"]);
  });

  it("returns nothing for files that have no directory", () => {
    expect(collectFolderPaths(["a.ts", "b.ts"])).toEqual([]);
  });

  it("treats a Windows-separated path as nested", () => {
    expect(collectFolderPaths(["src\\lib\\x.ts"])).toEqual(["src", "src/lib"]);
  });
});

describe("chunkPaths", () => {
  it("splits a tree larger than one request into several", () => {
    const paths = Array.from({ length: 1250 }, (_, i) => `dir-${i}`);
    const chunks = chunkPaths(paths);
    expect(chunks.length).toBe(Math.ceil(1250 / FOLDER_BATCH_SIZE));
    expect(chunks.flat()).toEqual(paths);
  });

  it("keeps a small tree in a single request", () => {
    expect(chunkPaths(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("returns nothing for an empty tree", () => {
    expect(chunkPaths([])).toEqual([]);
  });

  it("never emits a chunk the server would reject", () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `d${i}`);
    for (const chunk of chunkPaths(paths)) {
      expect(chunk.length).toBeLessThanOrEqual(FOLDER_BATCH_SIZE);
    }
  });

  it("refuses a nonsensical chunk size instead of looping forever", () => {
    expect(() => chunkPaths(["a"], 0)).toThrow();
  });
});

describe("parentPathOf", () => {
  it("returns the directory of a nested file", () => {
    expect(parentPathOf("a/b/c.ts")).toBe("a/b");
  });

  it("returns empty for a file at the top level", () => {
    expect(parentPathOf("c.ts")).toBe("");
  });
});

describe("resolveFileFolderIds", () => {
  const ids = new Map([
    ["src", "id-src"],
    ["src/lib", "id-src-lib"],
  ]);

  it("puts each file in its own folder", () => {
    const { items, unresolved } = resolveFileFolderIds(
      [entry("src/a.ts"), entry("src/lib/b.ts")],
      ids,
      "id-root"
    );
    expect(unresolved).toEqual([]);
    expect(items.map((i) => i.folderId)).toEqual(["id-src", "id-src-lib"]);
  });

  it("puts a top-level file in the root", () => {
    const { items } = resolveFileFolderIds([entry("readme.md")], ids, "id-root");
    expect(items[0].folderId).toBe("id-root");
  });

  it("reports a missing folder instead of falling back to the root", () => {
    // The regression: `?? rootId` here is what turned a project into a flat pile.
    const { items, unresolved } = resolveFileFolderIds(
      [entry("src/a.ts"), entry("dist/bundle.js")],
      ids,
      "id-root"
    );
    expect(unresolved).toEqual(["dist"]);
    expect(items.map((i) => i.relativePath)).toEqual(["src/a.ts"]);
  });

  it("reports each missing folder once however many files it holds", () => {
    const { unresolved } = resolveFileFolderIds(
      [entry("dist/a.js"), entry("dist/b.js"), entry("dist/c.js")],
      ids,
      "id-root"
    );
    expect(unresolved).toEqual(["dist"]);
  });

  it("normalizes the stored path so Windows separators still resolve", () => {
    const { items, unresolved } = resolveFileFolderIds([entry("src\\lib\\b.ts")], ids, "id-root");
    expect(unresolved).toEqual([]);
    expect(items[0]).toEqual({ file: items[0].file, relativePath: "src/lib/b.ts", folderId: "id-src-lib" });
  });

  it("accepts a null root for an upload at the tree root", () => {
    const { items } = resolveFileFolderIds([entry("readme.md")], ids, null);
    expect(items[0].folderId).toBeNull();
  });
});

describe("splitCommonRoot", () => {
  it("takes the root name from the path instead of inventing one", () => {
    const { rootName, entries } = splitCommonRoot([
      entry("myproject/src/index.ts"),
      entry("myproject/package.json"),
    ]);
    expect(rootName).toBe("myproject");
    expect(entries.map((e) => e.relativePath)).toEqual(["src/index.ts", "package.json"]);
  });

  it("keeps the tree intact when several roots were selected", () => {
    const { rootName, entries } = splitCommonRoot([
      entry("one/a.ts"),
      entry("two/b.ts"),
    ]);
    expect(rootName).toBeNull();
    expect(entries.map((e) => e.relativePath)).toEqual(["one/a.ts", "two/b.ts"]);
  });

  it("reports no root when the browser gave a bare filename", () => {
    const { rootName, entries } = splitCommonRoot([entry("a.ts")]);
    expect(rootName).toBeNull();
    expect(entries.map((e) => e.relativePath)).toEqual(["a.ts"]);
  });

  it("strips only the first segment of a deep path", () => {
    const { rootName, entries } = splitCommonRoot([entry("p/a/b/c/d.ts")]);
    expect(rootName).toBe("p");
    expect(entries[0].relativePath).toBe("a/b/c/d.ts");
  });

  it("normalizes Windows separators before deciding on a root", () => {
    const { rootName, entries } = splitCommonRoot([entry("p\\a\\b.ts"), entry("p\\c.ts")]);
    expect(rootName).toBe("p");
    expect(entries.map((e) => e.relativePath)).toEqual(["a/b.ts", "c.ts"]);
  });

  it("round-trips: stripping the root then collecting paths keeps every level", () => {
    const { entries } = splitCommonRoot([
      entry("proj/app/api/route.ts"),
      entry("proj/lib/db/schema.ts"),
    ]);
    expect(collectFolderPaths(entries.map((e) => e.relativePath))).toEqual([
      "app",
      "lib",
      "app/api",
      "lib/db",
    ]);
  });
});
