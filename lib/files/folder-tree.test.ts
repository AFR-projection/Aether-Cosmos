import { describe, it, expect } from "vitest";
import {
  EMPTY_EXPANSION,
  MAX_TREE_ROWS,
  ROOT_KEY,
  childrenKey,
  compareFolderNames,
  flattenTree,
  isFolderExpanded,
  openParentIds,
  resolveTreeKey,
  toggleFolderExpansion,
  type ExpansionState,
  type TreeFolder,
  type TreeRow,
} from "@/lib/files/folder-tree";

/**
 * The tree is built from a PARTIAL children map, so most of what is asserted here is
 * the difference between "this folder has no children" and "nobody has asked yet" —
 * getting those two confused is what makes a tree pane show a project as empty.
 */

const folder = (id: string, name: string, parentId: string | null = null): TreeFolder => ({
  id,
  name,
  parentId,
});

/** `flattenTree` with everything open and no ceiling, unless a test says otherwise. */
function rowsOf(
  entries: [string | null, TreeFolder[]][],
  options: { open?: (id: string) => boolean; maxRows?: number; rootId?: string | null } = {}
) {
  const map = new Map<string, readonly TreeFolder[]>(
    entries.map(([parentId, children]) => [childrenKey(parentId), children])
  );
  return flattenTree({
    root: { id: options.rootId ?? null, name: "My Files" },
    childrenByParent: map,
    isExpanded: options.open ?? (() => true),
    maxRows: options.maxRows,
  });
}

describe("childrenKey", () => {
  it("keys the root by a sentinel a uuid cannot collide with", () => {
    expect(childrenKey(null)).toBe(ROOT_KEY);
    expect(childrenKey("abc")).toBe("abc");
  });
});

describe("compareFolderNames", () => {
  it("orders numbered folders the way a file explorer does", () => {
    const sorted = [folder("1", "part10"), folder("2", "part2")].sort(compareFolderNames);
    expect(sorted.map((f) => f.name)).toEqual(["part2", "part10"]);
  });

  it("ignores case, so a lowercase folder is not exiled to the end", () => {
    const sorted = [folder("1", "zebra"), folder("2", "Apple")].sort(compareFolderNames);
    expect(sorted.map((f) => f.name)).toEqual(["Apple", "zebra"]);
  });

  it("breaks ties on id so same-named folders keep a fixed order", () => {
    const a = folder("aaa", "src");
    const b = folder("bbb", "src");
    expect(compareFolderNames(a, b)).toBeLessThan(0);
    expect(compareFolderNames(b, a)).toBeGreaterThan(0);
    expect(compareFolderNames(a, a)).toBe(0);
  });
});

describe("isFolderExpanded", () => {
  const ancestors = new Set(["ancestor"]);

  it("opens the path to the folder being viewed without being asked", () => {
    expect(isFolderExpanded(EMPTY_EXPANSION, "ancestor", ancestors)).toBe(true);
    expect(isFolderExpanded(EMPTY_EXPANSION, "elsewhere", ancestors)).toBe(false);
  });

  it("lets a deliberate close beat the automatic open", () => {
    const state: ExpansionState = { expanded: new Set(), collapsed: new Set(["ancestor"]) };
    expect(isFolderExpanded(state, "ancestor", ancestors)).toBe(false);
  });

  it("opens a folder the user asked for anywhere in the tree", () => {
    const state: ExpansionState = { expanded: new Set(["elsewhere"]), collapsed: new Set() };
    expect(isFolderExpanded(state, "elsewhere", ancestors)).toBe(true);
  });
});

describe("toggleFolderExpansion", () => {
  it("closing an ancestor sticks instead of springing back open", () => {
    const ancestors = new Set(["a"]);
    const closed = toggleFolderExpansion(EMPTY_EXPANSION, "a", true);
    expect(isFolderExpanded(closed, "a", ancestors)).toBe(false);

    // ...and re-opening it has to beat the close.
    const reopened = toggleFolderExpansion(closed, "a", false);
    expect(isFolderExpanded(reopened, "a", ancestors)).toBe(true);
    expect(reopened.collapsed.has("a")).toBe(false);
  });

  it("leaves the state it was given untouched", () => {
    const state: ExpansionState = { expanded: new Set(["a"]), collapsed: new Set() };
    const next = toggleFolderExpansion(state, "a", true);
    expect(state.expanded.has("a")).toBe(true);
    expect(next.expanded.has("a")).toBe(false);
    expect(next.collapsed.has("a")).toBe(true);
  });
});

/** A project-shaped tree: one loaded branch, one known-empty folder, one unfetched. */
const PROJECT: [string | null, TreeFolder[]][] = [
  [null, [folder("s", "src"), folder("a", "Apps"), folder("d", "docs")]],
  ["a", [folder("a10", "part10", "a"), folder("a2", "part2", "a")]],
  ["d", []],
];

describe("flattenTree", () => {
  it("walks depth-first in explorer order", () => {
    const { rows, truncated } = rowsOf(PROJECT);
    expect(rows.map((r) => r.name)).toEqual(["Apps", "part2", "part10", "docs", "src"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0, 0]);
    expect(truncated).toBe(false);
  });

  it("numbers each row within its own sibling set", () => {
    const { rows } = rowsOf(PROJECT);
    const positions = rows.map((r) => `${r.name} ${r.posInSet}/${r.setSize}`);
    expect(positions).toEqual([
      "Apps 1/3",
      "part2 1/2",
      "part10 2/2",
      "docs 2/3",
      "src 3/3",
    ]);
  });

  it("separates 'has nothing' from 'nobody asked yet'", () => {
    const byName = new Map(rowsOf(PROJECT).rows.map((r) => [r.name, r]));
    expect(byName.get("Apps")?.hasChildren).toBe(true);
    expect(byName.get("docs")?.hasChildren).toBe(false);
    expect(byName.get("src")?.hasChildren).toBe(null);
    expect(byName.get("part2")?.hasChildren).toBe(null);
  });

  it("draws a folder that turned out to be empty as closed", () => {
    const byName = new Map(rowsOf(PROJECT).rows.map((r) => [r.name, r]));
    expect(byName.get("docs")?.expanded).toBe(false);
    // Unfetched is not empty: it stays open so the pane can show it is loading.
    expect(byName.get("src")?.expanded).toBe(true);
  });

  it("hides the subtree under a closed folder", () => {
    const { rows } = rowsOf(PROJECT, { open: (id) => id !== "a" });
    expect(rows.map((r) => r.name)).toEqual(["Apps", "docs", "src"]);
    // Closed, but still known to have something inside — the chevron stays live.
    expect(rows[0].expanded).toBe(false);
    expect(rows[0].hasChildren).toBe(true);
  });

  it("roots the tree at a shared folder when asked", () => {
    const { rows } = rowsOf(PROJECT, { rootId: "a" });
    expect(rows.map((r) => r.name)).toEqual(["part2", "part10"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it("returns nothing when the root's children have not arrived", () => {
    const { rows, truncated } = rowsOf([["a", [folder("a2", "part2", "a")]]]);
    expect(rows).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("survives a parent_id cycle instead of walking forever", () => {
    const { rows } = rowsOf([
      [null, [folder("x", "x")]],
      ["x", [folder("y", "y", "x")]],
      ["y", [folder("x", "x", "y")]],
    ]);
    expect(rows.map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("draws a folder reported under two parents once", () => {
    const { rows } = rowsOf([
      [null, [folder("p", "A"), folder("q", "B")]],
      ["p", [folder("dup", "Shared", "p")]],
      ["q", [folder("dup", "Shared", "q")]],
    ]);
    expect(rows.map((r) => r.name)).toEqual(["A", "Shared", "B"]);
  });

  it("stops at the row ceiling and says so", () => {
    const { rows, truncated } = rowsOf(PROJECT, { maxRows: 2 });
    expect(rows.map((r) => r.name)).toEqual(["Apps", "part2"]);
    expect(truncated).toBe(true);
  });

  it("defaults to a ceiling that a real project stays under", () => {
    expect(MAX_TREE_ROWS).toBeGreaterThan(500);
  });
});

describe("openParentIds", () => {
  const ask = (state: ExpansionState, ancestors: string[], max?: number, rootId: string | null = null) =>
    openParentIds({ root: { id: rootId, name: "My Files" }, state, ancestors: new Set(ancestors), max });

  it("always asks for the root's children first", () => {
    expect(ask(EMPTY_EXPANSION, [])).toEqual([null]);
    expect(ask(EMPTY_EXPANSION, [], undefined, "share")).toEqual(["share"]);
  });

  it("puts the path to the current folder ahead of folders opened by hand", () => {
    const state: ExpansionState = { expanded: new Set(["hand"]), collapsed: new Set() };
    expect(ask(state, ["top", "mid"])).toEqual([null, "top", "mid", "hand"]);
  });

  it("skips a folder the user closed", () => {
    const state: ExpansionState = { expanded: new Set(["a"]), collapsed: new Set(["a", "top"]) };
    expect(ask(state, ["top"])).toEqual([null]);
  });

  it("asks once for a folder that is both an ancestor and hand-opened", () => {
    const state: ExpansionState = { expanded: new Set(["top"]), collapsed: new Set() };
    expect(ask(state, ["top"])).toEqual([null, "top"]);
  });

  it("does not ask twice when the share root is also an ancestor", () => {
    expect(ask(EMPTY_EXPANSION, ["share"], undefined, "share")).toEqual(["share"]);
  });

  it("spends the request budget on the ancestors and stops", () => {
    const state: ExpansionState = { expanded: new Set(["hand"]), collapsed: new Set() };
    expect(ask(state, ["top", "mid"], 2)).toEqual([null, "top"]);
  });
});

/** Rows: Apps(a) ▾ [part2(a2), part10(a10)], docs(d) ▸ empty, src(s) ▾ unfetched. */
const KEY_ROWS: readonly TreeRow[] = rowsOf(PROJECT).rows;

describe("resolveTreeKey", () => {
  const key = (k: string, focused: string, rows: readonly TreeRow[] = KEY_ROWS) =>
    resolveTreeKey(k, focused, rows);

  it("moves down from the root row into the tree", () => {
    expect(key("ArrowDown", ROOT_KEY)).toEqual({ type: "focus", id: "a" });
  });

  it("moves down through the flattened rows, not just the siblings", () => {
    expect(key("ArrowDown", "a")).toEqual({ type: "focus", id: "a2" });
    expect(key("ArrowDown", "a10")).toEqual({ type: "focus", id: "d" });
  });

  it("stops at the last row", () => {
    expect(key("ArrowDown", "s")).toEqual({ type: "none" });
  });

  it("moves up, landing on the root row above the first folder", () => {
    expect(key("ArrowUp", "a2")).toEqual({ type: "focus", id: "a" });
    expect(key("ArrowUp", "a")).toEqual({ type: "focus", id: ROOT_KEY });
    expect(key("ArrowUp", ROOT_KEY)).toEqual({ type: "none" });
  });

  it("steps right into the tree from the root row", () => {
    expect(key("ArrowRight", ROOT_KEY)).toEqual({ type: "focus", id: "a" });
    expect(key("ArrowRight", ROOT_KEY, [])).toEqual({ type: "none" });
  });

  it("right on an open folder walks into its first child", () => {
    expect(key("ArrowRight", "a")).toEqual({ type: "focus", id: "a2" });
  });

  it("right on an open folder with no child below it does nothing", () => {
    // `a10` is open but unfetched; the next row is a sibling of its parent.
    expect(key("ArrowRight", "a10")).toEqual({ type: "none" });
  });

  it("right on a folder known to be empty does not offer to open it", () => {
    expect(key("ArrowRight", "d")).toEqual({ type: "none" });
  });

  it("right on a closed folder opens it, including when its contents are unknown", () => {
    const closed = rowsOf(PROJECT, { open: (id) => id !== "a" }).rows;
    expect(resolveTreeKey("ArrowRight", "a", closed)).toEqual({ type: "expand", id: "a" });
    const unknown = rowsOf(PROJECT, { open: () => false }).rows;
    expect(resolveTreeKey("ArrowRight", "s", unknown)).toEqual({ type: "expand", id: "s" });
  });

  it("left closes an open folder before it moves anywhere", () => {
    expect(key("ArrowLeft", "a")).toEqual({ type: "collapse", id: "a" });
  });

  it("left on a closed child climbs to its parent row", () => {
    const closed = rowsOf(PROJECT, { open: (id) => id === "a" }).rows;
    expect(resolveTreeKey("ArrowLeft", "a2", closed)).toEqual({ type: "focus", id: "a" });
  });

  it("left on a top-level folder climbs to the root row", () => {
    expect(key("ArrowLeft", "d")).toEqual({ type: "focus", id: ROOT_KEY });
    expect(key("ArrowLeft", ROOT_KEY)).toEqual({ type: "none" });
  });

  it("jumps to the ends of the tree", () => {
    expect(key("Home", "a10")).toEqual({ type: "focus", id: ROOT_KEY });
    expect(key("End", "a")).toEqual({ type: "focus", id: "s" });
    expect(key("End", ROOT_KEY, [])).toEqual({ type: "focus", id: ROOT_KEY });
  });

  it("opens the focused folder on Enter or Space, root row included", () => {
    expect(key("Enter", "a2")).toEqual({ type: "open", id: "a2" });
    expect(key(" ", ROOT_KEY)).toEqual({ type: "open", id: ROOT_KEY });
  });

  it("ignores keys it does not own, so typing is left to the browser", () => {
    expect(key("Tab", "a")).toEqual({ type: "none" });
    expect(key("x", "a")).toEqual({ type: "none" });
  });

  it("ignores a key aimed at a row that is no longer drawn", () => {
    // The folder was deleted, renamed away, or collapsed out from under the focus.
    expect(key("ArrowDown", "gone")).toEqual({ type: "none" });
    expect(key("Enter", "gone")).toEqual({ type: "none" });
  });
});
