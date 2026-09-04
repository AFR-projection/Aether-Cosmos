import { describe, expect, it } from "vitest";
import {
  AFR_MAX_MIME_CHARS,
  AFR_MAX_PATH_CHARS,
  AFR_MAX_PATH_DEPTH,
  INDEX_LINE_TERMINATOR,
  SHA256_BYTES,
  decodeBrainEntry,
  decodeFilesEntry,
  encodeBrainEntry,
  encodeFilesEntry,
  joinArchivePath,
  parseArchivePath,
  type AfrBrainEntry,
  type AfrFileEntry,
  type AfrFolderEntry,
} from "@backup/account/domain/index-entries";
import { AccountBackupError, AfrCorruptError } from "@backup/account/domain/errors";
import { toUnpaddedBase64 } from "@backup/account/domain/canonical";

/**
 * INDEX — the lines that say what an archive holds, and the path validator they carry.
 *
 * The path tests are the important half. `materializedPath` is built by joining a parent
 * to a child name, and every subtree operation in this application — rename, move, trash,
 * restore — selects rows by path prefix. A name holding `/` therefore forges a path, and
 * `tests/materialized-path-prefix.test.ts` closed that bug class once already. What is
 * checked here is that an archive cannot reopen it: the validator runs at the format
 * boundary, before a single statement is built, and it is the same `checkEntityName` the
 * upload path uses.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.3, §11.
 */

const SHA = Buffer.alloc(SHA256_BYTES, 0xab);
const WHERE = "index line 41";

function folder(overrides: Partial<AfrFolderEntry> = {}): AfrFolderEntry {
  return {
    kind: "folder",
    path: "photos/2026",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    ...overrides,
  };
}

function file(overrides: Partial<AfrFileEntry> = {}): AfrFileEntry {
  return {
    kind: "file",
    path: "photos/2026/beach.jpg",
    size: 204_800,
    sha256: SHA,
    mime: "image/jpeg",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    ...overrides,
  };
}

function brain(overrides: Partial<AfrBrainEntry> = {}): AfrBrainEntry {
  return {
    table: "memories",
    rowId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60",
    orderKey: 17,
    ...overrides,
  };
}

/** The reason, which lives in `detail`; `message` is one fixed sentence for every refusal. */
function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBackupError) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal, got a value");
}

/** A line the way the reader hands it over: text, terminator already stripped. */
function line(value: unknown): string {
  return JSON.stringify(value);
}

/** Decoded and narrowed, for the assertions that reach a file-only field. */
function decodeFile(raw: Record<string, unknown>): AfrFileEntry {
  const entry = decodeFilesEntry(line(raw), WHERE);
  if (entry.kind !== "file") {
    throw new Error("expected a file entry");
  }
  return entry;
}

/** The wire form of a files entry, as an object we can then bend out of shape. */
function rawFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { sha256, ...rest } = file();
  return { ...rest, sha256: toUnpaddedBase64(sha256), ...overrides };
}

function rawFolder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...folder(), ...overrides };
}

describe("a path an archive is allowed to name", () => {
  it("takes a plain path apart into its segments", () => {
    expect(parseArchivePath("photos/2026/bali", WHERE)).toEqual(["photos", "2026", "bali"]);
    expect(parseArchivePath("notes.md", WHERE)).toEqual(["notes.md"]);
  });

  it("reads the root as no segments at all", () => {
    // The parent of a top-level entry, which is a real answer rather than a refusal.
    expect(parseArchivePath("", WHERE)).toEqual([]);
    expect(joinArchivePath([])).toBe("");
  });

  it("keeps names in any script, because a name is not a charset", () => {
    const path = "Foto Liburan/2026 — Bali/ünïcode ☂.jpg";

    expect(joinArchivePath(parseArchivePath(path, WHERE))).toBe(path);
  });

  it("refuses an absolute path", () => {
    expect(detailOf(() => parseArchivePath("/photos/2026", WHERE))).toContain(
      "leading or trailing separator"
    );
  });

  it("refuses a trailing separator, which is a second spelling of one path", () => {
    expect(() => parseArchivePath("photos/2026/", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses an empty segment in the middle", () => {
    // `photos//2026` and `photos/2026` would build the same `materializedPath`.
    expect(() => parseArchivePath("photos//2026", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses the relative segments", () => {
    expect(() => parseArchivePath("..", WHERE)).toThrow(AfrCorruptError);
    expect(() => parseArchivePath(".", WHERE)).toThrow(AfrCorruptError);
    expect(() => parseArchivePath("photos/../../etc/passwd", WHERE)).toThrow(AfrCorruptError);
    expect(() => parseArchivePath("photos/./2026", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses a backslash, which is a separator on the platform this is built on", () => {
    expect(detailOf(() => parseArchivePath("photos\\2026", WHERE))).toContain("backslash");
  });

  it("has no way to spell a segment that contains a separator", () => {
    // The forgery this validator exists for cannot be expressed at all: a name holding
    // `/` arrives as two segments, so an importer that creates folders one segment at a
    // time can never produce a folder whose own name contains one.
    expect(parseArchivePath("photos/a/b", WHERE)).toEqual(["photos", "a", "b"]);
    expect(() => parseArchivePath("photos/a\\b", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses control characters and the direction overrides", () => {
    const nul = String.fromCharCode(0);
    const rtlOverride = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);

    expect(() => parseArchivePath(`photos${nul}/2026`, WHERE)).toThrow(AfrCorruptError);
    // Renders as `beach.png` in the file list while being a program.
    expect(() => parseArchivePath(`photos/${rtlOverride}gnp.exe`, WHERE)).toThrow(AfrCorruptError);
    // Two rows that look identical and sort apart.
    expect(() => parseArchivePath(`photos/2026${zeroWidth}`, WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses a trailing dot, which Windows drops on extraction", () => {
    expect(() => parseArchivePath("photos/notes.", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses surrounding whitespace rather than trimming it", () => {
    // The upload path forgives ` notes` and stores `notes`. An archive may not: both
    // spellings would name one folder and compare as two paths.
    expect(detailOf(() => parseArchivePath("photos/ 2026", WHERE))).toContain(
      "surrounding whitespace"
    );
    expect(() => parseArchivePath("photos/2026 ", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses a segment longer than a name may be", () => {
    expect(() => parseArchivePath(`photos/${"x".repeat(256)}`, WHERE)).toThrow(AfrCorruptError);
    expect(() => parseArchivePath(`photos/${"x".repeat(255)}`, WHERE)).not.toThrow();
  });

  it("bounds depth and length, which the database does not", () => {
    const deep = Array.from({ length: AFR_MAX_PATH_DEPTH }, () => "a").join("/");

    expect(() => parseArchivePath(deep, WHERE)).not.toThrow();
    expect(detailOf(() => parseArchivePath(`${deep}/a`, WHERE))).toContain(
      `cap ${AFR_MAX_PATH_DEPTH}`
    );
    const long = `${"x".repeat(200)}/`.repeat(21).slice(0, -1);
    expect(long.length).toBeGreaterThan(AFR_MAX_PATH_CHARS);
    expect(detailOf(() => parseArchivePath(long, WHERE))).toContain(`cap ${AFR_MAX_PATH_CHARS}`);
  });

  it("refuses a path that is not a string", () => {
    for (const value of [null, 42, ["photos"], { path: "photos" }]) {
      expect(() => parseArchivePath(value, WHERE)).toThrow(AfrCorruptError);
    }
  });
});

describe("files: a folder line and a file line", () => {
  it("writes exactly these bytes for a folder", () => {
    expect(encodeFilesEntry(folder()).toString("utf8")).toBe(
      `{"createdAt":1700000000000,"kind":"folder","path":"photos/2026",` +
        `"updatedAt":1700000500000}\n`
    );
  });

  it("writes exactly these bytes for a file", () => {
    expect(encodeFilesEntry(file()).toString("utf8")).toBe(
      `{"createdAt":1700000000000,"kind":"file","mime":"image/jpeg",` +
        `"path":"photos/2026/beach.jpg","sha256":"${toUnpaddedBase64(SHA)}",` +
        `"size":204800,"updatedAt":1700000500000}\n`
    );
  });

  it("round trips both shapes", () => {
    for (const entry of [folder(), file()]) {
      const text = encodeFilesEntry(entry).toString("utf8").slice(0, -1);
      expect(decodeFilesEntry(text, WHERE)).toEqual(entry);
    }
  });

  it("ends every line with the terminator and puts none inside it", () => {
    // NDJSON framing survives hostile content for free: canonical JSON escapes a newline
    // to `\n`, two characters, so no field value can end a line early.
    const bytes = encodeFilesEntry(file({ mime: "text/plain;x=a\nb" }));

    expect(INDEX_LINE_TERMINATOR).toBe("\n");
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
    expect(bytes.filter((byte) => byte === 0x0a)).toHaveLength(1);
  });

  it("carries an empty folder, which is content a backup must not drop", () => {
    // Folders are listed in their own right rather than implied by the files inside them.
    expect(decodeFilesEntry(line(rawFolder({ path: "empty-shelf" })), WHERE).path).toBe(
      "empty-shelf"
    );
  });

  it("refuses a line that is not JSON, or is JSON that is not an object", () => {
    expect(detailOf(() => decodeFilesEntry("{oops", WHERE))).toContain("not JSON");
    expect(detailOf(() => decodeFilesEntry("[]", WHERE))).toContain("not an object");
    expect(() => decodeFilesEntry("null", WHERE)).toThrow(AfrCorruptError);
    expect(() => decodeFilesEntry("42", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses a kind it does not know, before it decides which keys to demand", () => {
    expect(detailOf(() => decodeFilesEntry(line(rawFile({ kind: "symlink" })), WHERE))).toContain(
      "neither folder nor file"
    );
    const noKind = rawFile();
    delete noKind.kind;
    expect(() => decodeFilesEntry(line(noKind), WHERE)).toThrow(AfrCorruptError);
  });

  it("holds each shape to its own key list", () => {
    // A folder line carrying a size is not a folder line with extra information; it is a
    // file line that lost its `kind`, and guessing which one was meant is how a format
    // starts accepting two things as one.
    expect(detailOf(() => decodeFilesEntry(line(rawFile({ kind: "folder" })), WHERE))).toContain(
      "7 keys, expected 4"
    );
    expect(detailOf(() => decodeFilesEntry(line(rawFolder({ kind: "file" })), WHERE))).toContain(
      "4 keys, expected 7"
    );
  });

  it("refuses an unknown field", () => {
    // An extra key is caught by the count, which is the cheaper of the two checks.
    expect(detailOf(() => decodeFilesEntry(line(rawFile({ r2Key: "u/1/abc" })), WHERE))).toContain(
      "8 keys, expected 7"
    );
    // A key swapped for one of ours keeps the count, so the positional compare names it.
    const swapped = rawFile({ r2Key: "u/1/abc" });
    delete swapped.mime;
    expect(detailOf(() => decodeFilesEntry(line(swapped), WHERE))).toContain(
      "is not a field of this format"
    );
  });

  it("names the line it refused, so an operator can find it", () => {
    expect(detailOf(() => decodeFilesEntry(line(rawFile({ size: -1 })), WHERE))).toContain(
      "index line 41"
    );
  });
});

describe("files: fields a stranger filled in", () => {
  it("refuses an entry whose path names nothing", () => {
    // A file with no name, or a folder that is the account root — which already exists.
    expect(detailOf(() => decodeFilesEntry(line(rawFile({ path: "" })), WHERE))).toContain(
      "names nothing"
    );
    expect(() => decodeFilesEntry(line(rawFolder({ path: "" })), WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses a hostile path from inside a real line", () => {
    for (const path of ["/etc/passwd", "a/../../b", "photos\\2026", "photos/", "a//b"]) {
      expect(() => decodeFilesEntry(line(rawFile({ path })), WHERE)).toThrow(AfrCorruptError);
    }
  });

  it("insists the digest is 32 canonical bytes", () => {
    expect(detailOf(() => decodeFilesEntry(line(rawFile({ sha256: "abc" })), WHERE))).toContain(
      "expected 32"
    );
    // Padded base64 is a second spelling of the same bytes, so it is refused too.
    expect(() =>
      decodeFilesEntry(line(rawFile({ sha256: `${toUnpaddedBase64(SHA)}==` })), WHERE)
    ).toThrow(AfrCorruptError);
    expect(() => decodeFilesEntry(line(rawFile({ sha256: 42 })), WHERE)).toThrow(AfrCorruptError);
  });

  it("bounds the mime it was handed and never trusts it", () => {
    expect(() =>
      decodeFilesEntry(line(rawFile({ mime: "x".repeat(AFR_MAX_MIME_CHARS + 1) })), WHERE)
    ).toThrow(AfrCorruptError);
    const nul = String.fromCharCode(0);
    expect(() => decodeFilesEntry(line(rawFile({ mime: `text/${nul}html` })), WHERE)).toThrow(
      AfrCorruptError
    );
    // Nonsense that is merely wrong stays: the importer re-decides `Content-Type` anyway.
    expect(decodeFile(rawFile({ mime: "not/a-real-type" })).mime).toBe("not/a-real-type");
  });

  it("refuses a size that is negative, fractional, or absent", () => {
    for (const size of [-1, 0.5, "204800", null]) {
      expect(() => decodeFilesEntry(line(rawFile({ size })), WHERE)).toThrow(AfrCorruptError);
    }
    expect(decodeFile(rawFile({ size: 0 })).size).toBe(0);
  });

  it("refuses a timestamp of zero or one beyond the year 9999", () => {
    expect(() => decodeFilesEntry(line(rawFile({ createdAt: 0 })), WHERE)).toThrow(AfrCorruptError);
    expect(() =>
      decodeFilesEntry(line(rawFile({ updatedAt: 253_402_300_800_000 })), WHERE)
    ).toThrow(AfrCorruptError);
  });

  it("keeps an updatedAt that precedes createdAt", () => {
    // Two independent column values, not one range: a clock adjustment on the source
    // machine can genuinely leave them out of order, and losing the row over it would be
    // the backup failing at its only job.
    const entry = decodeFilesEntry(
      line(rawFile({ createdAt: 1_700_000_500_000, updatedAt: 1_700_000_000_000 })),
      WHERE
    );

    expect(entry.updatedAt).toBeLessThan(entry.createdAt);
  });
});

describe("brain: a directory of the rows the payload carries", () => {
  it("writes exactly these bytes", () => {
    expect(encodeBrainEntry(brain()).toString("utf8")).toBe(
      `{"orderKey":17,"rowId":"9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60","table":"memories"}\n`
    );
  });

  it("round trips", () => {
    const text = encodeBrainEntry(brain()).toString("utf8").slice(0, -1);

    expect(decodeBrainEntry(text, WHERE)).toEqual(brain());
  });

  it("takes a table name that could only be an identifier", () => {
    // Shape only. Which tables an account backup may carry is policy that moves with the
    // schema, and the importer checks membership against the table descriptor — but
    // nothing that is not a lowercase identifier can reach it.
    expect(decodeBrainEntry(line(brain({ table: "memory_tags" })), WHERE).table).toBe(
      "memory_tags"
    );
    for (const table of ["Memories", "memories; drop table users", "", "1memories", "x".repeat(64)]) {
      expect(() => decodeBrainEntry(line(brain({ table })), WHERE)).toThrow(AfrCorruptError);
    }
  });

  it("treats the row id as an opaque label, because it is remapped anyway", () => {
    // It is a key in the mapping table the importer builds, never an id it inserts.
    for (const rowId of ["9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60", "V1StGXR8_Z5jdHi6B", "40721"]) {
      expect(decodeBrainEntry(line(brain({ rowId })), WHERE).rowId).toBe(rowId);
    }
    for (const rowId of ["", "../../etc", "a b", "x".repeat(65)]) {
      expect(() => decodeBrainEntry(line(brain({ rowId })), WHERE)).toThrow(AfrCorruptError);
    }
  });

  it("refuses an order key that is negative or fractional", () => {
    expect(decodeBrainEntry(line(brain({ orderKey: 0 })), WHERE).orderKey).toBe(0);
    for (const orderKey of [-1, 1.5, "17"]) {
      expect(() => decodeBrainEntry(line({ ...brain(), orderKey }), WHERE)).toThrow(
        AfrCorruptError
      );
    }
  });

  it("refuses a line with a field missing or one too many", () => {
    const extra = { ...brain(), userId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60" };
    expect(detailOf(() => decodeBrainEntry(line(extra), WHERE))).toContain("4 keys, expected 3");
    const missing: Record<string, unknown> = { ...brain() };
    delete missing.orderKey;
    expect(() => decodeBrainEntry(line(missing), WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses a line that is not JSON, or is JSON that is not an object", () => {
    expect(detailOf(() => decodeBrainEntry("{oops", WHERE))).toContain("not JSON");
    expect(() => decodeBrainEntry("[]", WHERE)).toThrow(AfrCorruptError);
  });
});
