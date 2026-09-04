/**
 * The exporter, over fake sources: what an archive commits to, and what it refuses.
 *
 * No database, no bucket, no network. Both ports of `export-types.ts` are small enough to
 * fake completely, which is the point of their existing — everything that decides *what an
 * archive says* is pure code over those two interfaces, and this suite is where that code
 * is held to it.
 *
 * Three properties carry the files half.
 *
 * **The INDEX is a promise the payload keeps.** The round-trip cases drive the plan through
 * `buildAccountArchive` and read it back with the real reader, so the assertion is not "the
 * exporter produced some bytes" but "the entries the reader hands back describe, byte for
 * byte, the payload it also hands back".
 *
 * **The account is allowed to change, and then the download dies.** A note rewritten, an
 * object replaced, a row deleted between the measuring pass and the streaming pass — each
 * one is an `AccountBackupChangedError` rather than an archive whose table of contents
 * lies. These are the tests that make "quietly wrong" unrepresentable.
 *
 * **Every refusal is chosen, not defaulted.** A missing object at measure time is refused
 * by name and never retried; the same object vanishing at stream time says "try again"; an
 * unusable MIME type is downgraded rather than refused; a name the format cannot spell
 * refuses the whole export. Each of those is a decision recorded in the design, and each
 * has a case here.
 *
 * The brain half is the same shape around one extra invariant: `orderKey` is archive-wide
 * and ascending in rank order, which is the only reason an importer can insert a link
 * without knowing the schema's dependency graph at read time.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §11.
 */

import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openArchive, type AfrWriteReport } from "@backup/account/domain/archive";
import {
  AccountBackupBadNameError,
  AccountBackupChangedError,
  AccountBackupEncryptedFilesError,
  AccountBackupFileUnreadableError,
  AccountBackupTooBigError,
} from "@backup/account/domain/errors";
import { MIN_CHUNK_SIZE } from "@backup/account/domain/format";
import { formatAccountBackupId, newAccountBackupId } from "@backup/account/domain/identity";
import {
  decodeBrainEntry,
  decodeFilesEntry,
  type AfrFileEntry,
  type AfrFilesEntry,
} from "@backup/account/domain/index-entries";
import {
  newPhraseSalt,
  parseMasterKeyRing,
  type AfrKeyRing,
} from "@backup/account/domain/keys";
import { rowJsonBytes, rowJsonString, type RowValue } from "@backup/account/domain/row-json";
import { AFR_FOLDER_ROW_CAP } from "@backup/account/domain/summary";
import { accountTables, type AccountTable } from "@backup/account/domain/tables";
import { planBrainExport } from "@backup/account/application/export-brain";
import { planFilesExport } from "@backup/account/application/export-files";
import {
  AFRBAK_EXTENSION,
  accountArchiveFilename,
  buildAccountArchive,
  sourceInstanceId,
  type AccountArchiveKeys,
} from "@backup/account/application/export";
import type {
  AccountExportPlan,
  BrainExportSource,
  ExportFileRow,
  ExportFolderRow,
  FilesExportSource,
} from "@backup/account/application/export-types";

/* ── the two ports, faked ─────────────────────────────────────────────────── */

/**
 * A files source held entirely in memory, and countable.
 *
 * The read counters are not decoration: the design promises the row lists are read *once*
 * and the bodies twice, which is what keeps the memory profile flat in the number of files
 * while still letting the second pass check the first. A regression that starts re-querying
 * the folder list per file would pass every other assertion in this suite.
 *
 * `null` in {@link objects} is an object the bucket does not have — the inconsistency
 * `AccountBackupFileUnreadableError` exists for — and a key with no entry at all is a
 * mistake in the fixture, which throws something the exporter must not catch.
 */
class FakeFilesSource implements FilesExportSource {
  folderRows: ExportFolderRow[] = [];
  fileRows: ExportFileRow[] = [];
  readonly objects = new Map<string, Buffer | null>();
  readonly notes = new Map<string, { annotations: RowValue; content: RowValue }>();
  folderReads = 0;
  fileReads = 0;
  objectReads = 0;
  noteReads = 0;

  async *folders(): AsyncIterable<ExportFolderRow> {
    this.folderReads += 1;
    for (const row of this.folderRows) yield row;
  }

  async *files(): AsyncIterable<ExportFileRow> {
    this.fileReads += 1;
    for (const row of this.fileRows) yield row;
  }

  async *openObject(r2Key: string): AsyncIterable<Uint8Array> {
    this.objectReads += 1;
    const body = this.objects.get(r2Key);
    if (body === undefined) throw new Error(`no fixture for ${r2Key}`);
    if (body === null) {
      throw new AccountBackupFileUnreadableError(null, `r2 object ${r2Key} is missing`);
    }
    yield body;
  }

  async noteBody(fileId: string): Promise<Buffer> {
    this.noteReads += 1;
    const note = this.notes.get(fileId) ?? { annotations: null, content: null };
    return rowJsonBytes({ annotations: note.annotations, content: note.content });
  }
}

/**
 * A brain source that answers from a map keyed by table name.
 *
 * `reads` records the order tables were asked for, which is how the rank-order invariant is
 * checked from the outside rather than inferred from the INDEX it produced.
 */
class FakeBrainSource implements BrainExportSource {
  readonly data = new Map<string, Record<string, unknown>[]>();
  reads: string[] = [];

  async *rows(table: AccountTable): AsyncIterable<Record<string, unknown>> {
    this.reads.push(table.name);
    for (const row of this.data.get(table.name) ?? []) yield row;
  }

  put(table: string, rows: Record<string, unknown>[]): void {
    this.data.set(table, rows);
  }
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** Timestamps far enough apart that a `dateRange` assertion means something. */
const CREATED = 1_700_000_000_000;
const UPDATED = 1_700_000_500_000;

function folderRow(path: string, over: Partial<ExportFolderRow> = {}): ExportFolderRow {
  return { path, createdAt: CREATED, updatedAt: UPDATED, ...over };
}

function fileRow(path: string, over: Partial<ExportFileRow> = {}): ExportFileRow {
  return {
    id: `id:${path}`,
    path,
    mime: "image/jpeg",
    createdAt: CREATED,
    updatedAt: UPDATED,
    encrypted: false,
    body: { kind: "object", r2Key: `r2/${path}` },
    ...over,
  };
}

/** A file plus the bytes the fake bucket will hand back for it. */
function addFile(
  source: FakeFilesSource,
  path: string,
  bytes: Buffer | null,
  over: Partial<ExportFileRow> = {}
): ExportFileRow {
  const row = fileRow(path, over);
  source.fileRows.push(row);
  if (row.body.kind === "object") source.objects.set(row.body.r2Key, bytes);
  return row;
}

/** A note, whose body lives in `file_contents` rather than in the bucket. */
function addNote(
  source: FakeFilesSource,
  path: string,
  body: { annotations: RowValue; content: RowValue },
  over: Partial<ExportFileRow> = {}
): ExportFileRow {
  const row = fileRow(path, { mime: "application/json", body: { kind: "note" }, ...over });
  source.fileRows.push(row);
  source.notes.set(row.id, body);
  return row;
}

/** The r2 key of a row the fixtures created, so a test can make its object vanish. */
function keyOf(row: ExportFileRow): string {
  if (row.body.kind !== "object") throw new Error(`${row.path} is a note`);
  return row.body.r2Key;
}

type Ctor<T> = new (...args: never[]) => T;

/** The refusal itself, so a case can read `detail` off it and not just its class. */
async function caught<T>(kind: Ctor<T>, run: () => Promise<unknown>): Promise<T> {
  try {
    await run();
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error(`expected ${kind.name}, got a value`);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/** The payload the plan produces, which is what drives the second pass. */
async function drainPayload(plan: AccountExportPlan): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of plan.payload()) parts.push(Buffer.from(piece));
  return Buffer.concat(parts);
}

/** NDJSON, terminator stripped, the way the archive's own reader hands lines back. */
function indexLines(index: Buffer): string[] {
  const text = index.toString("utf8");
  return text.length === 0 ? [] : text.slice(0, -1).split("\n");
}

function filesEntries(index: Buffer): AfrFilesEntry[] {
  return indexLines(index).map((line, at) => decodeFilesEntry(line, `index line ${at + 1}`));
}

function fileEntriesOf(index: Buffer): AfrFileEntry[] {
  return filesEntries(index).filter((entry): entry is AfrFileEntry => entry.kind === "file");
}

/**
 * A ring, and the three secrets an archive is sealed with.
 *
 * The recovery wrapping key is random rather than derived: nothing in this suite opens an
 * archive by phrase, so an Argon2 pass would buy an assertion that
 * `tests/backup-account-archive.test.ts` already makes and cost a second per case.
 */
function archiveKeys(): { ring: AfrKeyRing; keys: AccountArchiveKeys } {
  const masterKey = randomBytes(32);
  const ring = parseMasterKeyRing({ BACKUP_MASTER_KEY: masterKey.toString("base64") });
  return {
    ring,
    keys: {
      masterKey: ring.active,
      recoveryWrappingKey: randomBytes(32),
      phraseSalt: newPhraseSalt(),
    },
  };
}

/** The writer's report is the generator's *return* value, which `for await` discards. */
async function drainArchive(
  gen: AsyncGenerator<Buffer, AfrWriteReport, void>
): Promise<{ bytes: Buffer; report: AfrWriteReport }> {
  const out: Buffer[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { bytes: Buffer.concat(out), report: step.value };
    out.push(step.value);
  }
}

/** Plan → archive → the real reader, which is the only honest check of an INDEX. */
async function roundTrip(plan: AccountExportPlan, accountBackupId = newAccountBackupId()) {
  const { ring, keys } = archiveKeys();
  const archive = buildAccountArchive({
    plan,
    identity: { accountBackupId, email: "arsip@example.test" },
    keys,
    chunkSize: MIN_CHUNK_SIZE,
  });
  const { bytes, report } = await drainArchive(archive.bytes());
  const reader = await openArchive({ source: [bytes], ring, expectedDomain: plan.domain });
  const lines = await collect(reader.indexLines());
  const chunks = await collect(reader.readPayload());
  const trailer = await reader.finish();
  return {
    archive,
    bytes,
    report,
    trailer,
    lines,
    payload: Buffer.concat(chunks),
    summary: reader.summary,
  };
}

describe("the files export, measured", () => {
  it("counts folders and files, sums the bytes, and spans their timestamps", async () => {
    const source = new FakeFilesSource();
    source.folderRows.push(folderRow("photos"), folderRow("photos/2026"));
    addFile(source, "photos/2026/beach.jpg", Buffer.from("beach bytes"), {
      createdAt: CREATED - 1000,
    });
    addFile(source, "notes.txt", Buffer.from("hi"), { updatedAt: UPDATED + 1000 });

    const plan = await planFilesExport(source);

    expect(plan.domain).toBe("files");
    expect(plan.counts).toEqual({ folders: 2, files: 2, memories: 0, rows: 4 });
    expect(plan.totalBytes).toBe("beach bytes".length + "hi".length);
    expect(plan.dateRange).toEqual({ from: CREATED - 1000, to: UPDATED + 1000 });
    // The row lists once, the bodies once per pass. This is the memory promise of §6.3.
    expect(source.folderReads).toBe(1);
    expect(source.fileReads).toBe(1);
    expect(source.objectReads).toBe(2);
  });

  it("lists every folder before any file, each in path order", async () => {
    const source = new FakeFilesSource();
    source.folderRows.push(folderRow("zebra"), folderRow("apple"), folderRow("apple/core"));
    addFile(source, "zebra/z.txt", Buffer.from("z"));
    addFile(source, "apple/a.txt", Buffer.from("a"));

    const entries = filesEntries((await planFilesExport(source)).index);

    // Sorting by path is also what puts a parent ahead of its children, a prefix being
    // shorter than what extends it — which is what the importer's folder walk relies on.
    expect(entries.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
      "folder apple",
      "folder apple/core",
      "folder zebra",
      "file apple/a.txt",
      "file zebra/z.txt",
    ]);
  });

  it("declares the size and digest it observed, not what a row claimed", async () => {
    const source = new FakeFilesSource();
    const bytes = Buffer.from("delapan belas bita");
    addFile(source, "doc.bin", bytes, { mime: "application/pdf" });

    const [entry] = fileEntriesOf((await planFilesExport(source)).index);

    expect(entry.size).toBe(bytes.length);
    expect(entry.sha256).toEqual(createHash("sha256").update(bytes).digest());
    expect(entry.mime).toBe("application/pdf");
    expect(entry.createdAt).toBe(CREATED);
    expect(entry.updatedAt).toBe(UPDATED);
  });

  it("carries a note's body as the bytes of {annotations, content}", async () => {
    const source = new FakeFilesSource();
    const body: { annotations: RowValue; content: RowValue } = {
      annotations: null,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    };
    addNote(source, "ide.md", body);

    const plan = await planFilesExport(source);
    const expected = rowJsonBytes({ annotations: body.annotations, content: body.content });
    const [entry] = fileEntriesOf(plan.index);

    expect(plan.totalBytes).toBe(expected.length);
    expect(await drainPayload(plan)).toEqual(expected);
    expect(entry.size).toBe(expected.length);
    expect(entry.sha256).toEqual(createHash("sha256").update(expected).digest());
    expect(source.noteReads).toBe(2);
    expect(source.objectReads).toBe(0);
  });

  it("keeps an empty note's digest a fixed value rather than a shape", async () => {
    const source = new FakeFilesSource();
    // No `file_contents` row at all: the file exists and its body is nothing.
    const row = fileRow("kosong.md", { body: { kind: "note" } });
    source.fileRows.push(row);

    const plan = await planFilesExport(source);

    expect((await drainPayload(plan)).toString("utf8")).toBe(
      rowJsonString({ annotations: null, content: null })
    );
  });

  it("downgrades a MIME type it cannot spell instead of refusing the account", async () => {
    const source = new FakeFilesSource();
    addFile(source, "a.bin", Buffer.from("a"), { mime: "" });
    addFile(source, "b.bin", Buffer.from("b"), { mime: "x".repeat(256) });
    addFile(source, "c.bin", Buffer.from("c"), {
      mime: `image/${String.fromCharCode(0x200b)}png`,
    });
    addFile(source, "d.bin", Buffer.from("d"), { mime: "image/png" });

    const entries = fileEntriesOf((await planFilesExport(source)).index);

    // A MIME type is a guess the upload path made and the importer re-decides it anyway;
    // refusing a whole backup over a header nobody reads would be the wrong trade.
    expect(entries.map((entry) => entry.mime)).toEqual([
      "application/octet-stream",
      "application/octet-stream",
      "application/octet-stream",
      "image/png",
    ]);
  });

  it("replaces a timestamp the format cannot carry with the moment of export", async () => {
    const source = new FakeFilesSource();
    source.folderRows.push(folderRow("aneh", { createdAt: 0, updatedAt: 4e15 }));
    addFile(source, "aneh/x.bin", Buffer.from("x"), { createdAt: -5, updatedAt: 1.5 });

    const before = Date.now();
    const entries = filesEntries((await planFilesExport(source)).index);
    const after = Date.now();

    for (const entry of entries) {
      expect(entry.createdAt).toBeGreaterThanOrEqual(before);
      expect(entry.createdAt).toBeLessThanOrEqual(after);
      expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
      expect(entry.updatedAt).toBeLessThanOrEqual(after);
    }
  });

  it("says nothing about a date range for an account with nothing in it", async () => {
    const plan = await planFilesExport(new FakeFilesSource());

    expect(plan.counts).toEqual({ folders: 0, files: 0, memories: 0, rows: 0 });
    expect(plan.dateRange).toBeUndefined();
    expect(plan.index.length).toBe(0);
    expect(plan.totalBytes).toBe(0);
  });
});

describe("the files export, round tripped through a real archive", () => {
  it("hands back an index that describes the payload it carries", async () => {
    const source = new FakeFilesSource();
    source.folderRows.push(folderRow("photos"));
    const bodies = [Buffer.from("the first body"), Buffer.from("the second body, longer")];
    addFile(source, "photos/a.bin", bodies[0]);
    addFile(source, "photos/b.bin", bodies[1]);

    const plan = await planFilesExport(source);
    const trip = await roundTrip(plan);
    const entries = trip.lines.map((line) => decodeFilesEntry(line.text, line.where));

    expect(entries.map((entry) => entry.path)).toEqual([
      "photos",
      "photos/a.bin",
      "photos/b.bin",
    ]);
    expect(trip.payload).toEqual(Buffer.concat(bodies));
    // The trailer is written from what actually went past, so this equality is the whole
    // claim: the SUMMARY's `totalBytes` was not a guess the payload then contradicted.
    expect(trip.trailer.totalPlaintextBytes).toBe(plan.totalBytes);
    expect(trip.trailer.payloadSha256).toEqual(
      createHash("sha256").update(Buffer.concat(bodies)).digest()
    );
    expect(source.objectReads).toBe(4);
  });

  it("builds the summary from the plan, and the identity from the account's own row", async () => {
    const source = new FakeFilesSource();
    source.folderRows.push(folderRow("satu"));
    addFile(source, "satu/a.bin", Buffer.from("aa"));

    const plan = await planFilesExport(source);
    const canonical = newAccountBackupId();
    // Handed the display spelling on purpose: the archive carries one canonical form, or
    // two spellings of one identity would compare as two accounts on the way back in.
    const trip = await roundTrip(plan, formatAccountBackupId(canonical));

    expect(trip.archive.summary.accountBackupId).toBe(canonical);
    expect(trip.archive.summary.counts).toEqual(plan.counts);
    expect(trip.archive.summary.totalBytes).toBe(plan.totalBytes);
    expect(trip.archive.summary.dateRange).toEqual(plan.dateRange);
    expect(trip.archive.summary.email).toBe("arsip@example.test");
    expect(trip.archive.domain).toBe("files");
    // What the reader decrypted out of the SUMMARY region, not what the builder returned.
    expect(trip.summary).toEqual(trip.archive.summary);
  });
});

describe("the files export, refusing", () => {
  it("names how many files the browser holds the keys to, and stops", async () => {
    const source = new FakeFilesSource();
    addFile(source, "ok.txt", Buffer.from("ok"));
    addFile(source, "secret-1.bin", Buffer.from("x"), { encrypted: true });
    addFile(source, "secret-2.bin", Buffer.from("x"), { encrypted: true });

    const error = await caught(AccountBackupEncryptedFilesError, () => planFilesExport(source));

    expect(error.count).toBe(2);
    expect(error.status).toBe(409);
    expect(error.code).toBe("AFRBAK_ENCRYPTED_FILES");
    expect(error.message).toContain("2 client-side encrypted files");
    // Counted rather than refused on the first one — and refused before a byte was hashed.
    expect(source.objectReads).toBe(0);
  });

  it("refuses a name this format has no way to spell", async () => {
    const cases: [string, string][] = [
      ["photos/ 2026/a.bin", "surrounding whitespace"],
      ["photos/../a.bin", "rejected"],
      ["photos//a.bin", "rejected"],
      ["/photos/a.bin", "leading or trailing separator"],
      ["photos\\a.bin", "backslash"],
      ["", "names nothing"],
    ];

    for (const [path, expected] of cases) {
      const source = new FakeFilesSource();
      addFile(source, path, Buffer.from("x"));

      const error = await caught(AccountBackupBadNameError, () => planFilesExport(source));

      expect(error.code).toBe("AFRBAK_BAD_NAME");
      expect(error.status).toBe(409);
      expect(error.detail).toContain(expected);
      expect(error.detail.startsWith("file:")).toBe(true);
    }
  });

  it("refuses a live row whose bytes the bucket does not have, and names the file", async () => {
    const source = new FakeFilesSource();
    addFile(source, "docs/report.pdf", null);

    const error = await caught(AccountBackupFileUnreadableError, () => planFilesExport(source));

    expect(error.code).toBe("AFRBAK_FILE_UNREADABLE");
    expect(error.status).toBe(409);
    // The label the user can act on, with `/` flattened by `safeLabel`.
    expect(error.message).toContain("docs?report.pdf");
    // The r2 key stays in `detail`, which no response carries.
    expect(error.detail).toBe("r2 object r2/docs/report.pdf is missing");
  });

  it("refuses an account with more folders than the format admits", async () => {
    const source = new FakeFilesSource();
    // One over the cap, single-segment paths so the validator is the cheap branch.
    for (let index = 0; index <= AFR_FOLDER_ROW_CAP; index += 1) {
      source.folderRows.push(folderRow(`f${index}`));
    }

    const error = await caught(AccountBackupTooBigError, () => planFilesExport(source));

    expect(error.code).toBe("AFRBAK_ACCOUNT_TOO_BIG");
    expect(error.status).toBe(413);
    expect(error.detail).toBe(`more than ${AFR_FOLDER_ROW_CAP} folders`);
  });
});

describe("the files export, when the account changes underneath it", () => {
  it("dies rather than send bytes the index does not describe", async () => {
    const source = new FakeFilesSource();
    const row = addFile(source, "a.bin", Buffer.from("original"));

    const plan = await planFilesExport(source);
    // Same length, different bytes: the size check passes and only the digest catches it,
    // which is the case a size-only comparison would have shipped.
    source.objects.set(keyOf(row), Buffer.from("rewritten".slice(0, 8)));

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    expect(error.code).toBe("AFRBAK_CHANGED");
    expect(error.status).toBe(409);
    expect(error.detail).toBe("a.bin changed while streaming");
  });

  it("says how many bytes it promised when the length is what moved", async () => {
    const source = new FakeFilesSource();
    const row = addFile(source, "a.bin", Buffer.from("original"));

    const plan = await planFilesExport(source);
    source.objects.set(keyOf(row), Buffer.from("short"));

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    expect(error.detail).toBe("a.bin was 8 bytes, streamed 5");
  });

  it("turns a file that left storage mid-stream into try-again, not rename-it", async () => {
    const source = new FakeFilesSource();
    const row = addFile(source, "gone.bin", Buffer.from("here"));

    const plan = await planFilesExport(source);
    source.objects.set(keyOf(row), null);

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    // Readable when the INDEX was built, gone now: `AFRBAK_CHANGED`, whose advice is the
    // correct advice, rather than the permanent `AFRBAK_FILE_UNREADABLE` of pass one.
    expect(error.detail).toBe("gone.bin left storage while streaming");
  });

  it("catches a note whose body was rewritten between the two passes", async () => {
    const source = new FakeFilesSource();
    const row = addNote(source, "n.md", { annotations: null, content: { text: "before" } });

    const plan = await planFilesExport(source);
    source.notes.set(row.id, { annotations: null, content: { text: "afterxx" } });

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    expect(error.code).toBe("AFRBAK_CHANGED");
    expect(error.detail).toContain("n.md");
  });
});

describe("the archive envelope", () => {
  it("names the download by domain and UTC day", () => {
    // 14:49 UTC on the 3rd, which is already the 4th in Jakarta: the name is derived from
    // `compactTimestamp`, which is UTC, so it is the same string on every machine.
    const at = Date.UTC(2026, 8, 3, 14, 49, 12, 345);
    expect(accountArchiveFilename("files", at)).toBe("afr-files-20260903.afrbak");
    expect(accountArchiveFilename("brain", at)).toBe("afr-brain-20260903.afrbak");
    expect(AFRBAK_EXTENSION).toBe(".afrbak");
  });

  it("labels the instance with the public hostname, or localhost when there is none", () => {
    const before = {
      publicUrl: process.env.NEXT_PUBLIC_APP_URL,
      appUrl: process.env.APP_PUBLIC_URL,
    };
    const restore = (key: "NEXT_PUBLIC_APP_URL" | "APP_PUBLIC_URL", value?: string): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    try {
      delete process.env.APP_PUBLIC_URL;
      process.env.NEXT_PUBLIC_APP_URL = "https://mindvault.dataku.id/";
      expect(sourceInstanceId()).toBe("mindvault.dataku.id");

      // Audit metadata, never a gate — so an unusable value is a label, not a refusal.
      process.env.NEXT_PUBLIC_APP_URL = "mindvault dataku id";
      expect(sourceInstanceId()).toBe("localhost");

      delete process.env.NEXT_PUBLIC_APP_URL;
      expect(sourceInstanceId()).toBe("localhost");
    } finally {
      restore("NEXT_PUBLIC_APP_URL", before.publicUrl);
      restore("APP_PUBLIC_URL", before.appUrl);
    }
  });
});

/* ── brain ────────────────────────────────────────────────────────────────── */

function brainEntries(index: Buffer) {
  return indexLines(index).map((line, at) => decodeBrainEntry(line, `index line ${at + 1}`));
}

/** The payload, one NDJSON line per row, in the order the walk emitted them. */
function payloadLines(payload: Buffer): string[] {
  const text = payload.toString("utf8");
  return text.length === 0 ? [] : text.slice(0, -1).split("\n");
}

/** A minimal `brains` row: the columns the descriptor carries and nothing else. */
function brainsRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    owner_user_id: "user-source",
    name: `Otak ${id}`,
    description: null,
    is_default: true,
    status: "active",
    created_at: new Date(CREATED),
    updated_at: new Date(UPDATED),
    ...over,
  };
}

function memoryRow(
  id: string,
  brainId: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    brain_id: brainId,
    type: "fact",
    title: `Judul ${id}`,
    content: "Isi memori",
    created_by: "user-source",
    created_at: new Date(CREATED),
    updated_at: new Date(UPDATED),
    ...over,
  };
}

/** One brain, one memory: the smallest fixture in which every rank is exercised. */
function tinyBrain(): FakeBrainSource {
  const source = new FakeBrainSource();
  source.put("brains", [brainsRow("brain-1")]);
  source.put("memories", [memoryRow("mem-1", "brain-1")]);
  return source;
}

describe("the brain export, measured", () => {
  it("reads every table in rank order, once per pass", async () => {
    const source = tinyBrain();
    const plan = await planBrainExport(source);

    const ranked = accountTables("brain").map((table) => table.name);
    // Every table, including the empty ones: the walk asks, the source answers nothing.
    expect(source.reads).toEqual(ranked);

    await drainPayload(plan);
    expect(source.reads).toEqual([...ranked, ...ranked]);
  });

  it("stamps one archive-wide ascending orderKey, not one per table", async () => {
    const source = new FakeBrainSource();
    source.put("brains", [brainsRow("brain-1")]);
    source.put("memories", [memoryRow("mem-1", "brain-1"), memoryRow("mem-2", "brain-1")]);
    source.put("memory_tags", [
      { id: "tag-1", brain_id: "brain-1", name: "penting", created_at: new Date(CREATED) },
    ]);
    source.put("memory_tag_map", [{ memory_id: "mem-1", tag_id: "tag-1" }]);

    const plan = await planBrainExport(source);
    const entries = brainEntries(plan.index);

    expect(entries.map((entry) => entry.table)).toEqual([
      "brains",
      "memories",
      "memories",
      "memory_tags",
      "memory_tag_map",
    ]);
    expect(entries.map((entry) => entry.orderKey)).toEqual([0, 1, 2, 3, 4]);
    // The one table with no id of its own is named by its position, which nothing
    // references — so the label only has to be unique, and a counter is.
    expect(entries[4].rowId).toBe("4");
    expect(entries.slice(0, 4).map((entry) => entry.rowId)).toEqual([
      "brain-1",
      "mem-1",
      "mem-2",
      "tag-1",
    ]);
  });

  it("counts memories apart from rows, and measures the payload it will send", async () => {
    const source = tinyBrain();
    source.put("memories", [
      memoryRow("mem-1", "brain-1"),
      memoryRow("mem-2", "brain-1", { created_at: new Date(CREATED - 60_000) }),
    ]);

    const plan = await planBrainExport(source);
    const payload = await drainPayload(plan);

    expect(plan.domain).toBe("brain");
    expect(plan.counts).toEqual({ folders: 0, files: 0, memories: 2, rows: 3 });
    expect(plan.dateRange).toEqual({ from: CREATED - 60_000, to: UPDATED });
    // Measured from the lines the first pass built, so the equality is the proof that the
    // SUMMARY's `totalBytes` is not a number the payload then contradicted.
    expect(plan.totalBytes).toBe(payload.length);
    expect(payloadLines(payload)).toHaveLength(3);
  });

  it("writes a row as exactly the columns the descriptor carries", async () => {
    const source = tinyBrain();
    source.put("memories", [
      memoryRow("mem-1", "brain-1", {
        // Present in the row and absent from the archive: `drop` and `owner` rules.
        embedding: [0.1, 0.2],
        embedding_model: "text-embedding-3-small",
        search_vector: "isi:1",
        deleted_at: null,
      }),
    ]);
    const plan = await planBrainExport(source);
    const lines = payloadLines(await drainPayload(plan));

    expect(lines[0]).toBe(
      rowJsonString({
        created_at: CREATED,
        description: null,
        id: "brain-1",
        name: "Otak brain-1",
        status: "active",
        updated_at: UPDATED,
      })
    );
    // `created_by` is `owner` and `deleted_at` is `server`, so neither appears; the three
    // nullable refs do appear, as null, because "not filed under a project" is a fact.
    expect(lines[1]).toBe(
      rowJsonString({
        brain_id: "brain-1",
        content: "Isi memori",
        created_at: CREATED,
        created_by_agent: null,
        id: "mem-1",
        project_id: null,
        superseded_by_id: null,
        title: "Judul mem-1",
        type: "fact",
        updated_at: UPDATED,
      })
    );
    // The source user id is what an archive must never carry: it means nothing in a
    // rebuilt database and authorship collapses onto whoever restores.
    expect(lines[1]).not.toContain("user-source");
    expect(lines[1]).not.toContain("embedding");
  });

  it("drops a row whose required target is absent, and cascades to what hung off it", async () => {
    const source = tinyBrain();
    source.put("memories", [
      memoryRow("mem-1", "brain-1"),
      // A memory of a brain this archive does not carry — another account's, or a row
      // the scope query already excluded.
      memoryRow("mem-orphan", "brain-9"),
    ]);
    source.put("memory_versions", [
      { id: "ver-1", memory_id: "mem-1", version_number: 1, created_at: new Date(CREATED) },
      { id: "ver-orphan", memory_id: "mem-orphan", version_number: 1 },
    ]);

    const plan = await planBrainExport(source);
    const entries = brainEntries(plan.index);

    // The version discovers its own target is missing, one rank later. No graph walk.
    expect(entries.map((entry) => `${entry.table}/${entry.rowId}`)).toEqual([
      "brains/brain-1",
      "memories/mem-1",
      "memory_versions/ver-1",
    ]);
    expect(plan.counts).toEqual({ folders: 0, files: 0, memories: 1, rows: 3 });
  });

  it("nulls an optional target that is missing instead of losing the row", async () => {
    const source = tinyBrain();
    source.put("memories", [
      memoryRow("mem-1", "brain-1", { project_id: "proj-99", created_by_agent: "agent-99" }),
    ]);

    const plan = await planBrainExport(source);
    const line = payloadLines(await drainPayload(plan))[1];

    // "This memory was filed under a project" is information a restore may lose; the
    // memory itself is not.
    expect(JSON.parse(line)).toMatchObject({
      id: "mem-1",
      project_id: null,
      created_by_agent: null,
    });
    expect(brainEntries(plan.index)).toHaveLength(2);
  });

  it("carries the one self-reference verbatim, forwards and dangling alike", async () => {
    const source = tinyBrain();
    source.put("memories", [
      // Points at a row three lines further on, which no streaming check could resolve.
      memoryRow("mem-1", "brain-1", { superseded_by_id: "mem-2" }),
      memoryRow("mem-2", "brain-1", { superseded_by_id: "mem-99" }),
    ]);

    const plan = await planBrainExport(source);
    const lines = payloadLines(await drainPayload(plan));

    expect(JSON.parse(lines[1]).superseded_by_id).toBe("mem-2");
    // Dangling on purpose: the importer's second pass resolves it or nulls it, and
    // refusing here would lose a memory over a pointer.
    expect(JSON.parse(lines[2]).superseded_by_id).toBe("mem-99");
  });

  it("treats a row it cannot name as a bug in this code, not a refusal for the user", async () => {
    const source = new FakeBrainSource();
    source.put("brains", [brainsRow("brain 1")]);

    // A plain Error: our own tables hold uuids, so this cannot come from real data.
    await expect(planBrainExport(source)).rejects.toThrow("brains.id is not a usable row id");
  });
});

/** The byte offset the payload pass reaches after `count` index lines. */
function indexOffset(index: Buffer, count: number): number {
  return indexLines(index)
    .slice(0, count)
    .reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
}

describe("the brain export, when the account changes underneath it", () => {
  it("catches a row that vanished between the two passes, at the byte it should have been", async () => {
    const source = tinyBrain();
    source.put("brains", [brainsRow("brain-1"), brainsRow("brain-2")]);

    const plan = await planBrainExport(source);
    source.put("brains", [brainsRow("brain-1")]);

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    // The next line the walk derives is a memory's, where the index promised a brain's.
    expect(error.detail).toBe(
      `memories diverged from the index at byte ${indexOffset(plan.index, 1)}`
    );
  });

  it("catches a row that appeared between the two passes", async () => {
    const source = tinyBrain();

    const plan = await planBrainExport(source);
    source.put("brains", [brainsRow("brain-1"), brainsRow("brain-2")]);

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    expect(error.detail).toBe(
      `brains diverged from the index at byte ${indexOffset(plan.index, 1)}`
    );
  });

  it("catches a walk that ended early, which no per-line comparison would", async () => {
    const source = tinyBrain();
    source.put("memories", [memoryRow("mem-1", "brain-1"), memoryRow("mem-2", "brain-1")]);

    const plan = await planBrainExport(source);
    // The last row: every line the second pass produces matches, and only the total does not.
    source.put("memories", [memoryRow("mem-1", "brain-1")]);

    const error = await caught(AccountBackupChangedError, () => drainPayload(plan));

    expect(error.detail).toBe(
      `index holds ${plan.index.length} bytes, the payload pass produced ` +
        `${indexOffset(plan.index, 2)}`
    );
  });
});

describe("the brain export, round tripped through a real archive", () => {
  it("seals a brain archive that reads back as the rows it measured", async () => {
    const source = tinyBrain();
    source.put("brain_agents", [
      {
        id: "agent-1",
        owner_user_id: "user-source",
        name: "Pencatat",
        type: "mcp",
        status: "active",
        api_key_id: "key-9",
        created_at: new Date(CREATED),
        updated_at: new Date(UPDATED),
      },
    ]);
    source.put("memories", [
      memoryRow("mem-1", "brain-1", { created_by_agent: "agent-1", importance: 4 }),
    ]);

    const plan = await planBrainExport(source);
    const trip = await roundTrip(plan);

    expect(trip.archive.domain).toBe("brain");
    expect(trip.archive.filename).toBe(
      accountArchiveFilename("brain", trip.archive.createdAt)
    );
    expect(trip.lines.map((line) => line.text)).toEqual(indexLines(plan.index));
    expect(trip.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);
    expect(trip.summary.counts).toEqual({ folders: 0, files: 0, memories: 1, rows: 3 });
    expect(trip.trailer.totalPlaintextBytes).toBe(plan.totalBytes);
    expect(trip.trailer.payloadSha256).toEqual(
      createHash("sha256").update(trip.payload).digest()
    );
    // The agent's key id is core data this archive must not carry; the grant that names
    // the agent is a ref, and it resolved.
    expect(trip.payload.toString("utf8")).not.toContain("key-9");
    expect(JSON.parse(payloadLines(trip.payload)[2]).created_by_agent).toBe("agent-1");
  });
});

