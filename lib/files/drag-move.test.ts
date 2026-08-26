import { describe, it, expect } from "vitest";
import {
  DRAG_ACTIVATION_DISTANCE,
  describeDrag,
  planDragMove,
  readDragSource,
  resolveDropDestination,
  travelledAsDrag,
  type DragSource,
  type PlanDragMoveInput,
} from "@/lib/files/drag-move";
import { TREE_ROOT_DROP_ID } from "@/lib/files/folder-tree";

/**
 * A wrong answer here moves a file somewhere the user did not point at, so every
 * branch is pinned: the no-ops that must never reach the network, the guards, and
 * the selection rule that decides how many rows one gesture carries.
 */

const FILE: DragSource = { kind: "file", id: "file-1", name: "report.pdf" };
const FOLDER: DragSource = { kind: "folder", id: "folder-1", name: "Projects" };

function plan(over: Partial<PlanDragMoveInput> & { overId: string | null | undefined }) {
  return planDragMove({
    source: FILE,
    currentFolderId: null,
    selectedIds: [],
    canEdit: true,
    trash: false,
    ...over,
  });
}

describe("resolveDropDestination", () => {
  it("maps the tree's root row to the account root", () => {
    expect(resolveDropDestination(TREE_ROOT_DROP_ID)).toBeNull();
  });

  it("passes a folder id through unchanged", () => {
    expect(resolveDropDestination("folder-9")).toBe("folder-9");
  });

  it("reports no destination when the drop landed on nothing", () => {
    expect(resolveDropDestination(null)).toBeUndefined();
    expect(resolveDropDestination(undefined)).toBeUndefined();
    expect(resolveDropDestination("")).toBeUndefined();
  });
});

describe("travelledAsDrag", () => {
  it("treats a press that never moved as a click", () => {
    expect(travelledAsDrag({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false);
  });

  it("treats a small wobble as a click", () => {
    expect(travelledAsDrag({ x: 100, y: 100 }, { x: 103, y: 103 })).toBe(false);
  });

  it("treats travel past the sensor's threshold as a drag", () => {
    expect(travelledAsDrag({ x: 100, y: 100 }, { x: 100 + DRAG_ACTIVATION_DISTANCE, y: 100 })).toBe(true);
    expect(travelledAsDrag({ x: 100, y: 100 }, { x: 60, y: 140 })).toBe(true);
  });

  it("measures in any direction", () => {
    expect(travelledAsDrag({ x: 100, y: 100 }, { x: 100, y: 100 - DRAG_ACTIVATION_DISTANCE })).toBe(true);
  });

  it("treats a click with no recorded press as a click", () => {
    // A keyboard-activated link, or a press that started outside the card.
    expect(travelledAsDrag(null, { x: 999, y: 999 })).toBe(false);
    expect(travelledAsDrag(undefined, { x: 999, y: 999 })).toBe(false);
  });
});

describe("readDragSource", () => {
  it("recovers a file drag", () => {
    expect(readDragSource({ id: "file-1", data: { current: { kind: "file", name: "a.txt" } } })).toEqual({
      kind: "file",
      id: "file-1",
      name: "a.txt",
    });
  });

  it("recovers a folder drag", () => {
    expect(readDragSource({ id: "folder-1", data: { current: { kind: "folder", name: "Docs" } } })).toEqual({
      kind: "folder",
      id: "folder-1",
      name: "Docs",
    });
  });

  it("ignores a drag with no payload, so an unrelated draggable can't move a file", () => {
    expect(readDragSource({ id: "file-1", data: {} })).toBeNull();
    expect(readDragSource({ id: "file-1", data: { current: null } })).toBeNull();
  });

  it("ignores an unrecognised kind or a missing name", () => {
    expect(readDragSource({ id: "x", data: { current: { kind: "note", name: "a" } } })).toBeNull();
    expect(readDragSource({ id: "x", data: { current: { kind: "file" } } })).toBeNull();
  });

  it("ignores a non-string id, which is never one of our records", () => {
    expect(readDragSource({ id: 7, data: { current: { kind: "file", name: "a" } } })).toBeNull();
    expect(readDragSource({ id: "", data: { current: { kind: "file", name: "a" } } })).toBeNull();
  });
});

describe("planDragMove — nothing to do", () => {
  it("does nothing when the drop landed outside every target", () => {
    expect(plan({ overId: null })).toEqual({ type: "none" });
  });

  it("does nothing when a file is dropped on the folder already open", () => {
    expect(plan({ overId: "folder-2", currentFolderId: "folder-2" })).toEqual({ type: "none" });
  });

  it("does nothing when a file at the account root is dropped on the root row", () => {
    expect(plan({ overId: TREE_ROOT_DROP_ID, currentFolderId: null })).toEqual({ type: "none" });
  });

  it("does nothing when a folder is dropped on itself", () => {
    expect(plan({ source: FOLDER, overId: FOLDER.id })).toEqual({ type: "none" });
  });

  it("does nothing when a folder is dropped on its own parent", () => {
    expect(plan({ source: FOLDER, overId: "folder-parent", currentFolderId: "folder-parent" })).toEqual({
      type: "none",
    });
  });
});

describe("planDragMove — guards", () => {
  it("refuses to move anything out of the recycle bin", () => {
    const result = plan({ overId: "folder-2", trash: true });
    expect(result.type).toBe("blocked");
    if (result.type === "blocked") expect(result.reason).toMatch(/recycle bin/i);
  });

  it("keeps the recycle-bin guard ahead of the permission check", () => {
    // Trash is browsed with the same capabilities as any listing; the clearer message wins.
    expect(plan({ overId: "folder-2", trash: true, canEdit: false }).type).toBe("blocked");
  });

  it("denies a viewer without edit rights", () => {
    expect(plan({ overId: "folder-2", canEdit: false })).toEqual({ type: "denied" });
  });

  it("checks for a target before anything else, so a stray drop is silent", () => {
    // No toast for letting go over empty space, even in trash or read-only.
    expect(plan({ overId: undefined, trash: true, canEdit: false })).toEqual({ type: "none" });
  });
});

describe("planDragMove — files", () => {
  it("moves the dragged file into the folder under the pointer", () => {
    expect(plan({ overId: "folder-2" })).toEqual({
      type: "files",
      ids: ["file-1"],
      destination: "folder-2",
    });
  });

  it("moves a file out to the account root", () => {
    expect(plan({ overId: TREE_ROOT_DROP_ID, currentFolderId: "folder-2" })).toEqual({
      type: "files",
      ids: ["file-1"],
      destination: null,
    });
  });

  it("carries the whole selection when the dragged row is part of it", () => {
    expect(plan({ overId: "folder-2", selectedIds: ["file-1", "file-2", "file-3"] })).toEqual({
      type: "files",
      ids: ["file-1", "file-2", "file-3"],
      destination: "folder-2",
    });
  });

  it("carries only the dragged row when it is not selected", () => {
    expect(plan({ overId: "folder-2", selectedIds: ["file-7", "file-8"] })).toEqual({
      type: "files",
      ids: ["file-1"],
      destination: "folder-2",
    });
  });

  it("carries only the dragged row when it is the single selected one", () => {
    expect(plan({ overId: "folder-2", selectedIds: ["file-1"] })).toEqual({
      type: "files",
      ids: ["file-1"],
      destination: "folder-2",
    });
  });

  it("copies the selection instead of aliasing it", () => {
    const selectedIds = ["file-1", "file-2"];
    const result = plan({ overId: "folder-2", selectedIds });
    if (result.type !== "files") throw new Error("expected a file move");
    expect(result.ids).not.toBe(selectedIds);
  });
});

describe("planDragMove — folders", () => {
  it("nests a folder inside the folder under the pointer", () => {
    expect(plan({ source: FOLDER, overId: "folder-2" })).toEqual({
      type: "folder",
      id: "folder-1",
      destination: "folder-2",
    });
  });

  it("lifts a nested folder back out to the account root", () => {
    expect(plan({ source: FOLDER, overId: TREE_ROOT_DROP_ID, currentFolderId: "folder-parent" })).toEqual({
      type: "folder",
      id: "folder-1",
      destination: null,
    });
  });

  it("ignores the file selection when a folder is dragged", () => {
    expect(plan({ source: FOLDER, overId: "folder-2", selectedIds: ["file-1", "file-2"] })).toEqual({
      type: "folder",
      id: "folder-1",
      destination: "folder-2",
    });
  });
});

describe("describeDrag", () => {
  it("names a single file", () => {
    expect(describeDrag(FILE, [])).toEqual({ label: "report.pdf", count: 1 });
  });

  it("counts the selection the drop will actually carry", () => {
    expect(describeDrag(FILE, ["file-1", "file-2", "file-3"])).toEqual({ label: "report.pdf", count: 3 });
  });

  it("names the row when it sits outside the selection", () => {
    expect(describeDrag(FILE, ["file-7", "file-8"])).toEqual({ label: "report.pdf", count: 1 });
  });

  it("names a folder even while files are selected", () => {
    expect(describeDrag(FOLDER, ["file-1", "file-2"])).toEqual({ label: "Projects", count: 1 });
  });

  it("agrees with the plan about how many rows move", () => {
    // The overlay and the request must never disagree about the count.
    const selectedIds = ["file-1", "file-2", "file-3"];
    const result = plan({ overId: "folder-2", selectedIds });
    if (result.type !== "files") throw new Error("expected a file move");
    expect(describeDrag(FILE, selectedIds).count).toBe(result.ids.length);
  });
});
