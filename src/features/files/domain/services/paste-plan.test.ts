import { describe, it, expect } from "vitest";
import {
  MAX_NAME_LENGTH,
  hasConflicts,
  nextAvailableName,
  planPaste,
  resolveConflicts,
  splitFileName,
  type PasteEntry,
  type PastePlanInput,
} from "@files/domain/services/paste-plan";

/**
 * A paste writes to storage and can move a whole subtree, so every refusal is pinned
 * here rather than left to the route: if the browser stops asking about a paste into a
 * folder's own subtree, the server would happily start copying and never stop.
 */

const FILE: PasteEntry = { kind: "file", id: "file-1", name: "report.pdf" };
const FOLDER: PasteEntry = { kind: "folder", id: "folder-1", name: "Projects" };

function plan(over: Partial<PastePlanInput> = {}) {
  return planPaste({
    clipboard: { mode: "copy", entries: [FILE], sourceFolderId: "source" },
    destinationFolderId: "dest",
    destinationPathIds: ["dest"],
    canEdit: true,
    trash: false,
    ...over,
  });
}

describe("planPaste", () => {
  it("does nothing with an empty clipboard", () => {
    expect(plan({ clipboard: null })).toEqual({ type: "none" });
    expect(
      plan({ clipboard: { mode: "copy", entries: [], sourceFolderId: null } })
    ).toEqual({ type: "none" });
  });

  it("refuses to paste into the trash, even for an editor", () => {
    expect(plan({ trash: true })).toEqual({
      type: "blocked",
      reason: "PASTE_INTO_TRASH",
    });
  });

  it("prefers the trash refusal over the permission refusal", () => {
    // Both are true; "you cannot paste into the trash" is the useful sentence.
    expect(plan({ trash: true, canEdit: false })).toEqual({
      type: "blocked",
      reason: "PASTE_INTO_TRASH",
    });
  });

  it("denies a paste where the caller cannot write", () => {
    expect(plan({ canEdit: false })).toEqual({ type: "denied" });
  });

  it("blocks a folder pasted into itself", () => {
    expect(
      plan({
        clipboard: { mode: "copy", entries: [FOLDER], sourceFolderId: "parent" },
        destinationFolderId: "folder-1",
        destinationPathIds: ["parent", "folder-1"],
      })
    ).toEqual({ type: "blocked", reason: "PASTE_INTO_SELF" });
  });

  it("blocks a folder pasted into its own subtree", () => {
    expect(
      plan({
        clipboard: { mode: "copy", entries: [FOLDER], sourceFolderId: "parent" },
        destinationFolderId: "deep",
        destinationPathIds: ["parent", "folder-1", "middle", "deep"],
      })
    ).toEqual({ type: "blocked", reason: "PASTE_INTO_DESCENDANT" });
  });

  it("blocks the descendant case for a cut as well as a copy", () => {
    expect(
      plan({
        clipboard: { mode: "cut", entries: [FOLDER], sourceFolderId: "parent" },
        destinationFolderId: "child",
        destinationPathIds: ["folder-1", "child"],
      })
    ).toEqual({ type: "blocked", reason: "PASTE_INTO_DESCENDANT" });
  });

  it("blocks a cut pasted back into the folder it came from", () => {
    expect(
      plan({
        clipboard: { mode: "cut", entries: [FILE], sourceFolderId: "dest" },
        destinationFolderId: "dest",
      })
    ).toEqual({ type: "blocked", reason: "PASTE_CUT_SAME_FOLDER" });
  });

  it("treats the root as a folder for the same-folder cut check", () => {
    expect(
      plan({
        clipboard: { mode: "cut", entries: [FILE], sourceFolderId: null },
        destinationFolderId: null,
        destinationPathIds: [],
      })
    ).toEqual({ type: "blocked", reason: "PASTE_CUT_SAME_FOLDER" });
  });

  it("allows a copy back into the source folder — that is how you duplicate", () => {
    const result = plan({
      clipboard: { mode: "copy", entries: [FILE], sourceFolderId: "dest" },
      destinationFolderId: "dest",
    });
    expect(result.type).toBe("paste");
  });

  it("allows a folder copy into a sibling folder", () => {
    const result = plan({
      clipboard: { mode: "copy", entries: [FOLDER], sourceFolderId: "parent" },
      destinationFolderId: "sibling",
      destinationPathIds: ["parent", "sibling"],
    });
    expect(result).toEqual({
      type: "paste",
      mode: "copy",
      destinationFolderId: "sibling",
      files: [],
      folders: [FOLDER],
    });
  });

  it("splits a mixed clipboard into files and folders", () => {
    const result = plan({
      clipboard: {
        mode: "cut",
        entries: [FILE, FOLDER, { kind: "file", id: "file-2", name: "b.txt" }],
        sourceFolderId: "source",
      },
    });
    expect(result).toEqual({
      type: "paste",
      mode: "cut",
      destinationFolderId: "dest",
      files: [FILE, { kind: "file", id: "file-2", name: "b.txt" }],
      folders: [FOLDER],
    });
  });
});

describe("splitFileName", () => {
  it("splits on the last dot", () => {
    expect(splitFileName("report.pdf")).toEqual({ stem: "report", extension: ".pdf" });
    expect(splitFileName("archive.tar.gz")).toEqual({
      stem: "archive.tar",
      extension: ".gz",
    });
  });

  it("treats a leading dot as part of the name", () => {
    expect(splitFileName(".gitignore")).toEqual({ stem: ".gitignore", extension: "" });
  });

  it("handles a name with no extension", () => {
    expect(splitFileName("README")).toEqual({ stem: "README", extension: "" });
  });
});

describe("nextAvailableName", () => {
  it("returns the name unchanged when nothing is in the way", () => {
    expect(nextAvailableName("report.pdf", new Set())).toBe("report.pdf");
  });

  it("counts up from (2), the way Explorer's keep-both does", () => {
    expect(nextAvailableName("report.pdf", new Set(["report.pdf"]))).toBe("report (2).pdf");
    expect(
      nextAvailableName("report.pdf", new Set(["report.pdf", "report (2).pdf"]))
    ).toBe("report (3).pdf");
  });

  it("keeps the extension it would show in the UI", () => {
    expect(nextAvailableName("archive.tar.gz", new Set(["archive.tar.gz"]))).toBe(
      "archive.tar (2).gz"
    );
  });

  it("suffixes a dotfile without inventing an extension", () => {
    expect(nextAvailableName(".gitignore", new Set([".gitignore"]))).toBe(".gitignore (2)");
  });

  it("suffixes an extensionless name", () => {
    expect(nextAvailableName("README", new Set(["README"]))).toBe("README (2)");
  });

  it("skips over a gap instead of reusing a taken number", () => {
    expect(
      nextAvailableName("a.txt", new Set(["a.txt", "a (2).txt", "a (3).txt", "a (5).txt"]))
    ).toBe("a (4).txt");
  });

  it("shortens the stem rather than exceeding the name limit", () => {
    const long = `${"x".repeat(MAX_NAME_LENGTH - 4)}.txt`;
    expect(long.length).toBe(MAX_NAME_LENGTH);

    const result = nextAvailableName(long, new Set([long]));
    expect(result.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(result.endsWith(" (2).txt")).toBe(true);
  });

  it("terminates even when many candidates are taken", () => {
    const taken = new Set(["a.txt"]);
    for (let n = 2; n <= 50; n++) taken.add(`a (${n}).txt`);
    expect(nextAvailableName("a.txt", taken)).toBe("a (51).txt");
  });
});

describe("resolveConflicts", () => {
  const empty = { files: [], folders: [] };

  it("creates everything when the destination is empty", () => {
    expect(resolveConflicts([FILE, FOLDER], empty, "keep-both")).toEqual([
      {
        id: "file-1",
        kind: "file",
        sourceName: "report.pdf",
        name: "report.pdf",
        action: "create",
        conflicted: false,
      },
      {
        id: "folder-1",
        kind: "folder",
        sourceName: "Projects",
        name: "Projects",
        action: "create",
        conflicted: false,
      },
    ]);
  });

  it("renames a colliding file under keep-both", () => {
    const [plan] = resolveConflicts([FILE], { files: ["report.pdf"], folders: [] }, "keep-both");
    expect(plan).toMatchObject({ name: "report (2).pdf", action: "create", conflicted: true });
  });

  it("does not let two pasted items claim the same new name", () => {
    const entries: PasteEntry[] = [
      { kind: "file", id: "a", name: "note.txt" },
      { kind: "file", id: "b", name: "note.txt" },
    ];
    const plans = resolveConflicts(entries, { files: ["note.txt"], folders: [] }, "keep-both");
    expect(plans.map((p) => p.name)).toEqual(["note (2).txt", "note (3).txt"]);
  });

  it("does not let an uncontested name be taken twice in one run", () => {
    const entries: PasteEntry[] = [
      { kind: "file", id: "a", name: "note.txt" },
      { kind: "file", id: "b", name: "note.txt" },
    ];
    const plans = resolveConflicts(entries, empty, "keep-both");
    expect(plans.map((p) => p.name)).toEqual(["note.txt", "note (2).txt"]);
  });

  it("keeps files and folders in separate namespaces", () => {
    const entries: PasteEntry[] = [
      { kind: "file", id: "a", name: "docs" },
      { kind: "folder", id: "b", name: "docs" },
    ];
    const plans = resolveConflicts(entries, { files: ["docs"], folders: [] }, "keep-both");
    // Only the file collided; the folder called `docs` is a different thing entirely.
    expect(plans.map((p) => p.name)).toEqual(["docs (2)", "docs"]);
    expect(plans.map((p) => p.conflicted)).toEqual([true, false]);
  });

  it("overwrites a colliding file under replace", () => {
    const [plan] = resolveConflicts([FILE], { files: ["report.pdf"], folders: [] }, "replace");
    expect(plan).toMatchObject({ name: "report.pdf", action: "replace", conflicted: true });
  });

  it("never overwrites a folder — replace falls back to keep-both", () => {
    const [plan] = resolveConflicts([FOLDER], { files: [], folders: ["Projects"] }, "replace");
    expect(plan).toMatchObject({ name: "Projects (2)", action: "create", conflicted: true });
  });

  it("leaves the destination alone under skip", () => {
    const plans = resolveConflicts(
      [FILE, FOLDER],
      { files: ["report.pdf"], folders: ["Projects"] },
      "skip"
    );
    expect(plans.map((p) => p.action)).toEqual(["skip", "skip"]);
    expect(plans.map((p) => p.name)).toEqual(["report.pdf", "Projects"]);
  });

  it("only skips the items that actually collided", () => {
    const entries: PasteEntry[] = [FILE, { kind: "file", id: "file-2", name: "fresh.txt" }];
    const plans = resolveConflicts(entries, { files: ["report.pdf"], folders: [] }, "skip");
    expect(plans.map((p) => p.action)).toEqual(["skip", "create"]);
  });
});

describe("hasConflicts", () => {
  it("is false when nothing collided", () => {
    expect(hasConflicts(resolveConflicts([FILE], { files: [], folders: [] }, "keep-both"))).toBe(
      false
    );
  });

  it("is true as soon as one item collided", () => {
    expect(
      hasConflicts(resolveConflicts([FILE], { files: ["report.pdf"], folders: [] }, "keep-both"))
    ).toBe(true);
  });
});
