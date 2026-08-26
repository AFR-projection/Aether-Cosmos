/**
 * The folder tree pane, as pure data.
 *
 * The browser navigates one folder at a time (`?folder=<id>`), which is fine for
 * looking at a folder and useless for finding one: a project uploaded with two
 * hundred nested directories could only be walked a click at a time, with no way
 * to see where you were. This module is the half of the tree that can be tested
 * without a DOM — which folders are open, which rows that produces, and where a
 * key press moves — leaving the component with fetching and drawing.
 *
 * Children arrive one parent at a time from `GET /api/folders?parentId=`, so the
 * tree is always built from a PARTIAL map. A folder whose children have not been
 * fetched yet is not a leaf; it is unknown, and that difference is carried
 * explicitly (`hasChildren: null`) instead of being guessed.
 */

/** The fields the tree needs from a folder row; the API sends more. */
export type TreeFolder = { id: string; name: string; parentId: string | null };

/** What the pane is rooted at: the account root (`null`) or a shared folder. */
export type TreeRoot = { id: string | null; name: string };

/** Map key and focus key for the root row, which has no id of its own. */
export const ROOT_KEY = "__root__";

/**
 * Droppable id for the account-root row, meaning "out of every folder".
 * A uuid can never collide with it, so it is safe to mix with real folder ids.
 */
export const TREE_ROOT_DROP_ID = "__tree_root__";

/** Rows drawn before the pane stops and says the tree goes on. */
export const MAX_TREE_ROWS = 1500;

/** Parents fetched at once: the root, the open path, and what the user opened. */
export const MAX_OPEN_NODES = 60;

/** Children are keyed by parent id; the root has none of its own. */
export function childrenKey(parentId: string | null): string {
  return parentId ?? ROOT_KEY;
}

/**
 * Folder order in the pane.
 *
 * `numeric` puts `part2` before `part10` the way a file explorer does — plain
 * string order puts `10` first, which looks like a bug in any project that
 * numbers its directories. The id tie-break keeps two folders of the same name
 * in a fixed order instead of letting them swap places between renders.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareFolderNames(a: TreeFolder, b: TreeFolder): number {
  const byName = collator.compare(a.name, b.name);
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * Which folders are open.
 *
 * Two sets, not one: the ancestors of the folder being viewed are opened for the
 * user, so "absent from `expanded`" cannot mean "closed" — a folder the user
 * deliberately closed has to beat that, and re-opening it has to beat the close.
 * `collapsed` is that override, which is why closing an ancestor of the current
 * folder sticks instead of springing back open on the next render.
 */
export type ExpansionState = {
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
};

export const EMPTY_EXPANSION: ExpansionState = {
  expanded: new Set(),
  collapsed: new Set(),
};

export function isFolderExpanded(
  state: ExpansionState,
  id: string,
  ancestors: ReadonlySet<string>
): boolean {
  if (state.collapsed.has(id)) return false;
  return state.expanded.has(id) || ancestors.has(id);
}

/** Flip one folder. `wasExpanded` is what the row was showing when it was clicked. */
export function toggleFolderExpansion(
  state: ExpansionState,
  id: string,
  wasExpanded: boolean
): ExpansionState {
  const expanded = new Set(state.expanded);
  const collapsed = new Set(state.collapsed);
  if (wasExpanded) {
    expanded.delete(id);
    collapsed.add(id);
  } else {
    collapsed.delete(id);
    expanded.add(id);
  }
  return { expanded, collapsed };
}

/** One drawn row. `depth: 0` is a child of the root row. */
export type TreeRow = {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  expanded: boolean;
  /** `null` until this folder's own children have been fetched. */
  hasChildren: boolean | null;
  /** Position among its siblings, 1-based, for `aria-posinset`. */
  posInSet: number;
  setSize: number;
};

/**
 * The visible rows, in the order they are drawn.
 *
 * Depth-first from the root, descending only into folders that are open AND
 * loaded, so a partial map yields a shorter tree rather than a wrong one.
 */
export function flattenTree(args: {
  root: TreeRoot;
  childrenByParent: ReadonlyMap<string, readonly TreeFolder[]>;
  isExpanded: (id: string) => boolean;
  maxRows?: number;
}): { rows: TreeRow[]; truncated: boolean } {
  const { root, childrenByParent, isExpanded, maxRows = MAX_TREE_ROWS } = args;

  const rows: TreeRow[] = [];
  /**
   * A folder is drawn at most once. A `parent_id` cycle — or a folder reported
   * under two parents — would otherwise walk forever and take the tab with it.
   */
  const drawn = new Set<string>();
  let truncated = false;

  const sortedChildren = (parentId: string | null): readonly TreeFolder[] => {
    const children = childrenByParent.get(childrenKey(parentId));
    return children ? [...children].sort(compareFolderNames) : [];
  };

  type Frame = { items: readonly TreeFolder[]; index: number; depth: number };
  const stack: Frame[] = [{ items: sortedChildren(root.id), index: 0, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length) {
      stack.pop();
      continue;
    }

    const folder = frame.items[frame.index];
    const posInSet = frame.index + 1;
    const setSize = frame.items.length;
    frame.index += 1;

    if (drawn.has(folder.id)) continue;
    drawn.add(folder.id);

    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }

    const loaded = childrenByParent.get(folder.id);
    // An open folder that turned out to be empty is drawn closed: there is no row
    // to show under it, and a chevron that opens onto nothing reads as a dead click.
    const open = isExpanded(folder.id) && (loaded === undefined || loaded.length > 0);

    rows.push({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      depth: frame.depth,
      expanded: open,
      hasChildren: loaded === undefined ? null : loaded.length > 0,
      posInSet,
      setSize,
    });

    if (open && loaded !== undefined && loaded.length > 0) {
      stack.push({
        items: [...loaded].sort(compareFolderNames),
        index: 0,
        depth: frame.depth + 1,
      });
    }
  }

  return { rows, truncated };
}

/**
 * The parents whose children the pane needs, root first.
 *
 * Derived from the expansion state, not from the drawn rows: the rows are built
 * FROM the children, so asking the rows what to fetch would be circular. The
 * price is the occasional stale id — a folder since closed elsewhere, or deleted
 * — which costs one cached empty response and no correctness.
 */
export function openParentIds(args: {
  root: TreeRoot;
  state: ExpansionState;
  ancestors: ReadonlySet<string>;
  max?: number;
}): (string | null)[] {
  const { root, state, ancestors, max = MAX_OPEN_NODES } = args;

  const ids: (string | null)[] = [root.id];
  const seen = new Set<string>([childrenKey(root.id)]);

  // Ancestors first: the path to the folder being viewed is what has to be on
  // screen, so it wins the budget over folders opened by hand somewhere else.
  for (const id of [...ancestors, ...state.expanded]) {
    if (ids.length >= max) break;
    if (state.collapsed.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/** What a key press means. The component performs it; this decides it. */
export type TreeKeyAction =
  | { type: "focus"; id: string }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "open"; id: string }
  | { type: "none" };

const NO_ACTION: TreeKeyAction = { type: "none" };

/**
 * The WAI-ARIA tree keys, resolved against the drawn rows.
 *
 * `focusedId` is a folder id, or `ROOT_KEY` for the root row — which sits above
 * `rows[0]` and is always open, so Up from the first row lands on it and Right
 * from it steps into the tree.
 */
export function resolveTreeKey(
  key: string,
  focusedId: string,
  rows: readonly TreeRow[]
): TreeKeyAction {
  const atRoot = focusedId === ROOT_KEY;
  const index = atRoot ? -1 : rows.findIndex((row) => row.id === focusedId);
  // Focus on a row that has since disappeared (the folder was collapsed away or
  // deleted): the key would otherwise be resolved against the wrong row.
  if (!atRoot && index === -1) return NO_ACTION;

  switch (key) {
    case "ArrowDown": {
      const next = rows[index + 1];
      return next ? { type: "focus", id: next.id } : NO_ACTION;
    }
    case "ArrowUp": {
      if (atRoot) return NO_ACTION;
      return index === 0
        ? { type: "focus", id: ROOT_KEY }
        : { type: "focus", id: rows[index - 1].id };
    }
    case "ArrowRight": {
      if (atRoot) return rows[0] ? { type: "focus", id: rows[0].id } : NO_ACTION;
      const row = rows[index];
      // Open it, unless it is known to have nothing to open.
      if (!row.expanded) {
        return row.hasChildren === false ? NO_ACTION : { type: "expand", id: row.id };
      }
      const next = rows[index + 1];
      return next && next.parentId === row.id ? { type: "focus", id: next.id } : NO_ACTION;
    }
    case "ArrowLeft": {
      if (atRoot) return NO_ACTION;
      const row = rows[index];
      if (row.expanded) return { type: "collapse", id: row.id };
      const parent = rows.find((candidate) => candidate.id === row.parentId);
      return { type: "focus", id: parent ? parent.id : ROOT_KEY };
    }
    case "Home":
      return { type: "focus", id: ROOT_KEY };
    case "End": {
      const last = rows[rows.length - 1];
      return { type: "focus", id: last ? last.id : ROOT_KEY };
    }
    case "Enter":
    case " ":
      return { type: "open", id: focusedId };
    default:
      return NO_ACTION;
  }
}
