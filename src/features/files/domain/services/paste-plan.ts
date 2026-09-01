/**
 * Every decision a paste can make before it touches the network.
 *
 * Pure on purpose, in the same spirit as `drag-move.ts`: the server is still the
 * authority on who may write where and on what already exists at the destination, but
 * a paste that cannot possibly succeed — into the trash, into a folder that is inside
 * the thing being pasted, back into the folder a cut came from — should cost nothing
 * and should say *why* in a code the UI can translate.
 *
 * The naming helpers live here too, and they are the same code the route runs. The
 * browser uses them to fill in the conflict dialog's preview ("will be saved as
 * report (2).pdf"); the route uses them against a freshly-read destination, because
 * between the dialog opening and the paste landing another tab may have created the
 * very name we promised.
 */

/** Structurally compatible with `ClipboardEntry`, but with no import — this module stays pure. */
export type PasteEntry = {
  kind: "file" | "folder";
  id: string;
  name: string;
};

export type PasteMode = "copy" | "cut";

export type PasteBlockedReason =
  /** The trash is a view, not a place; there is nothing to paste into. */
  | "PASTE_INTO_TRASH"
  /** A folder cannot be pasted into itself. */
  | "PASTE_INTO_SELF"
  /** A folder cannot be pasted into its own subtree — the copy would never end. */
  | "PASTE_INTO_DESCENDANT"
  /** A cut pasted back where it came from would move nothing. */
  | "PASTE_CUT_SAME_FOLDER";

export type PastePlan =
  /** Empty clipboard: the paste affordance should not even be offered. */
  | { type: "none" }
  /** The caller has no write capability at the destination. */
  | { type: "denied" }
  | { type: "blocked"; reason: PasteBlockedReason }
  | {
      type: "paste";
      mode: PasteMode;
      /** Destination folder; `null` is the account root. */
      destinationFolderId: string | null;
      files: PasteEntry[];
      folders: PasteEntry[];
    };

export type PastePlanInput = {
  clipboard: {
    mode: PasteMode;
    entries: readonly PasteEntry[];
    sourceFolderId: string | null;
  } | null;
  /** Where the paste is aimed; `null` is the account root. */
  destinationFolderId: string | null;
  /**
   * The destination folder's id together with every ancestor id up to the root.
   *
   * This is what makes the descendant check possible in the browser: if any folder on
   * the clipboard appears on the destination's path, the destination is inside it.
   */
  destinationPathIds: readonly string[];
  /** Whether the caller may create things at the destination. */
  canEdit: boolean;
  /** True while the trash view is open. */
  trash: boolean;
};

/**
 * Decide what a paste into `destinationFolderId` would do.
 *
 * Check order matters and is chosen so the message the user gets is the most specific
 * true one: "nothing to paste" outranks "you may not write here", which outranks the
 * geometry checks, because a refusal about a folder's shape is confusing if the real
 * problem is that this folder is read-only.
 */
export function planPaste(input: PastePlanInput): PastePlan {
  const { clipboard, destinationFolderId, destinationPathIds, canEdit, trash } = input;

  if (!clipboard || clipboard.entries.length === 0) return { type: "none" };
  if (trash) return { type: "blocked", reason: "PASTE_INTO_TRASH" };
  if (!canEdit) return { type: "denied" };

  const folders = clipboard.entries.filter((e) => e.kind === "folder");
  const files = clipboard.entries.filter((e) => e.kind === "file");

  // Geometry first for folders — a self/descendant paste is wrong in both modes. Copying
  // a folder into its own subtree is not "a copy that ends up nested", it is unbounded.
  const path = new Set(destinationPathIds);
  for (const folder of folders) {
    if (folder.id === destinationFolderId) return { type: "blocked", reason: "PASTE_INTO_SELF" };
    if (path.has(folder.id)) return { type: "blocked", reason: "PASTE_INTO_DESCENDANT" };
  }

  // A cut back into its own folder moves nothing. The old code sent it to the server,
  // which dutifully "moved" every row to the folder it was already in and reported
  // success — a paste that claimed to do something and did not.
  if (clipboard.mode === "cut" && clipboard.sourceFolderId === destinationFolderId) {
    return { type: "blocked", reason: "PASTE_CUT_SAME_FOLDER" };
  }

  return {
    type: "paste",
    mode: clipboard.mode,
    destinationFolderId,
    files,
    folders,
  };
}

/* ─────────────────────────────  Naming  ───────────────────────────── */

/**
 * Longest name we will produce. Suffixing " (2)" onto an already-maximal name has to
 * shorten the stem rather than hand the database a value it will reject.
 */
export const MAX_NAME_LENGTH = 255;

/**
 * Split a name into the part a suffix goes after, and the extension.
 *
 * Deliberately the same rule the media editor uses: only a dot that is not the first
 * character starts an extension, so `.gitignore` keeps its whole name, and only the
 * last dot counts, so `archive.tar.gz` becomes `archive.tar` + `.gz`. That is not
 * technically the "real" extension of a tarball, but it is what Explorer shows and
 * what the rest of this codebase already does.
 */
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function withinLimit(stem: string, suffix: string, extension: string): string {
  const overflow = stem.length + suffix.length + extension.length - MAX_NAME_LENGTH;
  if (overflow <= 0) return `${stem}${suffix}${extension}`;
  // Trim the stem, never the suffix or the extension: a truncated " (2)" would collide
  // again and a truncated extension changes what the file is.
  const trimmed = stem.slice(0, Math.max(1, stem.length - overflow)).trimEnd();
  return `${trimmed}${suffix}${extension}`;
}

/**
 * The name Explorer's "Keep both" would give you: `report.pdf` → `report (2).pdf`,
 * then `report (3).pdf`, and so on until one is free.
 *
 * The loop is unbounded but cannot run away: `taken` is finite, so at worst it tries
 * `taken.size + 1` candidates.
 */
export function nextAvailableName(name: string, taken: ReadonlySet<string>): string {
  const { stem, extension } = splitFileName(name);

  const base = withinLimit(stem, "", extension);
  if (!taken.has(base)) return base;

  for (let n = 2; ; n++) {
    const candidate = withinLimit(stem, ` (${n})`, extension);
    if (!taken.has(candidate)) return candidate;
  }
}

/* ─────────────────────────────  Conflicts  ───────────────────────────── */

export type ConflictPolicy = "keep-both" | "replace" | "skip";

export type PasteItemPlan = {
  id: string;
  kind: "file" | "folder";
  /** Name the item had on the clipboard. */
  sourceName: string;
  /** Name it will have at the destination. */
  name: string;
  /**
   * `create` — nothing in the way, or a keep-both rename resolved it.
   * `replace` — an existing file of the same name is to be trashed first.
   * `skip`    — leave the destination alone.
   */
  action: "create" | "replace" | "skip";
  /** Whether this item collided at all, so the UI can say how many were renamed. */
  conflicted: boolean;
};

export type DestinationNames = {
  files: readonly string[];
  folders: readonly string[];
};

/**
 * Work out, item by item, what a paste should do about names already in use.
 *
 * Two details that are easy to get wrong:
 *
 * - **Files and folders do not collide with each other.** They are separate tables, so
 *   a folder called `docs` and a file called `docs` can and do coexist; conflicts are
 *   resolved per kind.
 * - **`replace` never applies to a folder.** Explorer offers to *merge* directories,
 *   which is a different operation with its own rules; overwriting instead would delete
 *   an entire existing subtree to make room. Until merge exists, a folder asked to
 *   replace is kept-both instead — an extra `docs (2)` is a nuisance, a silently
 *   deleted subtree is a disaster.
 */
export function resolveConflicts(
  entries: readonly PasteEntry[],
  existing: DestinationNames,
  policy: ConflictPolicy
): PasteItemPlan[] {
  const takenFiles = new Set(existing.files);
  const takenFolders = new Set(existing.folders);

  return entries.map((entry) => {
    const taken = entry.kind === "folder" ? takenFolders : takenFiles;
    const conflicted = taken.has(entry.name);

    if (!conflicted) {
      // Claim the name so two items pasted in the same run cannot both take it.
      taken.add(entry.name);
      return {
        id: entry.id,
        kind: entry.kind,
        sourceName: entry.name,
        name: entry.name,
        action: "create",
        conflicted: false,
      };
    }

    if (policy === "skip") {
      return {
        id: entry.id,
        kind: entry.kind,
        sourceName: entry.name,
        name: entry.name,
        action: "skip",
        conflicted: true,
      };
    }

    if (policy === "replace" && entry.kind === "file") {
      // The name stays claimed — it is the same name, now pointing at the new file.
      return {
        id: entry.id,
        kind: entry.kind,
        sourceName: entry.name,
        name: entry.name,
        action: "replace",
        conflicted: true,
      };
    }

    const name = nextAvailableName(entry.name, taken);
    taken.add(name);
    return {
      id: entry.id,
      kind: entry.kind,
      sourceName: entry.name,
      name,
      action: "create",
      conflicted: true,
    };
  });
}

/** Whether a paste needs to ask the user anything before it starts. */
export function hasConflicts(plans: readonly PasteItemPlan[]): boolean {
  return plans.some((p) => p.conflicted);
}
