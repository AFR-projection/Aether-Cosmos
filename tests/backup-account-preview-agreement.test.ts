/**
 * `planFilesSplit` and `importFiles` answer the same question, and must answer it the same way.
 *
 * §7.2 lets the user see how many files a restore would write, skip and rename *before* it runs,
 * and §7.5 says those numbers may never be "derived from a rule the importer does not use — that
 * would be a number nobody can reconcile with the report afterwards". The preview is a promise,
 * and this file is where the promise is checked against what actually happens.
 *
 * So every case below runs both: the planner over one reader, the importer over an identical one,
 * and then the four identities that have to hold —
 *
 *     preview.restored + preview.newFolders === report.rows
 *     preview.bytes                         === report.bytes
 *     preview.skipped                       === report.skipped
 *     preview.renamed                       === report.renamed
 *
 * — for both `merge` and `replace`. Each case also pins the preview's own numbers, because two
 * implementations of the same mistake agree with each other perfectly.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.2, §7.5.
 */

import { createHash } from "crypto";
import { describe, expect, it } from "vitest";

import { importFiles } from "@backup/account/application/import-files";
import { planFilesSplit, type FilesSplitPreview } from "@backup/account/application/preview";
import {
  declaredBudget,
  type AfrReadable,
  type FilesImportSink,
  type ImportReport,
  type RestoreMode,
} from "@backup/account/application/import-types";
import {
  encodeFilesEntry,
  type AfrFileEntry,
  type AfrFilesEntry,
  type AfrFolderEntry,
} from "@backup/account/domain/index-entries";
import type { AfrSummary } from "@backup/account/domain/summary";

const CREATED = 1_700_000_000_000;
const UPDATED = 1_700_000_100_000;

function folder(path: string): AfrFolderEntry {
  return { kind: "folder", path, createdAt: CREATED, updatedAt: UPDATED };
}

function file(path: string, body: string): AfrFileEntry {
  const bytes = Buffer.from(body, "utf8");
  return {
    kind: "file",
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest(),
    mime: "text/plain",
    createdAt: CREATED,
    updatedAt: UPDATED,
  };
}

/** The digest of a body, as the live-row index spells it. */
function digest(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

/**
 * A reader over these entries and this payload.
 *
 * Built fresh for the planner and again for the importer rather than shared: `readPayload` is a
 * one-way cursor, and a test that let the two calls race over one generator would be measuring
 * the harness.
 */
function fakeReader(entries: AfrFilesEntry[], bodies: string[]): AfrReadable {
  const files = entries.filter((entry) => entry.kind === "file");
  const summary: AfrSummary = {
    accountBackupId: "A".repeat(52),
    appVersion: "test",
    counts: {
      folders: entries.length - files.length,
      files: files.length,
      memories: 0,
      rows: entries.length,
    },
    schemaVersion: 28,
    sourceInstanceId: "test-instance",
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
  return {
    summary,
    async *indexLines() {
      let lineNumber = 0;
      for (const entry of entries) {
        lineNumber += 1;
        const encoded = encodeFilesEntry(entry).toString("utf8");
        yield {
          text: encoded.slice(0, encoded.length - 1),
          lineNumber,
          where: `index line ${lineNumber}`,
        };
      }
    },
    async *readPayload() {
      yield Buffer.from(bodies.join(""), "utf8");
    },
  };
}

/** What the account already holds. The planner reads it through the same two generators. */
interface LiveState {
  folders?: [path: string, id: string][];
  files?: [path: string, sha256: string | null][];
}

function fakeSink(live: LiveState = {}): FilesImportSink {
  let created = 0;
  return {
    async *liveFolders() {
      for (const [path, id] of live.folders ?? []) yield { path, id };
    },
    async *liveFiles() {
      for (const [path, sha256] of live.files ?? []) yield { path, sha256 };
    },
    async createFolder() {
      created += 1;
      return `fld-${created}`;
    },
    async createFile(_row, body) {
      // Draining matters: the importer checks the payload was handed over, and a sink that
      // returned early would fail the run for a reason this file is not about.
      if (body.kind === "object") for await (const _piece of body.bytes) void _piece;
    },
  };
}

/* ── the two runs, and the identities between them ────────────────────────── */

interface Agreement {
  preview: FilesSplitPreview;
  report: ImportReport;
}

/**
 * Run both halves over the same archive and assert §7.2's four identities.
 *
 * The planner goes first, over its own reader and its own sink, because that is the order the
 * product uses: `/restore/inspect` previews from the archive's prefix, then `/restore` imports.
 */
async function agree(input: {
  entries: AfrFilesEntry[];
  bodies: string[];
  mode: RestoreMode;
  live?: LiveState;
}): Promise<Agreement> {
  const { entries, bodies, mode, live } = input;

  const preview = await planFilesSplit({
    reader: fakeReader(entries, bodies),
    source: fakeSink(live),
    mode,
  });

  const reader = fakeReader(entries, bodies);
  const report = await importFiles({
    reader,
    sink: fakeSink(live),
    mode,
    budget: declaredBudget(reader.summary.totalBytes),
  });

  expect(preview.restored + preview.newFolders, "rows").toBe(report.rows);
  expect(preview.bytes, "bytes").toBe(report.bytes);
  expect(preview.skipped, "skipped").toBe(report.skipped);
  expect(preview.renamed, "renamed").toBe(report.renamed);
  expect(preview.mode).toBe(report.mode);

  return { preview, report };
}

/** Both modes over one archive, for the cases where the live state is irrelevant. */
async function agreeBothWays(input: {
  entries: AfrFilesEntry[];
  bodies: string[];
  live?: LiveState;
}): Promise<{ merge: Agreement; replace: Agreement }> {
  return {
    merge: await agree({ ...input, mode: "merge" }),
    replace: await agree({ ...input, mode: "replace" }),
  };
}

/* ── an account with nothing in it ────────────────────────────────────────── */

describe("the preview of a restore into an empty account", () => {
  it("agrees on a plain tree, both ways", async () => {
    const entries = [folder("Photos"), folder("Photos/2026"), file("Photos/2026/a.txt", "alpha")];
    const { merge, replace } = await agreeBothWays({ entries, bodies: ["alpha"] });

    expect(merge.preview).toEqual({
      mode: "merge",
      restored: 1,
      skipped: 0,
      renamed: 0,
      newFolders: 2,
      bytes: 5,
    });
    // `replace` differs in what it adopts, never in what an empty account costs.
    expect(replace.preview).toEqual({ ...merge.preview, mode: "replace" });
    expect(merge.report.rows).toBe(3);
  });

  it("counts the ancestors the archive left implicit", async () => {
    // No folder entries at all: three folders exist only because a file needs them, and the
    // preview has to charge for them or its row count will be three short of the report's.
    const { preview, report } = await agree({
      entries: [file("A/B/C/x.txt", "xx")],
      bodies: ["xx"],
      mode: "merge",
    });

    expect(preview.newFolders).toBe(3);
    expect(preview.restored).toBe(1);
    expect(report.rows).toBe(4);
  });

  it("counts an empty folder, because an empty folder is content", async () => {
    const { preview, report } = await agree({
      entries: [folder("Empty")],
      bodies: [],
      mode: "merge",
    });

    expect(preview).toMatchObject({ restored: 0, newFolders: 1, bytes: 0 });
    expect(report.rows).toBe(1);
  });
});

/* ── §7.5's three outcomes, against rows the account already holds ────────── */

describe("the preview of a merge into an account that already holds files", () => {
  it("skips a file the account already has, byte for byte", async () => {
    const { preview, report } = await agree({
      entries: [folder("Docs"), file("Docs/a.txt", "same")],
      bodies: ["same"],
      mode: "merge",
      live: { folders: [["Docs", "fld-live"]], files: [["Docs/a.txt", digest("same")]] },
    });

    // Nothing written, nothing charged, and the folder was adopted rather than created.
    expect(preview).toEqual({
      mode: "merge",
      restored: 0,
      skipped: 1,
      renamed: 0,
      newFolders: 0,
      bytes: 0,
    });
    expect(report.rows).toBe(0);
  });

  it("never creates a parent for a file it skipped", async () => {
    // The archive carries no folder entry, so `Docs` would come from the file — and the file is
    // skipped before the folder is asked for. A preview that ensured parents up front would
    // report one row the import never writes.
    const { preview, report } = await agree({
      entries: [file("Docs/a.txt", "same")],
      bodies: ["same"],
      mode: "merge",
      live: { files: [["Docs/a.txt", digest("same")]] },
    });

    expect(preview.newFolders).toBe(0);
    expect(preview.skipped).toBe(1);
    expect(report.rows).toBe(0);
  });

  it("renames a collision and charges the bytes it writes", async () => {
    const { preview, report } = await agree({
      entries: [file("Docs/a.txt", "new bytes")],
      bodies: ["new bytes"],
      mode: "merge",
      live: { folders: [["Docs", "fld-live"]], files: [["Docs/a.txt", digest("old bytes")]] },
    });

    expect(preview).toMatchObject({ restored: 1, skipped: 0, renamed: 1, bytes: 9 });
    expect(report.rows).toBe(1);
  });

  it("treats a live row with no digest as a collision, never as a match", async () => {
    // A null checksum predates checksum recording. Comparing equal to it would skip the
    // archive's copy in favour of bytes nothing can vouch for.
    const { preview } = await agree({
      entries: [file("Docs/a.txt", "body")],
      bodies: ["body"],
      mode: "merge",
      live: { folders: [["Docs", "fld-live"]], files: [["Docs/a.txt", null]] },
    });

    expect(preview).toMatchObject({ restored: 1, skipped: 0, renamed: 1 });
  });
});

/* ── where the two modes genuinely diverge ────────────────────────────────── */

describe("the preview of the cases most likely to drift apart", () => {
  it("adopts a live folder in a merge and creates it fresh in a replace", async () => {
    // The one case where the correct answer differs by mode: `replace` adopts nothing, because a
    // restored file inside a folder the commit is about to soft-delete would come back invisible.
    const input = {
      entries: [folder("Photos"), folder("Photos/2026"), file("Photos/2026/a.txt", "z")],
      bodies: ["z"],
      live: { folders: [["Photos", "fld-live"]] as [string, string][] },
    };

    const { merge, replace } = await agreeBothWays(input);

    expect(merge.preview.newFolders).toBe(1);
    expect(replace.preview.newFolders).toBe(2);
    expect(merge.report.rows).toBe(2);
    expect(replace.report.rows).toBe(3);
  });

  it("renames past a literal '(restored)' name, in the archive and in the account", async () => {
    // Both names are already live with other bytes, so both entries move — and the second one
    // can only land once the first has reserved the name it chose. The INDEX is in path order,
    // which puts `a (restored).txt` first: a space sorts before a dot.
    const { preview, report } = await agree({
      entries: [file("Docs/a (restored).txt", "aa"), file("Docs/a.txt", "bbbb")],
      bodies: ["aa", "bbbb"],
      mode: "merge",
      live: {
        folders: [["Docs", "fld-live"]],
        files: [
          ["Docs/a (restored).txt", digest("other")],
          ["Docs/a.txt", digest("another")],
        ],
      },
    });

    expect(preview).toMatchObject({ restored: 2, skipped: 0, renamed: 2, bytes: 6 });
    expect(report.rows).toBe(2);
  });

  it("renames the archive's own duplicate path in a merge, and keeps both in a replace", async () => {
    // One archive, one path, twice. In `merge` the second copy collides with the first; in
    // `replace` there is nothing to collide with, so both come back as they were.
    const input = {
      entries: [file("Docs/dup.txt", "first"), file("Docs/dup.txt", "second")],
      bodies: ["first", "second"],
    };

    const { merge, replace } = await agreeBothWays(input);

    expect(merge.preview).toMatchObject({ restored: 2, renamed: 1, skipped: 0 });
    expect(replace.preview).toMatchObject({ restored: 2, renamed: 0, skipped: 0 });
  });

  it("skips nothing and renames nothing in a replace, however full the account is", async () => {
    // Same live rows as the skip case above, and the same archive: `replace` reads none of it,
    // because the rows it would have compared against are the ones stage 5 removes.
    const { preview, report } = await agree({
      entries: [folder("Docs"), file("Docs/a.txt", "same")],
      bodies: ["same"],
      mode: "replace",
      live: { folders: [["Docs", "fld-live"]], files: [["Docs/a.txt", digest("same")]] },
    });

    expect(preview).toEqual({
      mode: "replace",
      restored: 1,
      skipped: 0,
      renamed: 0,
      newFolders: 1,
      bytes: 4,
    });
    expect(report.rows).toBe(2);
  });
});
