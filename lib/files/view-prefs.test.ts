import { describe, it, expect } from "vitest";
import {
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MAX,
  TREE_WIDTH_MIN,
  clampTreeWidth,
  loadTreeOpen,
  loadTreeWidth,
  saveTreeOpen,
  saveTreeWidth,
} from "@/lib/files/view-prefs";

/**
 * The width is dragged by hand and then stored, so it is the one preference a user can
 * put out of range. Clamping happens on the way in AND out; these tests pin both, plus
 * the server case, where every read has to fall back instead of touching localStorage.
 */

describe("clampTreeWidth", () => {
  it("keeps a width inside the usable range", () => {
    expect(clampTreeWidth(TREE_WIDTH_DEFAULT)).toBe(TREE_WIDTH_DEFAULT);
    expect(clampTreeWidth(TREE_WIDTH_MIN)).toBe(TREE_WIDTH_MIN);
    expect(clampTreeWidth(TREE_WIDTH_MAX)).toBe(TREE_WIDTH_MAX);
  });

  it("pulls a pane dragged past either end back to the edge", () => {
    expect(clampTreeWidth(0)).toBe(TREE_WIDTH_MIN);
    expect(clampTreeWidth(-500)).toBe(TREE_WIDTH_MIN);
    expect(clampTreeWidth(4000)).toBe(TREE_WIDTH_MAX);
  });

  it("rounds a fractional drag to whole pixels", () => {
    expect(clampTreeWidth(TREE_WIDTH_DEFAULT + 0.6)).toBe(TREE_WIDTH_DEFAULT + 1);
  });

  it("falls back rather than propagating a NaN width into a style", () => {
    expect(clampTreeWidth(Number.NaN)).toBe(TREE_WIDTH_DEFAULT);
    expect(clampTreeWidth(Number.POSITIVE_INFINITY)).toBe(TREE_WIDTH_DEFAULT);
  });

  it("leaves the pane wide enough to read a folder name and narrow enough to keep the grid", () => {
    expect(TREE_WIDTH_MIN).toBeLessThan(TREE_WIDTH_DEFAULT);
    expect(TREE_WIDTH_DEFAULT).toBeLessThan(TREE_WIDTH_MAX);
  });
});

describe("tree preferences without a window", () => {
  it("reads fall back and writes are no-ops on the server", () => {
    expect(loadTreeWidth()).toBe(TREE_WIDTH_DEFAULT);
    expect(loadTreeWidth(9999)).toBe(TREE_WIDTH_MAX);
    expect(loadTreeOpen()).toBe(true);
    expect(loadTreeOpen(false)).toBe(false);
    expect(() => {
      saveTreeWidth(300);
      saveTreeOpen(false);
    }).not.toThrow();
  });
});
