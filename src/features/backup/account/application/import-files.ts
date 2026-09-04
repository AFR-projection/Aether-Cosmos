/**
 * The files half of stage 3: an archive's folder tree and its bytes, into a live account.
 *
 * Everything here is a decision, and every decision is made from the archive plus what the
 * account already holds — never from a value the archive supplied for a column the database
 * indexes. `materializedPath` and `depth` are recomputed from the parent chain this file
 * walked, `is_note` is inferred from the bytes rather than carried, the MIME is put back
 * through the upload path's own validator, and the object key is minted by the sink. That is
 * §11 in one paragraph: the archive names things, the server places them.
 *
 * The order of operations is fixed by the format rather than chosen. INDEX precedes CHUNKS,
 * and the reader will not hand over a payload byte until the INDEX is drained, so the entries
 * are read into memory first — bounded by refusal #8, which has already been measured against
 * the SUMMARY — and the payload is then split by the sizes those entries declared. One byte
 * of drift in that split shifts every file after it, which is why each file's digest is
 * checked as it lands and not only by `finish()`'s payload digest at the end: the global one
 * refuses the archive, this one says which entry was wrong.
 *
 * Nothing here commits. `createFile` writes a staged row and its object, `createFolder` a
 * staged folder; whether any of it becomes visible is decided by `import.ts` after
 * `AfrArchiveReader.finish` resolves. A digest mismatch on the last file of a 200,000-file
 * archive therefore costs the whole restore, and leaves behind nothing but staged rows the
 * sweeper already knows how to remove.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.5, §11.
 */

import { createHash, type Hash } from "crypto";

import { checkEntityName, ENTITY_NAME_MAX } from "@/shared/lib/security/entity-name";
import { AfrCorruptError } from "@backup/account/domain/errors";
import {
  decodeFilesEntry,
  joinArchivePath,
  type AfrFileEntry,
  type AfrFolderEntry,
} from "@backup/account/domain/index-entries";
import { assertWithinRowCaps } from "@backup/account/domain/summary";
import { NOTE_BODY_KEYS } from "@backup/account/domain/tables";
import type {
  AfrReadable,
  FilesImportSink,
  ImportBudget,
  ImportReport,
  RestoreMode,
  StagedBody,
} from "@backup/account/application/import-types";

/* ── what one of this app's own notes looks like ───────────────────────────── */

/**
 * The MIME that makes a restored file a candidate for being a note.
 *
 * `is_note` is not carried by the archive, on purpose: it is a column, and a column an
 * archive can set is a column an archive can lie about — a `true` would put a 4 GB video's
 * bytes into a `file_contents` row, a `false` would put a note's body into the bucket under
 * a key the editor never reads. So it is inferred, from what `app/api/files/route.ts` gives
 * every note it creates — the MIME `application/json` — plus a body that is the two-key
 * object the export produced. Both must hold. Anything else is an ordinary object, which is
 * the safe answer: a file in the bucket is still the user's file, while a note whose body is
 * not one opens empty.
 *
 * The name deliberately says nothing here; {@link openBody} explains what it cost when it did.
 */
const NOTE_MIME = "application/json";

/**
 * The ceiling on a body this module will hold in memory to test that theory.
 *
 * 2 MiB is the limit `app/api/shared/[token]/route.ts` already puts on a note edit, so
 * nothing the editor can save is excluded by it. A larger `.note` is streamed to the bucket
 * as an object instead: refusing would lose the file, and buffering whatever size the
 * archive asked for is how one restore becomes the whole machine's memory.
 */
const AFR_MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** What a MIME this instance will not accept is replaced with (§11). */
const FALLBACK_MIME = "application/octet-stream";

export interface FilesImportInput {
  reader: AfrReadable;
  sink: FilesImportSink;
  mode: RestoreMode;
  budget: ImportBudget;
  /**
   * The upload path's own MIME policy — `isUploadAllowed`, which reads the settings row and
   * therefore needs a database. Injected rather than imported so every test of this module
   * runs without one, and so the single place that decides what this instance accepts stays
   * a single place.
   */
  mimeAllowed?: (mime: string, name: string) => boolean;
}
/* ── the import ───────────────────────────────────────────────────────────── */

export async function importFiles(input: FilesImportInput): Promise<ImportReport> {
  const { reader, sink, mode, budget } = input;
  // Already checked in stage 1, repeated because everything below is bounded by it: the INDEX
  // is held in memory, and this is the only thing that says how many entries it may hold.
  assertWithinRowCaps("files", reader.summary.counts);

  const plan = await readFilesIndex(reader);
  const tree = new FolderTree(sink);
  /** Live digests by path, for §7.5's "already here". Empty in `replace`. */
  const present = new Map<string, Set<string>>();
  /** Names in use per parent folder — live ones, then the ones this run creates. */
  const taken = new Map<string, Set<string>>();

  if (mode === "merge") {
    await tree.adopt(sink.liveFolders());
    for await (const row of sink.liveFiles()) {
      const cut = row.path.lastIndexOf("/");
      bucket(taken, cut < 0 ? "" : row.path.slice(0, cut)).add(row.path.slice(cut + 1));
      // A null digest is a row that predates checksum recording, and it is deliberately not
      // recorded here: §7.5 matches on the digest, so an unknown one can never match, and the
      // archive's copy lands beside it under a new name. Duplicating a file is one click to
      // undo; overwriting the wrong one because two unknowns compared equal is not.
      if (row.sha256 !== null) bucket(present, row.path).add(row.sha256.toLowerCase());
    }
  }

  // Folders first, and every folder entry rather than only the ones a file needs: an empty
  // folder is content, and a restore that silently dropped it would have lost something.
  for (const folder of plan.folders) {
    await tree.ensure(folder.path.split("/"), folder);
  }
  const cursor = new PayloadCursor(reader.readPayload());
  let written = 0;
  let skipped = 0;
  let renamed = 0;

  for (const { entry, where } of plan.files) {
    const segments = entry.path.split("/");
    const wanted = segments[segments.length - 1];
    const hash = createHash("sha256");

    if (mode === "merge" && present.get(entry.path)?.has(entry.sha256.toString("hex")) === true) {
      // §7.5: same path, same bytes — the account already has this file, so nothing is written
      // and no quota is charged. The payload still has to be walked past, and still has to be
      // the bytes it claimed: a digest that disagrees means the split is wrong, and every
      // entry after this one would be cut at the wrong offset.
      await drain(cursor.take(entry.size, where, hash, null));
      assertHandedOver(cursor, entry, where);
      assertDigest(hash, entry, where);
      skipped += 1;
      continue;
    }

    const folderId = await tree.ensure(segments.slice(0, -1), entry);
    let name = wanted;
    // Renaming is a `merge` behaviour and only a `merge` behaviour. `replace` is restoring into
    // an account whose own rows are about to be soft-deleted, so there is nothing to collide
    // with — and if the archive itself carries one path twice, both rows come back as they
    // were, which is what the account they came from looked like.
    if (mode === "merge") {
      const siblings = bucket(taken, joinArchivePath(segments.slice(0, -1)));
      if (siblings.has(wanted)) {
        name = restoredName(wanted, siblings);
        renamed += 1;
      }
      siblings.add(name);
    }

    const body = await openBody(cursor, entry, where, hash, budget);
    await sink.createFile(
      {
        folderId,
        name,
        // A note's MIME is the app's own constant and never the archive's word for it; an
        // object's goes back through this instance's upload policy (§11).
        mime: body.kind === "note" ? NOTE_MIME : importMime(entry.mime, name, input.mimeAllowed),
        size: entry.size,
        sha256: entry.sha256.toString("hex"),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      },
      body
    );
    // After the write, because for an object the sink is what drains the stream. Both rows are
    // staged, so a refusal here reaches `import.ts` with nothing committed and nothing visible.
    assertHandedOver(cursor, entry, where);
    assertDigest(hash, entry, where);
    written += 1;
  }

  await cursor.assertDrained();

  return {
    domain: "files",
    mode,
    rows: tree.created + written,
    bytes: budget.spent(),
    skipped,
    renamed,
  };
}
/* ── the INDEX, read whole ────────────────────────────────────────────────── */

export interface FilesPlan {
  folders: AfrFolderEntry[];
  files: { entry: AfrFileEntry; where: string }[];
}

/**
 * Every INDEX line, decoded, grouped, ordered, and reconciled with the SUMMARY.
 *
 * In memory because the format requires it — no payload byte is handed over until the INDEX
 * is drained — and affordable only because two ceilings are already in place: refusal #8 on
 * how many entries there may be, and `AFR_MAX_INDEX_BYTES` on how much room they may take.
 *
 * Three things are settled here rather than in the loop that consumes them:
 *
 *   - **The grouping.** Folders, then files, which is what `export-files.ts` writes. A folder
 *     entry after a file entry is a broken archive rather than a reordering to tolerate: a
 *     file cannot be placed before its folder exists, so accepting it would mean buffering
 *     the whole payload to come back to.
 *   - **The order inside each group.** Non-descending by path — deliberately not strictly
 *     ascending. There is no unique index on `(user_id, folder_id, name)`, so two live rows
 *     may genuinely share a path, and an exporter that emitted both is telling the truth.
 *   - **The arithmetic.** Entry counts and total byte size against the SUMMARY. The SUMMARY is
 *     what stage 2 reserved quota against, so an INDEX that disagrees with it is describing
 *     a different archive than the one that was admitted.
 *
 * Exported for the §7.2 split preview, which must derive its numbers from the same plan this
 * import will act on. A second reader written for the preview would be a second opinion about
 * what the archive contains, and the preview's whole value is that it is not one.
 */
export async function readFilesIndex(reader: AfrReadable): Promise<FilesPlan> {
  const folders: AfrFolderEntry[] = [];
  const files: { entry: AfrFileEntry; where: string }[] = [];
  let previous = "";
  let bytes = 0;

  for await (const line of reader.indexLines()) {
    const entry = decodeFilesEntry(line.text, line.where);
    if (entry.kind === "folder") {
      if (files.length > 0) {
        throw new AfrCorruptError(`${line.where} is a folder entry after a file entry`);
      }
    } else if (files.length === 0) {
      previous = ""; // the group boundary: the file group's order starts over
    }
    // No path in the message. §12: a refusal detail can reach a response and a log, and the
    // names of a person's folders are the one thing this feature exists to keep private.
    if (entry.path < previous) throw new AfrCorruptError(`${line.where} is out of order`);
    previous = entry.path;
    if (entry.kind === "folder") folders.push(entry);
    else {
      bytes += entry.size;
      files.push({ entry, where: line.where });
    }
  }
  const counts = reader.summary.counts;
  if (folders.length !== counts.folders) {
    throw new AfrCorruptError(
      `index lists ${folders.length} folders, summary declared ${counts.folders}`
    );
  }
  if (files.length !== counts.files) {
    throw new AfrCorruptError(
      `index lists ${files.length} files, summary declared ${counts.files}`
    );
  }
  if (bytes !== reader.summary.totalBytes) {
    throw new AfrCorruptError(
      `index entries total ${bytes} bytes, summary declared ${reader.summary.totalBytes}`
    );
  }
  // `counts.rows` is deliberately not compared. `decodeSummary` already refuses a total below
  // the sum of its parts, and an equality check here would be this module's opinion about what
  // a future format version may count as a row.
  return { folders, files };
}

/* ── small shared helpers ─────────────────────────────────────────────────── */

/** Get-or-create, for the two path-keyed indexes the merge pass builds. */
function bucket(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

/** Walk a skipped file's bytes past without keeping any of them. */
async function drain(bytes: AsyncIterable<Buffer>): Promise<void> {
  const pieces = bytes[Symbol.asyncIterator]();
  for (;;) {
    const step = await pieces.next();
    if (step.done === true) return;
  }
}

/**
 * Did the consumer actually read what it was handed?
 *
 * A plain `Error`, not a refusal: `take` already refuses a payload that runs short, so a
 * shortfall at this point means a sink returned before draining the stream it was given —
 * our bug, not the archive's. It has to stop the restore anyway, because every entry after
 * this one would be cut from the payload at the wrong offset.
 */
function assertHandedOver(cursor: PayloadCursor, entry: AfrFileEntry, where: string): void {
  if (cursor.handedOver !== entry.size) {
    throw new Error(
      `files import: ${where} handed over ${cursor.handedOver} of ${entry.size} bytes`
    );
  }
}

/** The bytes that arrived against the digest the INDEX committed to. Consumes `hash`. */
function assertDigest(hash: Hash, entry: AfrFileEntry, where: string): void {
  if (!hash.digest().equals(entry.sha256)) {
    throw new AfrCorruptError(`${where} carries bytes that do not match its digest`);
  }
}
/* ── the payload, cut by the sizes the INDEX declared ─────────────────────── */

/**
 * The payload as a sequence of files rather than a sequence of chunks.
 *
 * `readPayload()` yields whatever pieces the chunk boundaries happen to produce, and those
 * boundaries have nothing to do with where one file ends and the next begins: one 4 MiB chunk
 * can hold the tail of one file, all of eleven more and the head of a thirteenth. The entries'
 * declared sizes are therefore the only thing that says where to cut — which is exactly why
 * every cut is checked against a digest. One byte of drift shifts every file after it, and
 * without the per-entry check the restore would run to completion with each file holding its
 * neighbour's bytes, and only `finish()` would report that something, somewhere, was wrong.
 *
 * Pull-based, and a stream per file rather than a buffer per file: the sink is what drains
 * `take`, so a 4 GB video passes through this process without ever being in it. `handedOver`
 * is how the caller finds out whether the sink really did drain what it was given.
 */
class PayloadCursor {
  private readonly pieces: AsyncIterator<Buffer>;
  /** The tail of a piece that ran past the current entry's end. */
  private rest: Buffer = Buffer.alloc(0);
  private spent = false;
  /** Bytes yielded by the most recent `take`. Reset when `take` is called, not when it runs. */
  handedOver = 0;

  constructor(payload: AsyncIterable<Buffer>) {
    this.pieces = payload[Symbol.asyncIterator]();
  }

  private async nextPiece(): Promise<Buffer | null> {
    if (this.rest.length > 0) {
      const piece = this.rest;
      this.rest = Buffer.alloc(0);
      return piece;
    }
    if (this.spent) return null;
    const step = await this.pieces.next();
    if (step.done === true) {
      this.spent = true;
      return null;
    }
    return step.value;
  }
  /**
   * Exactly `size` bytes, hashed and charged on the way out.
   *
   * A method that returns a stream rather than a generator itself, so that `handedOver` is
   * cleared when `take` is *called*. A generator's body does not run until it is iterated, and
   * a sink that ignored the stream entirely would otherwise be checked against the previous
   * entry's tally.
   *
   * `budget` is null for a file being walked past rather than written: §7.5's skip costs the
   * account nothing, and charging it would put `written_bytes` at odds with what landed.
   */
  take(
    size: number,
    where: string,
    hash: Hash,
    budget: ImportBudget | null
  ): AsyncIterable<Buffer> {
    this.handedOver = 0;
    return this.stream(size, where, hash, budget);
  }

  private async *stream(
    size: number,
    where: string,
    hash: Hash,
    budget: ImportBudget | null
  ): AsyncGenerator<Buffer, void, void> {
    while (this.handedOver < size) {
      const piece = await this.nextPiece();
      if (piece === null) {
        throw new AfrCorruptError(
          `payload ended ${size - this.handedOver} bytes before the end of ${where}`
        );
      }
      if (piece.length === 0) continue;
      const want = size - this.handedOver;
      const give = piece.length <= want ? piece : piece.subarray(0, want);
      if (piece.length > want) this.rest = piece.subarray(want);
      this.handedOver += give.length;
      hash.update(give);
      // Before the yield, so an archive that oversteps its declared total is refused by the
      // byte that oversteps it and not by however much more the sink went on to accept.
      budget?.spend(give.length);
      yield give;
    }
  }

  /**
   * Refuse a payload with bytes left over after the last entry.
   *
   * The INDEX's sizes were proven to sum to the SUMMARY's `totalBytes`, so anything trailing
   * means the payload and its own description disagree. `finish()` would catch it too, as a
   * digest mismatch — a worse answer, because it cannot say what it was.
   */
  async assertDrained(): Promise<void> {
    for (;;) {
      const piece = await this.nextPiece();
      if (piece === null) return;
      if (piece.length > 0) {
        throw new AfrCorruptError(`payload carries ${piece.length} bytes past the last entry`);
      }
    }
  }
}
/* ── the folder tree, rebuilt from the parent chain ───────────────────────── */

/** Just the two timestamps, so `ensure` can be fed either kind of entry. */
interface AfrTimes {
  createdAt: number;
  updatedAt: number;
}

/**
 * Archive paths to live folder ids, including ids for the ancestors an archive left implicit.
 *
 * `materializedPath` and `depth` are what every folder query in this app is built on, and
 * neither is ever taken from the archive (§11). Both are computed here from the chain of
 * segments this class walked, in the app's own spelling — `/Photos/2026/`, a separator at each
 * end, `depth` counted from zero at the account root — exactly as `pathUnder` in
 * `app/api/folders/route.ts` writes them.
 *
 * `adopt` is for `merge` only. `replace` creates every folder fresh, and not for want of a
 * shortcut: reusing a live folder would put restored files inside a row the commit is about to
 * soft-delete, and they would come back invisible.
 */
class FolderTree {
  private readonly ids = new Map<string, string>();
  /** Folder rows this run created, for the report's `rows`. */
  created = 0;

  constructor(private readonly sink: FilesImportSink) {}

  /** Take over the account's existing folders, by path. */
  async adopt(live: AsyncIterable<{ path: string; id: string }>): Promise<void> {
    for await (const row of live) {
      // First one wins, deterministically. Two live folders can share a path — there is no
      // unique index on `(user_id, parent_id, name)` — and choosing is the whole requirement:
      // either row is a real folder of the user's, and the restored files have to land
      // together rather than be split across two rows the UI draws identically.
      if (!this.ids.has(row.path)) this.ids.set(row.path, row.id);
    }
  }
  /**
   * The id of the folder at `segments`, creating it and every missing ancestor.
   *
   * `null` for the empty path: that is the account root, which is a place and not a row.
   *
   * An ancestor the archive never named inherits the timestamps of the entry that needed it.
   * The exporter always writes every folder row, so this is not a case it produces — but the
   * format permits `A/B/C` with no `A`, and the alternative is refusing a whole restore over
   * a folder the user has no way to know was missing.
   */
  async ensure(segments: readonly string[], times: AfrTimes): Promise<string | null> {
    let parentId: string | null = null;
    for (let i = 0; i < segments.length; i += 1) {
      const path = segments.slice(0, i + 1).join("/");
      const known = this.ids.get(path);
      if (known !== undefined) {
        parentId = known;
        continue;
      }
      const id: string = await this.sink.createFolder({
        parentId,
        name: segments[i],
        materializedPath: `/${path}/`,
        depth: i,
        createdAt: times.createdAt,
        updatedAt: times.updatedAt,
      });
      this.ids.set(path, id);
      this.created += 1;
      parentId = id;
    }
    return parentId;
  }
}
/* ── the name a colliding file comes back under ───────────────────────────── */

/**
 * `report.pdf` arriving beside a live `report.pdf` with different bytes becomes
 * `report (restored).pdf`, then `report (restored 2).pdf`, and so on.
 *
 * §7.5's third case. Both files are the user's and both survive, so the archive's copy needs a
 * name that no live sibling holds and that no earlier entry of this same restore has taken.
 *
 * `splitName` and `withinLimit` are this feature's own copies of the paste path's collision
 * naming (`src/features/files/domain/services/paste-plan.ts`). Copied because the ESLint
 * boundary rule stops `src/features/backup` importing from `@files/*`, and covered by a drift
 * test that runs both implementations over the same inputs, so a change to the original cannot
 * quietly stop matching this one.
 *
 * Exported for the same reason `readFilesIndex` is: the split preview counts a rename by asking
 * this function for the name, so the count it shows and the name the restore writes cannot come
 * from two different rules.
 */
const RESTORED_SUFFIX = " (restored)";

export function restoredName(name: string, taken: ReadonlySet<string>): string {
  const { stem, extension } = splitName(name);
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? RESTORED_SUFFIX : ` (restored ${attempt})`;
    const candidate = fitName(stem, suffix, extension);
    if (taken.has(candidate)) continue;
    // The archive cannot carry a name with a trailing dot or surrounding whitespace — the path
    // validator refused both before this ran — and what is inserted is ASCII, so this holds by
    // construction. It is asserted anyway, and as a plain `Error`: a failure would be a bug in
    // the two functions below, and the row it would write is one the app cannot rename.
    const verdict = checkEntityName(candidate);
    if (!verdict.ok) {
      throw new Error(`files import: the restored name was refused: ${verdict.reason}`);
    }
    return verdict.name;
  }
}

/** `withinLimit`, plus the one case it cannot serve: an extension with no room for a suffix. */
function fitName(stem: string, suffix: string, extension: string): string {
  const kept = withinLimit(stem, suffix, extension);
  if (kept.length <= ENTITY_NAME_MAX) return kept;
  // A name that is one character, a dot and 250 more — legal, and pathological. `withinLimit`
  // will not trim a stem below one character, so the suffix is what has to move: it goes last,
  // and the name in front of it is whatever fits. Uniqueness survives, because the suffix is
  // where the attempt number is.
  const head = `${stem}${extension}`.slice(0, ENTITY_NAME_MAX - suffix.length);
  return `${head.trimEnd()}${suffix}`;
}
/**
 * `report.pdf` → `report` + `.pdf`.
 *
 * A leading dot belongs to the name rather than to an extension, which is what `dot <= 0`
 * says: `.gitignore` keeps all of itself and gets the suffix at the end.
 */
function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/** The suffix goes before the extension, and the room for it comes out of the stem. */
function withinLimit(stem: string, suffix: string, extension: string): string {
  const overflow = stem.length + suffix.length + extension.length - ENTITY_NAME_MAX;
  if (overflow <= 0) return `${stem}${suffix}${extension}`;
  const trimmed = stem.slice(0, Math.max(1, stem.length - overflow)).trimEnd();
  return `${trimmed}${suffix}${extension}`;
}

/* ── the body: an object in the bucket, or a note in a row ─────────────────── */

/**
 * What to write for one file entry, and the stream or the parsed body to write it from.
 *
 * A candidate note is buffered and inspected; everything else is handed through as a stream, so
 * the ordinary case — an object of any size — never occupies memory. A candidate that turns out
 * not to be a note is handed on as an object *from the buffer already read*: the payload is one
 * forward pass and there is nothing to rewind to.
 *
 * ## Why the name is not part of the decision
 *
 * It used to be: an entry had to be called `*.note` to be considered at all. That read as the
 * app's own convention — `POST /api/files` appends the suffix when it creates a note — but the
 * app does not keep it. `PATCH /api/files` with `action=rename` writes the name it was given
 * and nothing else, so a note the owner renamed is stored under a bare name, is exported under
 * that name faithfully, and came back from a restore as a *file* whose whole visible content
 * was `{"annotations":null,"content":{"type":"doc",…}}`. The note was not damaged and nothing
 * was lost, but what the owner opened was the serialisation instead of the writing.
 *
 * So the candidate filter is now the two things that are true of every note this app has ever
 * written — the MIME it assigns them, and a body small enough to hold — and {@link parseNoteBody}
 * decides on the bytes. The cost is that a JSON file whose top level is *exactly* the two keys
 * `NOTE_BODY_KEYS` names is read back as a note; it keeps every byte and opens in the editor,
 * which is a far smaller loss than the one this replaces, and no archive format changed, so a
 * `.afrbak` already on someone's disk restores correctly from now on.
 */
async function openBody(
  cursor: PayloadCursor,
  entry: AfrFileEntry,
  where: string,
  hash: Hash,
  budget: ImportBudget
): Promise<StagedBody> {
  const candidate = entry.mime === NOTE_MIME && entry.size <= AFR_MAX_NOTE_BYTES;
  if (!candidate) return { kind: "object", bytes: cursor.take(entry.size, where, hash, budget) };

  const buffered = await collect(cursor.take(entry.size, where, hash, budget));
  return parseNoteBody(buffered) ?? { kind: "object", bytes: once(buffered) };
}
/** One `Buffer`, from a stream already known to be small enough to hold. */
async function collect(bytes: AsyncIterable<Buffer>): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of bytes) pieces.push(piece);
  return Buffer.concat(pieces);
}

/** A buffer as the one-piece stream `StagedBody` asks for. */
async function* once(bytes: Buffer): AsyncGenerator<Uint8Array, void, void> {
  yield bytes;
}

/**
 * The two-key object the export writes for a note, or `null` for anything else.
 *
 * This is the whole of the `is_note` decision (§11): the bytes must parse as JSON, be a plain
 * object, and have exactly the two keys `NOTE_BODY_KEYS` names. The values are not inspected —
 * both columns are `jsonb` with no server-side shape contract, and the editor can already put
 * arbitrary JSON in them, so anything stricter would cost fidelity without denying a
 * capability.
 *
 * `null` rather than a refusal when a `.note` holds something else: a file in the bucket is
 * still the user's file, while a note whose body is not one opens empty.
 */
function parseNoteBody(bytes: Buffer): StagedBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const [annotations, content] = NOTE_BODY_KEYS;
  if (keys.length !== 2 || !keys.includes(annotations) || !keys.includes(content)) return null;
  return { kind: "note", content: record[content], annotations: record[annotations] };
}

/* ── the MIME this instance is willing to store ───────────────────────────── */

/**
 * The archive's MIME if this instance would accept it on upload, `application/octet-stream` if
 * not.
 *
 * Never a refusal. `isUploadAllowed` is a policy about what may *enter* an account, and this
 * file entered it once already — refusing here would make the user's own file the one thing
 * their backup cannot give back. The downgrade keeps every byte and takes away only the
 * browser's licence to render them, which is the same protection the download path applies in
 * any case: §11 does not let an archive's MIME decide a response `Content-Type`.
 *
 * `allowed` is optional so this module's unit tests need no settings row. Absent means "keep
 * what the archive said", which is only ever a test's answer; `import.ts` always passes one.
 */
function importMime(
  mime: string,
  name: string,
  allowed?: (mime: string, name: string) => boolean
): string {
  if (mime.length === 0) return FALLBACK_MIME;
  if (allowed !== undefined && !allowed(mime, name)) return FALLBACK_MIME;
  return mime;
}
