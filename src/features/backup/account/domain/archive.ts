import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { BackupDomain } from "@backup/domain/types";
import { GCM_IV_BYTES, GCM_TAG_BYTES, HMAC_BYTES } from "@backup/domain/types";
import { AfrCorruptError, AfrDomainMismatchError, AfrUnreadableError } from "./errors";
import {
  AFR_CHUNK_SIZE,
  AFR_FORMAT_VERSION,
  MAX_CHUNK_COUNT,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  NONCE_PREFIX_BYTES,
  PREAMBLE_BYTES,
  TRAILER_BYTES,
  chunkAad,
  chunkNonce,
  decodeHeader,
  decodePreamble,
  decodeTrailer,
  encodeHeader,
  encodePreamble,
  encodeTrailer,
  headerHmac,
  sectionAad,
  splitGcm,
  trailerHmac,
  verifyTrailerHmac,
  type AfrAadContext,
  type AfrArgon2Params,
  type AfrHeader,
  type AfrPreamble,
  type AfrTrailer,
} from "./format";
import {
  AFR_ARGON2,
  openDek,
  wrapDek,
  type AfrKeyRing,
  type AfrMasterKey,
  type OpenedDek,
} from "./keys";
import { decodeSummary, encodeSummary, type AfrSummary } from "./summary";

/**
 * The `.afrbak` file, written forwards and read forwards.
 *
 * ```
 * PREAMBLE(32) ‖ HEADER ‖ HDR_HMAC(32) ‖ SUMMARY_ENC ‖ INDEX_ENC ‖ CHUNKS… ‖ TRAILER(48) ‖ T_HMAC(32)
 * ```
 *
 * Two things about this module are worth knowing before reading it.
 *
 * **Nothing is staged anywhere.** The writer is an async generator: the route pipes it
 * straight to the response, so a 40 GB archive costs one `chunkSize` of memory and not one
 * byte of R2. That is the whole reason the export path exists in this shape (§6.4, §7.1).
 *
 * **The PREAMBLE carries `indexLength`, and it is written first.** So the INDEX has to be
 * complete before the first byte goes out, which is why {@link writeArchive} takes it as a
 * `Buffer` while the payload arrives as a stream. The exporter builds it from a
 * metadata-only pass — row columns, no file bodies — and {@link AFR_MAX_INDEX_BYTES} keeps
 * that pass from becoming an out-of-memory crash on an account nobody expected. The
 * payload, which is the part that is actually large, never accumulates.
 *
 * **The reader hands over plaintext before the tag that covers it verifies.** Unavoidable
 * for a streaming reader over a single GCM region, and safe here only because of the order
 * §7.3 mandates: validate → reserve → import/stage → verify → commit. Every row an
 * importer writes before the trailer verifies is staged and uncommitted, so a tag failure
 * at the end aborts a transaction rather than leaving half a restore behind. If a caller
 * ever commits before {@link AfrArchiveReader.finish} resolves, that property is gone.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5, §6.4, §7.
 */

/**
 * The ceiling on a built INDEX, and an honest limit rather than a format rule.
 *
 * §5.4 leaves `indexLength` unbounded and lets the row caps of §11 do the work, which they
 * do — 250,000 file entries at a realistic width land near 45 MB. This number is above
 * that and below what would kill the 2 GB instance this runs on, and it turns "the export
 * died" into a refusal that says which account and how big.
 */
export const AFR_MAX_INDEX_BYTES = 64 * 1024 * 1024;

/**
 * The longest a single INDEX line may be.
 *
 * This is what keeps the reader's memory flat: lines are accumulated until a `\n`, so an
 * archive with no newline in it at all would otherwise buffer its entire index. A path is
 * capped at 4,096 characters and a MIME at 255, so no legitimate line is close.
 */
export const AFR_MAX_INDEX_LINE_BYTES = 64 * 1024;

/**
 * How much of the INDEX is decrypted per step. Unrelated to the line cap: this bounds the
 * reader's working set, that bounds one entry.
 */
const INDEX_SLICE_BYTES = 64 * 1024;

/* ── one GCM region at a time ─────────────────────────────────────────────── */

/** Seal a region as `ct ‖ tag` — the layout {@link splitGcm} expects everywhere. */
function gcmSeal(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Open a region, whole, or refuse.
 *
 * One refusal for every cause: a wrong DEK, one edited byte, a chunk moved from position 7
 * to position 3 and a region lifted out of a different archive are the same event at the
 * tag. Telling them apart is exactly the oracle §12 declines to hand out, and `where`
 * carries the difference into the audit trail where only an operator reads it.
 */
function gcmOpen(
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  region: Buffer,
  where: string
): Buffer {
  const { ct, tag } = splitGcm(region, where);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new AfrUnreadableError(6, `${where} did not authenticate`);
  }
}

/* ── writing ──────────────────────────────────────────────────────────────── */

export interface AfrWriteInput {
  domain: BackupDomain;
  /** This archive's own id, a UUID. Every region's AAD is bound to it. */
  backupId: string;
  /** Epoch milliseconds, supplied so the header and the audit row cannot disagree. */
  createdAt: number;
  /** The ring's active key: it signs `HDR_HMAC` and fills keyslot 0. */
  masterKey: AfrMasterKey;
  /** Fresh per archive, from `newDek()`. */
  dek: Buffer;
  /**
   * Argon2id over this archive's nine words, derived by the route from `BACKUP_MASTER_KEY` and
   * the download's `ticketId` (§4.3) — never the phrase itself, which is a string this layer has
   * no use for and which the server stores nowhere.
   */
  recoveryWrappingKey: Buffer;
  /** Per archive, matching the words shown for this download, and written into the header. */
  phraseSalt: Buffer;
  argon2?: AfrArgon2Params;
  /** Counts and totals as the metadata pass measured them. Claims by design (§5.4). */
  summary: AfrSummary;
  /** Complete before the first byte goes out — see this module's opening note. */
  index: Buffer;
  /**
   * The bodies, in the order the INDEX lists them. Pieces of any size: the chunk
   * boundaries the format needs are re-cut here, so no producer has to know about them.
   */
  payload: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  chunkSize?: number;
}

/**
 * What the archive turned out to hold — the trailer's three facts plus the download size.
 *
 * Returned rather than yielded, so `for await` consumers (the route, which only pipes
 * bytes) ignore it and a caller that drives the generator itself can record it.
 */
export interface AfrWriteReport extends AfrTrailer {
  /** Every byte yielded, framing included. */
  archiveBytes: number;
}

/**
 * Re-cut a stream of arbitrary pieces into exactly `chunkSize` blocks, the last one short.
 *
 * The producers upstream yield whatever R2 or a row serializer handed them. The format's
 * nonce scheme needs the opposite: a reader computes chunk *i*'s boundaries from
 * `chunkSize` alone, so every chunk but the last must be exactly that wide. Deciding it
 * here — and only here — is what keeps that invariant out of every producer.
 */
async function* rechunk(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  chunkSize: number
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const piece of source) {
    if (piece.length === 0) continue;
    pending.push(toBuffer(piece));
    pendingBytes += piece.length;
    while (pendingBytes >= chunkSize) {
      const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      yield joined.subarray(0, chunkSize);
      const rest = joined.subarray(chunkSize);
      pending = rest.length > 0 ? [rest] : [];
      pendingBytes = rest.length;
    }
  }
  // Only if there is something left: a payload whose length is an exact multiple of
  // `chunkSize` must not end with a zero-length chunk, which `decodeTrailer`'s arithmetic
  // would then read as one chunk too many.
  if (pendingBytes > 0) {
    yield pending.length === 1 ? pending[0] : Buffer.concat(pending);
  }
}

/** A `Buffer` view of any byte source, without copying: `Buffer` is already a view. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Write one `.afrbak`, forwards, holding nothing back.
 *
 * The generator yields the file in order and keeps at most one chunk of payload in memory,
 * which is what lets the route hand it straight to the response with no temporary object in
 * R2 and no `Content-Length` (§6.4 — the length is unknowable before the last chunk is
 * sealed, so the response is `Transfer-Encoding: chunked`).
 *
 * Both keyslots are filled here, from one `context`, for a reason worth stating: §4.2 would
 * let a caller wrap them, and a caller that built the AAD from anything but the header it
 * ends up writing would produce an archive whose recovery phrase silently does not open it
 * — a failure discovered on the one day it matters.
 */
export async function* writeArchive(
  input: AfrWriteInput
): AsyncGenerator<Buffer, AfrWriteReport, void> {
  const chunkSize = input.chunkSize ?? AFR_CHUNK_SIZE;
  // Neither of these is a hostile input — both come from our own exporter — so they fail as
  // programming errors rather than as one of the nine refusals a user is ever shown.
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error(`chunkSize ${chunkSize} is outside ${MIN_CHUNK_SIZE}…${MAX_CHUNK_SIZE}`);
  }
  if (input.index.length > AFR_MAX_INDEX_BYTES) {
    throw new Error(
      `index is ${input.index.length} bytes, cap ${AFR_MAX_INDEX_BYTES}; the exporter is ` +
        `expected to refuse an account this large before it starts streaming`
    );
  }

  const context: AfrAadContext = {
    backupId: input.backupId,
    domain: input.domain,
    formatVersion: AFR_FORMAT_VERSION,
  };
  const summaryNonce = randomBytes(GCM_IV_BYTES);
  const indexNonce = randomBytes(GCM_IV_BYTES);
  const chunkNoncePrefix = randomBytes(NONCE_PREFIX_BYTES);
  const summaryEnc = gcmSeal(
    input.dek,
    summaryNonce,
    sectionAad(context, "summary"),
    encodeSummary(input.summary)
  );
  const indexEnc = gcmSeal(input.dek, indexNonce, sectionAad(context, "index"), input.index);

  const headerBytes = encodeHeader({
    backupId: input.backupId,
    createdAt: input.createdAt,
    keyId: input.masterKey.keyId,
    keyslot: [
      wrapDek(input.masterKey.key, input.dek, context, 0),
      wrapDek(input.recoveryWrappingKey, input.dek, context, 1),
    ],
    phraseSalt: input.phraseSalt,
    argon2: input.argon2 ?? AFR_ARGON2,
    chunkNoncePrefix,
    summaryNonce,
    indexNonce,
  });
  // Cheap insurance, one JSON parse of about a kilobyte per archive: an archive this build
  // cannot parse is an archive nobody can restore, and every way to build one — a salt of
  // the wrong width, a `backupId` that is not a UUID, an Argon2 cost outside the readable
  // range — is invisible until the day the archive is needed.
  decodeHeader(headerBytes);

  const preamble = encodePreamble({
    formatVersion: AFR_FORMAT_VERSION,
    domain: input.domain,
    headerLength: headerBytes.length,
    summaryLength: summaryEnc.length,
    indexLength: indexEnc.length,
    chunkSize,
  });
  const headerMac = headerHmac(input.masterKey.key, preamble, headerBytes);

  let archiveBytes = 0;
  for (const region of [preamble, headerBytes, headerMac, summaryEnc, indexEnc]) {
    archiveBytes += region.length;
    yield region;
  }

  const payloadSha = createHash("sha256");
  let chunkCount = 0;
  let totalPlaintextBytes = 0;
  for await (const plain of rechunk(input.payload, chunkSize)) {
    if (chunkCount >= MAX_CHUNK_COUNT) {
      // 2^32 chunks of the smallest legal size is 256 TiB, so this is unreachable by any
      // account — but the counter is what the nonce is built from, and a nonce that wraps
      // reuses a (key, nonce) pair, which is the one thing GCM does not survive.
      throw new Error(`payload exceeds ${MAX_CHUNK_COUNT} chunks of ${chunkSize} bytes`);
    }
    payloadSha.update(plain);
    totalPlaintextBytes += plain.length;
    const region = gcmSeal(
      input.dek,
      chunkNonce(chunkNoncePrefix, chunkCount),
      chunkAad(context, chunkCount),
      plain
    );
    chunkCount += 1;
    archiveBytes += region.length;
    yield region;
  }

  const trailer: AfrTrailer = {
    chunkCount,
    payloadSha256: payloadSha.digest(),
    totalPlaintextBytes,
  };
  const trailerBytes = encodeTrailer(trailer);
  const trailerMac = trailerHmac(input.dek, headerMac, trailerBytes);
  archiveBytes += trailerBytes.length + trailerMac.length;
  yield trailerBytes;
  yield trailerMac;
  return { ...trailer, archiveBytes };
}

/* ── reading ──────────────────────────────────────────────────────────────── */

/**
 * A byte-oriented view over a stream of arbitrarily-sized pieces.
 *
 * The archive is a sequence of exact-width regions and a stream is whatever the network
 * chose to hand over, so something has to hold that seam. This holds it and nothing else:
 * {@link buffer} pulls until a target is met, {@link take} hands those bytes over, and the
 * queue never grows past what the caller asked to see.
 */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queue: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    // One generator hop, so a sync array of fixtures and a live socket are the same thing
    // from here on.
    this.iterator = (async function* iterate() {
      for await (const piece of source) yield piece;
    })();
  }

  /** Pull until `target` bytes are held, or the source ends. Returns what is held. */
  async buffer(target: number): Promise<number> {
    while (this.buffered < target && !this.ended) {
      const step = await this.iterator.next();
      if (step.done) {
        this.ended = true;
        break;
      }
      if (step.value.length > 0) {
        this.queue.push(toBuffer(step.value));
        this.buffered += step.value.length;
      }
    }
    return this.buffered;
  }

  /** Exactly `n` bytes off the front, which {@link buffer} must already have secured. */
  take(n: number): Buffer {
    if (n > this.buffered) {
      throw new Error(`take(${n}) with ${this.buffered} bytes buffered`);
    }
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n) {
      const head = this.queue[0];
      const need = n - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.queue.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.queue[0] = head.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /**
   * A region whose width the preamble already declared.
   *
   * Coming up short is refusal #7 and not #6: the contradiction is between two plaintext
   * numbers — what the file says it holds and what it holds — so no key was involved,
   * nothing is leaked by saying so, and "damaged" is the honest word. It is the same call
   * `decodePreamble` already makes for a file too short to hold a preamble.
   */
  async readExactly(n: number, where: string): Promise<Buffer> {
    if ((await this.buffer(n)) < n) {
      throw new AfrCorruptError(`${where} needs ${n} bytes, ${this.buffered} remain`);
    }
    return this.take(n);
  }

  /** As many of `n` as exist. For the preamble, which decides what a short file even is. */
  async readUpTo(n: number): Promise<Buffer> {
    return this.take(Math.min(n, await this.buffer(n)));
  }
}

/** One INDEX entry, as the reader hands it to a decoder in `index-entries.ts`. */
export interface AfrIndexLine {
  /** The line, terminator stripped, ready for `decodeFilesEntry`/`decodeBrainEntry`. */
  text: string;
  /** 1-based. */
  lineNumber: number;
  /** `index line 4102` — the `where` every decoder takes, so a refusal names the line. */
  where: string;
}

/**
 * NDJSON out of a byte stream, without ever holding more than one line.
 *
 * The cap is what makes that true. Lines are accumulated until a terminator arrives, so an
 * INDEX region containing no `\n` at all would otherwise buffer every byte of itself —
 * which for a 60 MB index is a 60 MB allocation chosen by whoever wrote the file.
 */
class IndexLineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private lineNumber = 0;

  push(plain: Buffer): AfrIndexLine[] {
    const lines: AfrIndexLine[] = [];
    let start = 0;
    for (;;) {
      const terminator = plain.indexOf(0x0a, start);
      if (terminator < 0) break;
      lines.push(this.complete(plain.subarray(start, terminator)));
      start = terminator + 1;
    }
    const rest = plain.subarray(start);
    if (rest.length > 0) {
      this.guard(rest.length);
      // Copied rather than kept as a view: a view would pin the whole decrypted slice.
      this.pending.push(Buffer.from(rest));
      this.pendingBytes += rest.length;
    }
    return lines;
  }

  /** Nothing may be left over: a final line with no terminator is a truncated INDEX. */
  end(): void {
    if (this.pendingBytes > 0) {
      throw new AfrCorruptError(
        `index ends ${this.pendingBytes} bytes into line ${this.lineNumber + 1}, ` +
          `with no terminator`
      );
    }
  }

  /**
   * A finished line: the accumulated pieces plus the tail before the terminator.
   *
   * A `\r` is refused rather than trimmed. Canonical JSON escapes every control character
   * inside a string, so a raw carriage return can only be framing — a CRLF terminator from
   * a writer that treated the archive as text, or a file that went through one. Accepting
   * it would make `{"a":1}\r\n` and `{"a":1}\n` two spellings of one line, and the trailing
   * `\r` would then be inside the text a decoder parses.
   */
  private complete(tail: Buffer): AfrIndexLine {
    this.guard(tail.length);
    const bytes = this.pendingBytes === 0 ? tail : Buffer.concat([...this.pending, tail]);
    this.pending = [];
    this.pendingBytes = 0;
    this.lineNumber += 1;
    const where = `index line ${this.lineNumber}`;
    if (bytes.includes(0x0d)) {
      throw new AfrCorruptError(`${where} contains a carriage return`);
    }
    return { text: bytes.toString("utf8"), lineNumber: this.lineNumber, where };
  }

  /**
   * The cap, counted across the pieces of one line rather than per piece — which is the
   * only version of it that bounds anything, since the pieces are ours to choose and the
   * line's length is theirs.
   */
  private guard(incoming: number): void {
    if (this.pendingBytes + incoming > AFR_MAX_INDEX_LINE_BYTES) {
      throw new AfrCorruptError(
        `index line ${this.lineNumber + 1} is over ${AFR_MAX_INDEX_LINE_BYTES} bytes`
      );
    }
  }
}

/* ── one archive, opened ──────────────────────────────────────────────────── */

export interface AfrOpenInput {
  /** The upload, in whatever pieces the network chose to deliver it. */
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  /** Every key this instance holds, active and previous, from `parseMasterKeyRing()`. */
  ring: AfrKeyRing;
  /**
   * Which archive the caller asked for. Checked from the plaintext preamble, before a key
   * is touched: a brain archive dropped on the files restore screen is refusal #5 and not
   * a decryption failure, because there is nothing secret about which of the two it is.
   */
  expectedDomain: BackupDomain;
  /**
   * Only when the person typed one. Never required on the ordinary path — the server's own
   * key opens keyslot 0 — and the whole of the disaster path when the account row that held
   * the recovery key is gone (§7.1).
   */
  phrase?: string;
}

/** Everything {@link openArchive} settled before the reader existed. */
interface ReaderState {
  reader: ByteReader;
  preamble: AfrPreamble;
  header: AfrHeader;
  /** `HDR_HMAC` as read, because `TRL_HMAC` chains onto it. */
  headerMac: Buffer;
  context: AfrAadContext;
  opened: OpenedDek;
  summary: AfrSummary;
}

/** Each region is read once, in order, and the reader refuses to be driven out of it. */
type Stage = "pending" | "reading" | "done";

/**
 * An archive whose header verified and whose DEK is open, read forwards, once.
 *
 * What it deliberately does **not** do:
 *
 * - **No row caps and no quota check.** Those are refusals #8 and #9, and they belong to
 *   the restore service, which reads them off {@link summary} before its first write. A
 *   reader that refused to read an over-cap archive would also refuse to *describe* one,
 *   and the preview screen's whole job is to describe it.
 * - **No `accountBackupId` matching.** Refusal #6 is the service's call, because the answer
 *   depends on how the DEK was opened: {@link via} `"master"` on an id that does not match
 *   the account is a misrouted archive, while `"phrase"` on the same bytes is the disaster
 *   path adopting an identity, which is the entire point of keyslot 1 (§7.1).
 * - **No DEK on the surface.** {@link via}, {@link keyId} and {@link stale} are what a
 *   caller needs to audit and to decide about rotation; the key itself stays private.
 *
 * The order is fixed: {@link indexLines} (or {@link skipIndex}), then {@link readPayload},
 * then {@link finish}. Driving it out of order is a programming error and throws a plain
 * `Error` — not one of the nine refusals, which describe files rather than callers.
 */
export class AfrArchiveReader {
  readonly preamble: AfrPreamble;
  readonly header: AfrHeader;
  /** Already authenticated: its GCM tag verified inside {@link openArchive}. */
  readonly summary: AfrSummary;
  /** Which keyslot opened it. The service reads this before trusting an identity. */
  readonly via: OpenedDek["via"];
  /** Which master key — the archive's, which on the phrase path is not one we hold. */
  readonly keyId: string;
  /** True when the key that opened it is a previous key: correct, and due for rewrapping. */
  readonly stale: boolean;

  private readonly reader: ByteReader;
  private readonly context: AfrAadContext;
  private readonly dek: Buffer;
  private readonly headerMac: Buffer;
  private readonly payloadSha = createHash("sha256");

  private indexStage: Stage = "pending";
  private payloadStage: Stage = "pending";
  private chunksRead = 0;
  private plaintextBytes = 0;
  private trailerBytes: Buffer | null = null;
  private trailerMac: Buffer | null = null;
  private finished = false;

  constructor(state: ReaderState) {
    this.reader = state.reader;
    this.preamble = state.preamble;
    this.header = state.header;
    this.headerMac = state.headerMac;
    this.context = state.context;
    this.summary = state.summary;
    this.dek = state.opened.dek;
    this.via = state.opened.via;
    this.keyId = state.opened.keyId;
    this.stale = state.opened.stale;
  }

  /**
   * The INDEX, one entry at a time, in the order the archive lists them.
   *
   * The region is a single GCM region, so its tag arrives after its last byte and there is
   * no way to verify it before yielding — see this module's opening note, and §7.3, which is
   * what makes that safe. `AFR_MAX_INDEX_BYTES` is not applied here: it bounds the
   * *exporter*, which has to hold a built index in memory, while this holds one line.
   */
  async *indexLines(): AsyncGenerator<AfrIndexLine, void, void> {
    if (this.indexStage !== "pending") {
      throw new Error(`indexLines() called with the index ${this.indexStage}`);
    }
    this.indexStage = "reading";
    const decipher = createDecipheriv("aes-256-gcm", this.dek, this.header.indexNonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(sectionAad(this.context, "index"));
    const splitter = new IndexLineSplitter();

    let remaining = this.preamble.indexLength - GCM_TAG_BYTES;
    while (remaining > 0) {
      const slice = await this.reader.readExactly(
        Math.min(remaining, INDEX_SLICE_BYTES),
        "index"
      );
      remaining -= slice.length;
      yield* splitter.push(decipher.update(slice));
    }

    const tag = await this.reader.readExactly(GCM_TAG_BYTES, "index tag");
    let tail: Buffer;
    try {
      decipher.setAuthTag(tag);
      tail = decipher.final();
    } catch {
      throw new AfrUnreadableError(6, "the index did not authenticate");
    }
    yield* splitter.push(tail);
    splitter.end();
    this.indexStage = "done";
  }

  /**
   * Drain the INDEX without decoding it, for a caller that only wants the payload.
   *
   * It cannot be skipped in the sense of seeking past it: the INDEX's tag is what proves
   * those bytes were not edited, and the payload begins where the tag ends.
   */
  async skipIndex(): Promise<void> {
    const lines = this.indexLines();
    let step = await lines.next();
    while (!step.done) {
      step = await lines.next();
    }
  }

  /**
   * The payload, one verified chunk at a time.
   *
   * The trailer holds `chunkCount`, and the trailer is at the end — so a forward reader
   * cannot know how many chunks are coming and has to recognise the last one by feel. The
   * trick is a reserve: ask for `one chunk region + 80` bytes, and a full answer means a
   * whole chunk is certainly present because 80 bytes of trailer must follow it. A short
   * answer is end-of-file, so whatever exceeds the reserve is the final short chunk. Cost:
   * one chunk region plus 80 bytes of memory, whatever the archive's size.
   *
   * One structural consequence, which the round-trip tests lock: no middle chunk can be
   * short, because full regions are only ever taken at exactly `chunkSize + tag`.
   *
   * Every chunk's tag verifies before its plaintext is yielded — unlike the INDEX, chunk
   * boundaries are computable from `chunkSize` alone. What is *not* verified until
   * {@link finish} is the count, the byte total and the digest over all of them.
   */
  async *readPayload(): AsyncGenerator<Buffer, void, void> {
    if (this.indexStage !== "done") {
      throw new Error(`readPayload() called with the index ${this.indexStage}`);
    }
    if (this.payloadStage !== "pending") {
      throw new Error(`readPayload() called with the payload ${this.payloadStage}`);
    }
    this.payloadStage = "reading";
    const region = this.preamble.chunkSize + GCM_TAG_BYTES;
    const reserve = TRAILER_BYTES + HMAC_BYTES;

    for (;;) {
      const held = await this.reader.buffer(region + reserve);
      if (held >= region + reserve) {
        yield this.openChunk(this.reader.take(region));
        continue;
      }
      // End of file. What is left is the last chunk, if any, and the trailer.
      if (held < reserve) {
        throw new AfrUnreadableError(
          6,
          `archive ends ${held} bytes into its ${reserve}-byte trailer`
        );
      }
      const last = held - reserve;
      if (last > 0) {
        // A region of exactly one tag would be a chunk with no ciphertext, which the
        // writer cannot produce: `rechunk` never emits an empty final chunk.
        if (last <= GCM_TAG_BYTES) {
          throw new AfrUnreadableError(6, `chunk ${this.chunksRead} is ${last} bytes`);
        }
        yield this.openChunk(this.reader.take(last));
      }
      this.trailerBytes = this.reader.take(TRAILER_BYTES);
      this.trailerMac = this.reader.take(HMAC_BYTES);
      this.payloadStage = "done";
      return;
    }
  }

  /** One chunk region, opened and accounted for. Position *is* the nonce and the AAD. */
  private openChunk(region: Buffer): Buffer {
    const index = this.chunksRead;
    if (index >= MAX_CHUNK_COUNT) {
      // Unreachable at any real size — 2^32 chunks of the smallest legal width is 256 TiB
      // — but `chunkNonce` writes the counter into four bytes, so it must not be handed
      // one that does not fit.
      throw new AfrCorruptError(`archive holds more than ${MAX_CHUNK_COUNT} chunks`);
    }
    const plain = gcmOpen(
      this.dek,
      chunkNonce(this.header.chunkNoncePrefix, index),
      chunkAad(this.context, index),
      region,
      `chunk ${index}`
    );
    this.payloadSha.update(plain);
    this.plaintextBytes += plain.length;
    this.chunksRead = index + 1;
    return plain;
  }

  /**
   * The last word: what the archive said it contained, against what it did.
   *
   * `TRL_HMAC` is checked first and on purpose — the trailer's three numbers are only worth
   * comparing once they are known to be the writer's own. It keys on the DEK and chains onto
   * `HDR_HMAC`, so a trailer lifted from another archive of the same account fails here even
   * though every chunk before it verified.
   *
   * **A caller that has written rows must not commit until this resolves.** Chunk plaintext
   * was handed over before the digest covering it was checked, so a truncated payload or a
   * swapped-in chunk region from an older archive of the same account is caught *here* and
   * nowhere earlier (§7.3).
   */
  async finish(): Promise<AfrTrailer> {
    if (this.payloadStage !== "done" || !this.trailerBytes || !this.trailerMac) {
      throw new Error(`finish() called with the payload ${this.payloadStage}`);
    }
    if (this.finished) {
      throw new Error("finish() called twice");
    }
    this.finished = true;

    if (!verifyTrailerHmac(this.dek, this.headerMac, this.trailerBytes, this.trailerMac)) {
      throw new AfrUnreadableError(6, "the trailer did not authenticate");
    }
    const trailer = decodeTrailer(this.trailerBytes, this.preamble.chunkSize);
    if (trailer.chunkCount !== this.chunksRead) {
      throw new AfrUnreadableError(
        6,
        `trailer claims ${trailer.chunkCount} chunks, read ${this.chunksRead}`
      );
    }
    if (trailer.totalPlaintextBytes !== this.plaintextBytes) {
      throw new AfrUnreadableError(
        6,
        `trailer claims ${trailer.totalPlaintextBytes} bytes, read ${this.plaintextBytes}`
      );
    }
    if (!trailer.payloadSha256.equals(this.payloadSha.digest())) {
      throw new AfrUnreadableError(6, "the payload digest does not match the trailer");
    }
    return trailer;
  }
}

/**
 * Read far enough to know what an archive is, and stop there.
 *
 * The order is the order of §7.1, and every step of it is a refusal a person may see:
 *
 * ```
 * 32 bytes      ─▶ decodePreamble   #1 not an AFR backup · #2 too new · #7 truncated
 * domain byte   ─▶ expectedDomain   #5 wrong archive for this screen — before any key
 * header + MAC  ─▶ openDek          #3 unknown keyId or HDR_HMAC · #4 both slots dead
 * summaryLength ─▶ decodeSummary    #6 the region did not authenticate
 * ```
 *
 * The domain check comes before the key work deliberately: it costs nothing, it is decided
 * from a plaintext byte, and telling someone they picked the wrong archive is better than
 * a passphrase prompt they cannot satisfy. On return, the DEK is open, `HDR_HMAC` verified
 * and the SUMMARY authenticated — which is exactly enough for the preview screen, and about
 * 80 KiB read (§5.4, §7.1).
 */
export async function openArchive(input: AfrOpenInput): Promise<AfrArchiveReader> {
  const reader = new ByteReader(input.source);
  // `readUpTo`, not `readExactly`: a 3-byte file is "not an AFR backup", which is what a
  // person who uploaded the wrong thing needs to hear, and `decodePreamble` says so itself.
  const preambleBytes = await reader.readUpTo(PREAMBLE_BYTES);
  const preamble = decodePreamble(preambleBytes);
  if (preamble.domain !== input.expectedDomain) {
    throw new AfrDomainMismatchError(preamble.domain, input.expectedDomain);
  }

  const headerBytes = await reader.readExactly(preamble.headerLength, "header");
  const headerMac = await reader.readExactly(HMAC_BYTES, "HDR_HMAC");
  const header = decodeHeader(headerBytes);
  const context: AfrAadContext = {
    backupId: header.backupId,
    domain: preamble.domain,
    formatVersion: preamble.formatVersion,
  };
  const opened = await openDek({
    header,
    preamble: preambleBytes,
    headerBytes,
    headerMac,
    context,
    ring: input.ring,
    phrase: input.phrase,
  });

  const summaryEnc = await reader.readExactly(preamble.summaryLength, "summary");
  const summary = decodeSummary(
    gcmOpen(
      opened.dek,
      header.summaryNonce,
      sectionAad(context, "summary"),
      summaryEnc,
      "summary"
    )
  );
  return new AfrArchiveReader({
    reader,
    preamble,
    header,
    headerMac,
    context,
    opened,
    summary,
  });
}
