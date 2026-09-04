/**
 * The files importer, over fakes: no database, no bucket, no archive bytes.
 *
 * `importFiles` is where an archive stops being a file and starts being rows, so what is
 * tested here is every decision it makes on the way — the folder tree it rebuilds, the
 * boundary it cuts the payload at, §7.5's three merge outcomes, and the seven refusals it can
 * raise. The reader and the sink are both fakes, which is the point of the ports: the whole of
 * that behaviour is exercised without a settings row, a transaction or an R2 credential.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.5, §11.
 */

import { createHash } from "crypto";
import { describe, expect, it } from "vitest";

import { importFiles } from "@backup/account/application/import-files";
import {
  declaredBudget,
  type AfrReadable,
  type FilesImportSink,
  type RestoreMode,
  type StagedFile,
  type StagedFolder,
} from "@backup/account/application/import-types";
import { AfrCorruptError, AfrTooLargeError } from "@backup/account/domain/errors";
import {
  encodeFilesEntry,
  type AfrFileEntry,
  type AfrFilesEntry,
  type AfrFolderEntry,
} from "@backup/account/domain/index-entries";
import type { AfrSummary } from "@backup/account/domain/summary";

const CREATED = 1_700_000_000_000;
const UPDATED = 1_700_000_100_000;

/** The cap `import-files.ts` keeps on a body it will buffer to test for noteness. */
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

function folder(path: string): AfrFolderEntry {
  return { kind: "folder", path, createdAt: CREATED, updatedAt: UPDATED };
}

function file(path: string, body: string, extra: Partial<AfrFileEntry> = {}): AfrFileEntry {
  const bytes = Buffer.from(body, "utf8");
  return {
    kind: "file",
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest(),
    mime: "text/plain",
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...extra,
  };
}

/** The INDEX and the payload a well-formed archive of these entries would carry. */
function archive(entries: AfrFilesEntry[], bodies: string[]): {
  entries: AfrFilesEntry[];
  payload: Buffer[];
} {
  return { entries, payload: [Buffer.from(bodies.join(""), "utf8")] };
}

function fakeReader(
  entries: AfrFilesEntry[],
  payload: Buffer[],
  overrides: Partial<AfrSummary> = {}
): AfrReadable {
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
    ...overrides,
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
      for (const piece of payload) yield piece;
    },
  };
}

interface Landed {
  row: StagedFile;
  /** The object's bytes as text. Empty for a note. */
  body: string;
  note: { content: unknown; annotations: unknown } | null;
}

interface LiveState {
  folders?: [path: string, id: string][];
  files?: [path: string, sha256: string | null][];
}

function fakeSink(live: LiveState = {}, opts: { skipDrain?: boolean } = {}) {
  const folders: StagedFolder[] = [];
  const landed: Landed[] = [];
  let created = 0;
  const sink: FilesImportSink = {
    async *liveFolders() {
      for (const [path, id] of live.folders ?? []) yield { path, id };
    },
    async *liveFiles() {
      for (const [path, sha256] of live.files ?? []) yield { path, sha256 };
    },
    async createFolder(row) {
      folders.push(row);
      created += 1;
      return `fld-${created}`;
    },
    async createFile(row, body) {
      if (body.kind === "note") {
        const note = { content: body.content, annotations: body.annotations };
        landed.push({ row, body: "", note });
        return;
      }
      // A sink that returns without reading, to prove the importer notices (§7.3).
      if (opts.skipDrain === true) {
        landed.push({ row, body: "", note: null });
        return;
      }
      const pieces: Uint8Array[] = [];
      for await (const piece of body.bytes) pieces.push(piece);
      landed.push({ row, body: Buffer.concat(pieces).toString("utf8"), note: null });
    },
  };
  return { sink, folders, landed };
}

interface RunInput {
  entries: AfrFilesEntry[];
  payload: Buffer[];
  mode?: RestoreMode;
  live?: LiveState;
  summary?: Partial<AfrSummary>;
  mimeAllowed?: (mime: string, name: string) => boolean;
  skipDrain?: boolean;
}

async function run(input: RunInput) {
  const reader = fakeReader(input.entries, input.payload, input.summary);
  const { sink, folders, landed } = fakeSink(input.live, { skipDrain: input.skipDrain });
  const report = await importFiles({
    reader,
    sink,
    mode: input.mode ?? "merge",
    budget: declaredBudget(reader.summary.totalBytes),
    mimeAllowed: input.mimeAllowed,
  });
  return { report, folders, landed };
}

/**
 * The refusal a call raised, typed.
 *
 * `rejects.toThrow` matches on `message`, and every refusal in this format shares one fixed
 * generic message by design (§12) — the specific half is `detail`. So the error has to be
 * caught to be read.
 */
async function caught<E extends Error>(
  ctor: new (...args: never[]) => E,
  fn: () => Promise<unknown>
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ctor) return error;
    throw error;
  }
  throw new Error(`expected ${ctor.name}, nothing was thrown`);
}

const names = (landed: Landed[]): string[] => landed.map((one) => one.row.name);

/* ── the folder tree ──────────────────────────────────────────────────────── */

describe("importFiles: folders", () => {
  it("creates every folder entry, in the app's own spelling", async () => {
    const { report, folders } = await run(archive([folder("Photos"), folder("Photos/2026")], []));
    expect(folders).toEqual([
      {
        parentId: null,
        name: "Photos",
        materializedPath: "/Photos/",
        depth: 0,
        createdAt: CREATED,
        updatedAt: UPDATED,
      },
      {
        parentId: "fld-1",
        name: "2026",
        materializedPath: "/Photos/2026/",
        depth: 1,
        createdAt: CREATED,
        updatedAt: UPDATED,
      },
    ]);
    expect(report.rows).toBe(2);
  });

  it("creates an ancestor the archive never named", async () => {
    const { report, folders, landed } = await run(archive([file("a/b/c.txt", "hi")], ["hi"]));
    expect(folders.map((row) => row.materializedPath)).toEqual(["/a/", "/a/b/"]);
    expect(folders.map((row) => row.depth)).toEqual([0, 1]);
    expect(landed[0].row.folderId).toBe("fld-2");
    expect(report.rows).toBe(3);
  });

  it("puts a file with no folder at the account root", async () => {
    const { folders, landed } = await run(archive([file("plan.txt", "hi")], ["hi"]));
    expect(folders).toEqual([]);
    expect(landed[0].row.folderId).toBeNull();
  });

  it("creates one folder for the many files inside it", async () => {
    const { folders } = await run(archive([file("a/x", "1"), file("a/y", "2")], ["1", "2"]));
    expect(folders).toHaveLength(1);
  });

  it("adopts a live folder in merge instead of creating a second one", async () => {
    const { report, folders, landed } = await run({
      ...archive([folder("Photos"), file("Photos/x.txt", "hi")], ["hi"]),
      live: { folders: [["Photos", "live-1"]] },
    });
    expect(folders).toEqual([]);
    expect(landed[0].row.folderId).toBe("live-1");
    expect(report.rows).toBe(1);
  });

  it("takes the first of two live folders that share a path", async () => {
    const { landed } = await run({
      ...archive([file("a/x.txt", "hi")], ["hi"]),
      live: { folders: [["a", "live-1"], ["a", "live-2"]] },
    });
    expect(landed[0].row.folderId).toBe("live-1");
  });

  it("creates folders fresh in replace, even where a live one has the same path", async () => {
    const { report, folders, landed } = await run({
      ...archive([folder("Photos"), file("Photos/x.txt", "hi")], ["hi"]),
      mode: "replace",
      live: { folders: [["Photos", "live-1"]] },
    });
    expect(folders).toHaveLength(1);
    expect(landed[0].row.folderId).toBe("fld-1");
    expect(report.rows).toBe(2);
  });
});

/* ── the payload, cut by the INDEX ────────────────────────────────────────── */

const sha = (body: string): string =>
  createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");

describe("importFiles: cutting the payload", () => {
  const three = [file("a", "alpha"), file("b", "bb"), file("c", "ccc")];

  it("gives each file exactly the bytes its entry declared", async () => {
    const { landed, report } = await run(archive(three, ["alpha", "bb", "ccc"]));
    expect(landed.map((one) => one.body)).toEqual(["alpha", "bb", "ccc"]);
    expect(report.bytes).toBe(10);
  });

  it("cuts the same way when the payload arrives one byte at a time", async () => {
    const payload = [...Buffer.from("alphabbccc", "utf8")].map((byte) => Buffer.from([byte]));
    const { landed } = await run({ entries: three, payload });
    expect(landed.map((one) => one.body)).toEqual(["alpha", "bb", "ccc"]);
  });

  it("cuts the same way when one piece spans several files", async () => {
    const { landed } = await run({
      entries: three,
      payload: [Buffer.from("alphab", "utf8"), Buffer.from("bcc", "utf8"), Buffer.from("c", "utf8")],
    });
    expect(landed.map((one) => one.body)).toEqual(["alpha", "bb", "ccc"]);
  });

  it("ignores an empty piece rather than reading it as the end", async () => {
    const { landed } = await run({
      entries: [file("a", "hi")],
      payload: [Buffer.alloc(0), Buffer.from("h", "utf8"), Buffer.alloc(0), Buffer.from("i", "utf8")],
    });
    expect(landed[0].body).toBe("hi");
  });

  it("refuses a payload that ends before an entry does", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({ entries: [file("a", "alpha")], payload: [Buffer.from("alp", "utf8")] })
    );
    expect(error.detail).toBe("payload ended 2 bytes before the end of index line 1");
  });

  it("refuses a payload with bytes left after the last entry", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({ entries: [file("a", "hi")], payload: [Buffer.from("hi!", "utf8")] })
    );
    expect(error.detail).toBe("payload carries 1 bytes past the last entry");
  });

  it("refuses a file whose bytes do not match its digest", async () => {
    const entry = file("a", "hello");
    const error = await caught(AfrCorruptError, () =>
      run({ entries: [entry], payload: [Buffer.from("world", "utf8")] })
    );
    expect(error.detail).toBe("index line 1 carries bytes that do not match its digest");
    // The size was right, so it is the digest and only the digest that refused this.
    expect(entry.size).toBe(5);
  });

  it("stops a sink that returns without draining what it was given", async () => {
    await expect(
      run({ ...archive([file("a", "hi")], ["hi"]), skipDrain: true })
    ).rejects.toThrow("files import: index line 1 handed over 0 of 2 bytes");
  });
});

/* ── §7.5, the three outcomes of a merge ──────────────────────────────────── */

describe("importFiles: merge", () => {
  it("skips a file the account already has, byte for byte", async () => {
    const { report, landed } = await run({
      ...archive([file("a.txt", "hi")], ["hi"]),
      live: { files: [["a.txt", sha("hi")]] },
    });
    expect(landed).toEqual([]);
    expect(report).toMatchObject({ rows: 0, bytes: 0, skipped: 1, renamed: 0 });
  });

  it("matches a stored digest whatever case it was written in", async () => {
    const { report } = await run({
      ...archive([file("a.txt", "hi")], ["hi"]),
      live: { files: [["a.txt", sha("hi").toUpperCase()]] },
    });
    expect(report.skipped).toBe(1);
  });

  it("restores a file the account does not have at that path", async () => {
    const { report, landed } = await run({
      ...archive([file("a.txt", "hi")], ["hi"]),
      live: { files: [["b.txt", sha("hi")]] },
    });
    expect(names(landed)).toEqual(["a.txt"]);
    expect(report).toMatchObject({ rows: 1, skipped: 0, renamed: 0 });
  });

  it("brings back a file whose path matches but whose bytes do not, renamed", async () => {
    const { report, landed } = await run({
      ...archive([file("report.pdf", "new")], ["new"]),
      live: { files: [["report.pdf", sha("old")]] },
    });
    expect(names(landed)).toEqual(["report (restored).pdf"]);
    expect(report).toMatchObject({ rows: 1, skipped: 0, renamed: 1 });
  });

  it("climbs the ladder when the restored name is taken as well", async () => {
    const { report, landed } = await run({
      ...archive([file("report.pdf", "new"), file("report.pdf", "new")], ["new", "new"]),
      live: {
        files: [
          ["report.pdf", sha("old")],
          ["report (restored).pdf", null],
        ],
      },
    });
    expect(names(landed)).toEqual(["report (restored 2).pdf", "report (restored 3).pdf"]);
    expect(report.renamed).toBe(2);
  });

  it("never matches a live row that has no stored digest", async () => {
    const { report, landed } = await run({
      ...archive([file("a.txt", "hi")], ["hi"]),
      live: { files: [["a.txt", null]] },
    });
    expect(names(landed)).toEqual(["a (restored).txt"]);
    expect(report.skipped).toBe(0);
  });

  it("matches one of the several digests a path holds", async () => {
    const { report } = await run({
      ...archive([file("a.txt", "hi")], ["hi"]),
      live: {
        files: [
          ["a.txt", sha("other")],
          ["a.txt", sha("hi")],
        ],
      },
    });
    expect(report.skipped).toBe(1);
  });

  it("keeps a skipped file's bytes out of the account but still walks past them", async () => {
    const { report, landed } = await run({
      ...archive([file("a.txt", "hi"), file("b.txt", "yo")], ["hi", "yo"]),
      live: { files: [["a.txt", sha("hi")]] },
    });
    expect(landed.map((one) => one.body)).toEqual(["yo"]);
    expect(report.bytes).toBe(2);
  });

  it("refuses a skipped file whose bytes are not the bytes it claimed", async () => {
    // Checked even though nothing is written: a wrong length here would shift every entry
    // after it, and the file that landed under the wrong bytes would look fine.
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [file("a.txt", "hi"), file("b.txt", "yo")],
        payload: [Buffer.from("XXyo", "utf8")],
        live: { files: [["a.txt", sha("hi")]] },
      })
    );
    expect(error.detail).toBe("index line 1 carries bytes that do not match its digest");
  });

  it("counts a name as taken only inside its own folder", async () => {
    const { landed } = await run({
      ...archive([file("a/x.txt", "1"), file("b/x.txt", "2")], ["1", "2"]),
      live: { files: [["a/x.txt", null]] },
    });
    expect(names(landed)).toEqual(["x (restored).txt", "x.txt"]);
  });

  it("puts the suffix at the end of a name with no extension", async () => {
    const { landed } = await run({
      ...archive([file("README", "1")], ["1"]),
      live: { files: [["README", null]] },
    });
    expect(names(landed)).toEqual(["README (restored)"]);
  });

  it("treats a leading dot as part of the name rather than an extension", async () => {
    const { landed } = await run({
      ...archive([file(".env", "1")], ["1"]),
      live: { files: [[".env", null]] },
    });
    expect(names(landed)).toEqual([".env (restored)"]);
  });

  it("keeps a renamed name inside the length a name may be", async () => {
    const stem = "z".repeat(250);
    const { landed } = await run({
      ...archive([file(`${stem}.txt`, "1")], ["1"]),
      live: { files: [[`${stem}.txt`, null]] },
    });
    expect(names(landed)[0]).toHaveLength(255);
    expect(names(landed)[0].endsWith(" (restored).txt")).toBe(true);
  });

  it("moves the suffix to the end when the extension leaves no room for it", async () => {
    const name = `a.${"e".repeat(250)}`;
    const { landed } = await run({
      ...archive([file(name, "1")], ["1"]),
      live: { files: [[name, null]] },
    });
    expect(names(landed)[0]).toHaveLength(255);
    expect(names(landed)[0].endsWith(" (restored)")).toBe(true);
  });

  it("ignores the live account entirely in replace, duplicate paths and all", async () => {
    const { report, landed } = await run({
      ...archive([file("a.txt", "hi"), file("a.txt", "hi")], ["hi", "hi"]),
      mode: "replace",
      live: { files: [["a.txt", sha("hi")]] },
    });
    expect(names(landed)).toEqual(["a.txt", "a.txt"]);
    expect(report).toMatchObject({ mode: "replace", rows: 2, skipped: 0, renamed: 0 });
  });
});

/* ── notes: a row in `file_contents`, never an object in the bucket ────────── */

const NOTE_MIME = "application/json";

const noteBody = (content: unknown, annotations: unknown = null): string =>
  JSON.stringify({ annotations, content });

describe("importFiles: notes", () => {
  it("recognises the two-key body the export writes", async () => {
    const body = noteBody({ type: "doc" }, [{ id: 1 }]);
    const { landed, report } = await run(
      archive([file("plan.note", body, { mime: NOTE_MIME })], [body])
    );
    expect(landed[0].note).toEqual({ content: { type: "doc" }, annotations: [{ id: 1 }] });
    expect(landed[0].row.mime).toBe(NOTE_MIME);
    // A note's bytes are quota like anyone else's; they just live in a row.
    expect(report.bytes).toBe(body.length);
  });

  it("keeps a note's MIME even where the instance would refuse it on upload", async () => {
    const body = noteBody(null);
    const { landed } = await run({
      ...archive([file("plan.note", body, { mime: NOTE_MIME })], [body]),
      mimeAllowed: () => false,
    });
    expect(landed[0].note).toEqual({ content: null, annotations: null });
    expect(landed[0].row.mime).toBe(NOTE_MIME);
  });

  it("keeps a .note whose body is not JSON as an object, bytes intact", async () => {
    const body = "not json at all";
    const { landed } = await run(archive([file("plan.note", body, { mime: NOTE_MIME })], [body]));
    expect(landed[0].note).toBeNull();
    expect(landed[0].body).toBe(body);
  });

  it("keeps a .note with a third key as an object", async () => {
    const body = JSON.stringify({ annotations: null, content: {}, extra: 1 });
    const { landed } = await run(archive([file("plan.note", body, { mime: NOTE_MIME })], [body]));
    expect(landed[0].note).toBeNull();
  });

  it("keeps a .note whose body is an array as an object", async () => {
    const body = JSON.stringify([1, 2]);
    const { landed } = await run(archive([file("plan.note", body, { mime: NOTE_MIME })], [body]));
    expect(landed[0].note).toBeNull();
  });

  it("recognises a note whose name the owner renamed, suffix and all", async () => {
    // The bug this replaces. `POST /api/files` appends `.note` when it creates a note, and
    // `PATCH … action=rename` does not put it back, so any note the owner renamed is stored
    // under a name with no suffix. The archive carries that name faithfully — and a decision
    // that read the name sent the note back as a file whose visible content was
    // `{"annotations":null,"content":{"type":"doc",…}}`. The body is what says "note".
    const body = noteBody({ type: "doc" });
    const { landed } = await run(archive([file("isi asli", body, { mime: NOTE_MIME })], [body]));
    expect(landed[0].note).toEqual({ content: { type: "doc" }, annotations: null });
    expect(landed[0].row.mime).toBe(NOTE_MIME);
  });

  it("recognises one under any other extension too", async () => {
    const body = noteBody(null);
    const { landed } = await run(archive([file("plan.json", body, { mime: NOTE_MIME })], [body]));
    expect(landed[0].note).toEqual({ content: null, annotations: null });
  });

  it("still keeps an ordinary JSON file as a file", async () => {
    // The fingerprint is exact, so the ordinary shapes stay ordinary: this is the case the
    // name check used to cover, and the key set covers it now.
    const body = JSON.stringify({ content: "hello", title: "notes.json" });
    const { landed } = await run(archive([file("notes.json", body, { mime: NOTE_MIME })], [body]));
    expect(landed[0].note).toBeNull();
    expect(landed[0].body).toBe(body);
  });

  it("needs the MIME the app gives its own notes", async () => {
    const body = noteBody(null);
    const { landed } = await run(archive([file("plan.note", body)], [body]));
    expect(landed[0].note).toBeNull();
  });

  it("streams a JSON body past the buffering cap as an object instead", async () => {
    const body = " ".repeat(MAX_NOTE_BYTES + 1);
    const { landed, report } = await run(
      archive([file("big.note", body, { mime: NOTE_MIME })], [body])
    );
    expect(landed[0].note).toBeNull();
    expect(landed[0].body).toHaveLength(MAX_NOTE_BYTES + 1);
    expect(report.bytes).toBe(MAX_NOTE_BYTES + 1);
  });
});

/* ── the MIME: downgraded, never a reason to refuse (§11) ─────────────────── */

describe("importFiles: the MIME", () => {
  it("keeps a MIME the instance still allows", async () => {
    const { landed } = await run({
      ...archive([file("a.png", "1", { mime: "image/png" })], ["1"]),
      mimeAllowed: () => true,
    });
    expect(landed[0].row.mime).toBe("image/png");
  });

  it("downgrades a MIME the instance now refuses, and keeps the bytes", async () => {
    const { landed, report } = await run({
      ...archive([file("a.svg", "hi", { mime: "image/svg+xml" })], ["hi"]),
      mimeAllowed: () => false,
    });
    expect(landed[0].row.mime).toBe("application/octet-stream");
    expect(landed[0].body).toBe("hi");
    expect(report).toMatchObject({ rows: 1, skipped: 0 });
  });

  it("downgrades an empty MIME without asking the policy", async () => {
    const asked: string[] = [];
    const { landed } = await run({
      ...archive([file("a.bin", "1", { mime: "" })], ["1"]),
      mimeAllowed: (mime) => {
        asked.push(mime);
        return true;
      },
    });
    expect(landed[0].row.mime).toBe("application/octet-stream");
    expect(asked).toEqual([]);
  });

  it("asks the policy about the name the row will actually carry", async () => {
    const asked: [string, string][] = [];
    await run({
      ...archive([file("a.txt", "new")], ["new"]),
      live: { files: [["a.txt", sha("old")]] },
      mimeAllowed: (mime, name) => {
        asked.push([mime, name]);
        return true;
      },
    });
    expect(asked).toEqual([["text/plain", "a (restored).txt"]]);
  });
});

/* ── the INDEX: shape, order, and its own arithmetic ──────────────────────── */

describe("importFiles: the INDEX", () => {
  it("refuses a folder entry after a file entry", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([file("a.txt", "1"), folder("Photos")], ["1"]))
    );
    expect(error.detail).toBe("index line 2 is a folder entry after a file entry");
  });

  it("refuses folders that go backwards", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([folder("Photos"), folder("Docs")], []))
    );
    expect(error.detail).toBe("index line 2 is out of order");
  });

  it("refuses files that go backwards", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([file("b.txt", "1"), file("a.txt", "2")], ["1", "2"]))
    );
    expect(error.detail).toBe("index line 2 is out of order");
  });

  it("lets the order start over where the file group begins", async () => {
    const { report } = await run(archive([folder("Zips"), file("a.txt", "1")], ["1"]));
    expect(report).toMatchObject({ rows: 2, skipped: 0 });
  });

  it("accepts two entries at one path, since two live rows may share one", async () => {
    const { landed } = await run(
      archive([file("a.txt", "1"), file("a.txt", "2")], ["1", "2"])
    );
    expect(landed.map((one) => one.body)).toEqual(["1", "2"]);
  });

  it("refuses an index that lists fewer files than the summary declared", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        ...archive([file("a.txt", "1")], ["1"]),
        summary: { counts: { folders: 0, files: 2, memories: 0, rows: 2 } },
      })
    );
    expect(error.detail).toBe("index lists 1 files, summary declared 2");
  });

  it("refuses an index that lists fewer folders than the summary declared", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        ...archive([folder("Photos")], []),
        summary: { counts: { folders: 2, files: 0, memories: 0, rows: 2 } },
      })
    );
    expect(error.detail).toBe("index lists 1 folders, summary declared 2");
  });

  it("refuses an index whose sizes do not add up to the declared total", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({ ...archive([file("a.txt", "hi")], ["hi"]), summary: { totalBytes: 99 } })
    );
    expect(error.detail).toBe("index entries total 2 bytes, summary declared 99");
  });

  it("refuses a summary past the file row cap before reading a single line", async () => {
    const error = await caught(AfrTooLargeError, () =>
      run({
        ...archive([], []),
        summary: { counts: { folders: 0, files: 200_001, memories: 0, rows: 200_001 } },
      })
    );
    expect(error.rows).toBe(200_001);
    expect(error.cap).toBe(200_000);
    expect(error.detail).toBe("claims 200001 rows, cap 200000");
  });
});

/* ── the report: the four numbers the audit row and the UI both read ───────── */

describe("importFiles: the report", () => {
  it("counts adopted folders out and created folders in", async () => {
    const { report } = await run({
      ...archive([folder("Docs"), folder("Photos"), file("Photos/a.txt", "hi")], ["hi"]),
      live: { folders: [["Photos", "live-1"]] },
    });
    // Docs created, Photos adopted, one file written: two rows, not three.
    expect(report.rows).toBe(2);
  });

  it("reports every outcome of one mixed merge together", async () => {
    const { report, landed } = await run({
      ...archive(
        [
          folder("Docs"),
          folder("Photos"),
          file("a.txt", "hi"),
          file("b.txt", "new"),
          file("c.txt", "zzz"),
        ],
        ["hi", "new", "zzz"]
      ),
      live: {
        folders: [["Photos", "live-1"]],
        files: [
          ["a.txt", sha("hi")],
          ["b.txt", sha("old")],
        ],
      },
    });
    expect(names(landed)).toEqual(["b (restored).txt", "c.txt"]);
    expect(report).toEqual({
      domain: "files",
      mode: "merge",
      // one folder created, two files written — the skipped one is not a row
      rows: 3,
      // "hi" was skipped, so its two bytes were never charged
      bytes: 6,
      skipped: 1,
      renamed: 1,
    });
  });

  it("carries the archive's own timestamps and digest onto the row", async () => {
    const { landed } = await run(archive([folder("Photos"), file("Photos/a.txt", "hi")], ["hi"]));
    expect(landed[0].row).toEqual({
      folderId: "fld-1",
      name: "a.txt",
      mime: "text/plain",
      size: 2,
      sha256: sha("hi"),
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
  });
});
