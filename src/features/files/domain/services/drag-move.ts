/**
 * What a drag-and-drop gesture in `/files` actually means.
 *
 * Every rule that decides whether a drop moves something — and what — lives here,
 * away from dnd-kit and away from the DOM, because these are the rules that can
 * silently lose a file. The component layer supplies the ids and performs the
 * request; it makes no decisions of its own.
 *
 * The server is still the authority: `/api/folders` refuses a folder moved inside
 * its own subtree, and `resolveWritableDestination` refuses a move across sharing
 * domains. What is checked here is only what the browser can know for certain, so
 * an obvious no-op never costs a round trip.
 */

import { TREE_ROOT_DROP_ID } from "./folder-tree";

export type DragKind = "file" | "folder";

/**
 * How far the pointer must travel before a press counts as a drag.
 *
 * Shared with `travelledAsDrag` on purpose. The sensor's threshold and the guard that
 * cancels the click at the end of a drag have to be the same number: a lower guard
 * swallows real clicks, a higher one lets a completed drag also open what it dragged.
 */
export const DRAG_ACTIVATION_DISTANCE = 6;

export type PressPoint = { x: number; y: number };

/**
 * Whether a press that ended here was a drag rather than a click.
 *
 * Needed only where the click has a default action the browser performs on its own —
 * a folder card is an `<a href>`, and dnd-kit's click blocker stops propagation, which
 * never stops navigation. Rows that open through an `onClick` handler need no guard.
 */
export function travelledAsDrag(from: PressPoint | null | undefined, to: PressPoint): boolean {
  if (!from) return false;
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_ACTIVATION_DISTANCE;
}

/** The thing under the pointer when the drag started. */
export type DragSource = {
  kind: DragKind;
  id: string;
  /** Shown in the drag overlay, and in the activity line after the move. */
  name: string;
};

/**
 * Where a drop resolves to.
 *
 * `null` is the account root — "out of every folder" — which is what the tree's
 * root row means at the top of the owner's own tree. Inside a shared folder that
 * row carries the shared folder's own id instead, so this never produces a `null`
 * destination for borrowed content.
 */
export type DropDestination = string | null;

export function resolveDropDestination(overId: string | null | undefined): DropDestination | undefined {
  if (overId === null || overId === undefined || overId === "") return undefined;
  return overId === TREE_ROOT_DROP_ID ? null : overId;
}

/**
 * What a draggable node hands to dnd-kit, minus the id dnd-kit already carries.
 *
 * Kept to primitives on purpose: the whole record ends up in a ref inside dnd-kit and
 * would go stale, and a `memo`-wrapped row must not receive a fresh object per render.
 */
export type DragData = { kind: DragKind; name: string };

/**
 * The dragged thing, recovered from a drag event.
 *
 * Validated rather than cast: `data.current` is whatever some component attached, and a
 * drop that acted on a malformed payload would move the wrong row. Anything unrecognised
 * resolves to `null`, which the caller treats as "not ours — ignore this drag".
 */
export function readDragSource(active: {
  id: string | number;
  data: { current?: unknown };
}): DragSource | null {
  if (typeof active.id !== "string" || active.id === "") return null;
  const data = active.data.current;
  if (typeof data !== "object" || data === null) return null;
  const { kind, name } = data as { kind?: unknown; name?: unknown };
  if (kind !== "file" && kind !== "folder") return null;
  if (typeof name !== "string") return null;
  return { kind, id: active.id, name };
}

export type MovePlan =
  /** Nothing to do: no target, the folder already being browsed, or itself. */
  | { type: "none" }
  /** The viewer may not write here. The caller owns the wording. */
  | { type: "denied" }
  /**
   * Structurally impossible. A stable code, not prose: the caller resolves it
   * through `errorCodeMessage` so the refusal is read in the viewer's language.
   */
  | { type: "blocked"; reason: "MOVE_BLOCKED_TRASH" }
  | { type: "files"; ids: string[]; destination: DropDestination }
  | { type: "folder"; id: string; destination: DropDestination };

export type PlanDragMoveInput = {
  source: DragSource;
  /** The droppable id under the pointer at drop time, if any. */
  overId: string | null | undefined;
  /** The folder being browsed; `null` at the account root. */
  currentFolderId: string | null;
  /**
   * The listing's current selection. A drag that starts on a selected file carries
   * the whole selection — the behaviour every desktop file manager has — while a
   * drag on an unselected row carries only that row and leaves the selection alone.
   */
  selectedIds: readonly string[];
  canEdit: boolean;
  trash: boolean;
};

export function planDragMove({
  source,
  overId,
  currentFolderId,
  selectedIds,
  canEdit,
  trash,
}: PlanDragMoveInput): MovePlan {
  const destination = resolveDropDestination(overId);
  if (destination === undefined) return { type: "none" };

  // A trashed row has no folder to be moved into: restoring it is the only way out,
  // and dropping it somewhere would quietly resurrect it in a new place.
  if (trash) {
    return { type: "blocked", reason: "MOVE_BLOCKED_TRASH" };
  }
  if (!canEdit) return { type: "denied" };

  if (source.kind === "folder") {
    // Dropped on itself. dnd-kit reports this whenever a card is its own drop target.
    if (destination === source.id) return { type: "none" };
    // Its parent is the folder being browsed, so this drop changes nothing.
    if (destination === currentFolderId) return { type: "none" };
    return { type: "folder", id: source.id, destination };
  }

  if (destination === currentFolderId) return { type: "none" };

  // `size > 1` deliberately: dragging the only selected row is the same gesture as
  // dragging an unselected one, and both should move exactly that row.
  const dragsSelection = selectedIds.length > 1 && selectedIds.includes(source.id);
  return {
    type: "files",
    ids: dragsSelection ? [...selectedIds] : [source.id],
    destination,
  };
}

/**
 * What the drag overlay says while a drag is in flight.
 *
 * Split out so the count shown under the pointer is derived from the same rule the drop
 * will apply — an overlay reading "3" that then moves one row is worse than no overlay.
 * The name always comes along: a bare count hides which row was actually picked up.
 */
export function describeDrag(
  source: DragSource,
  selectedIds: readonly string[]
): { label: string; count: number } {
  const count =
    source.kind === "file" && selectedIds.length > 1 && selectedIds.includes(source.id)
      ? selectedIds.length
      : 1;
  return { label: source.name, count };
}
