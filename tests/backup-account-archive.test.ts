import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AFR_MAX_INDEX_BYTES,
  AFR_MAX_INDEX_LINE_BYTES,
  openArchive,
  writeArchive,
  type AfrIndexLine,
  type AfrWriteInput,
  type AfrWriteReport,
} from "@backup/account/domain/archive";
import {
  AFRBAK_MAGIC,
  MAX_CHUNK_SIZE,
  MAX_PREVIEW_BYTES,
  MIN_CHUNK_SIZE,
  PREAMBLE_BYTES,
  TRAILER_BYTES,
  decodePreamble,
  decodeTrailer,
  previewLength,
  type AfrArgon2Params,
} from "@backup/account/domain/format";
import {
  deriveRecoveryWrappingKey,
  newDek,
  newPhraseSalt,
  parseMasterKeyRing,
  type AfrKeyRing,
} from "@backup/account/domain/keys";
import {
  AccountBackupError,
  AfrCorruptError,
  AfrDomainMismatchError,
  AfrUnreadableError,
  NotAnAfrBackupError,
} from "@backup/account/domain/errors";
import { encodeFilesEntry } from "@backup/account/domain/index-entries";
import { newAccountBackupId } from "@backup/account/domain/identity";
import type { AfrSummary } from "@backup/account/domain/summary";
import { GCM_TAG_BYTES, HMAC_BYTES, type BackupDomain } from "@backup/domain/types";

/**
 * `.afrbak` end to end: written forwards, read forwards, and refused everywhere it should be.
 *
 * Three properties carry the suite.
 *
 * **It round trips through a stream, not a buffer.** The writer is an async generator and the
 * reader takes an async iterable, so the tests feed archives in deliberately awkward pieces —
 * one byte at a time, unaligned — and still expect exact chunk boundaries out the other end.
 * That is what proves a 40 GB export costs one chunk of memory and nothing in R2.
 *
 * **Every region is tampered with, one at a time.** Magic, header, `HDR_HMAC`, SUMMARY,
 * INDEX, a chunk, two chunks swapped, a chunk removed, the trailer, `TRL_HMAC`. Each has
 * exactly one right answer, and #6 versus #7 is not cosmetic: #7 says two plaintext numbers
 * disagree, which leaks nothing, while #6 is every failure a key was involved in.
 *
 * **The disaster path is a test, not a promise.** `keyslot 1 only` runs against a ring that
 * has never held the archive's key — a fresh VPS, a rebuilt database — and the recovery
 * phrase alone gets the data back. If that ever breaks, the whole feature is a copy of data
 * nobody can read.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5, §7, §9.
 */

/** The format's Argon2 floor. The real cost is a second per guess; this suite pays ms. */
const CHEAP_ARGON2: AfrArgon2Params = { m: 8 * 1024, t: 1, p: 1 };

const PHRASE = "gudang arsip lentera bambu selasar kunci embun pagar tinta";

/** 64 KiB, the smallest legal chunk — four chunks out of a 200 KiB payload. */
const CHUNK = MIN_CHUNK_SIZE;

function keyMaterial(): Buffer {
  return randomBytes(32);
}

function ringOf(active: Buffer, previous?: Buffer): AfrKeyRing {
  return parseMasterKeyRing({
    BACKUP_MASTER_KEY: active.toString("base64"),
    BACKUP_MASTER_KEY_PREVIOUS: previous?.toString("base64"),
  });
}

/**
 * Bytes whose every 4 KiB block states its own offset, so no two chunks of one archive
 * hold the same bytes — a swapped-chunk test that passed because both chunks were zeroes
 * would be proving nothing.
 */
function patternBuffer(n: number, seed = 0): Buffer {
  const buf = Buffer.alloc(n);
  for (let at = 0; at + 4 <= n; at += 4096) buf.writeUInt32LE((at + seed) >>> 0, at);
  return buf;
}

function flipByteAt(bytes: Buffer, at: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[at] ^= 0xff;
  return copy;
}

function spliceOut(bytes: Buffer, start: number, end: number): Buffer {
  return Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
}

function swapRegions(bytes: Buffer, a: number, b: number, width: number): Buffer {
  return Buffer.concat([
    bytes.subarray(0, a),
    bytes.subarray(b, b + width),
    bytes.subarray(a + width, b),
    bytes.subarray(a, a + width),
    bytes.subarray(b + width),
  ]);
}

/** The archive in `size`-byte pieces, the way a socket would deliver it. */
function pieces(bytes: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/** The refusal itself, so a test can read both `reason` and `detail` off it. */
async function refusal(run: () => Promise<unknown>): Promise<AccountBackupError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AccountBackupError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got a value");
}

/** `count` real files entries, plus the exact texts the reader must hand back. */
function filesIndex(count: number): { bytes: Buffer; lines: string[] } {
  const parts: Buffer[] = [];
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = encodeFilesEntry({
      kind: "file",
      path: `photos/2026/beach-${i}.jpg`,
      size: 1024 + i,
      sha256: createHash("sha256").update(`beach-${i}`).digest(),
      mime: "image/jpeg",
      createdAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_500_000 + i,
    });
    parts.push(bytes);
    lines.push(bytes.toString("utf8").slice(0, -1));
  }
  return { bytes: Buffer.concat(parts), lines };
}

function summaryOf(over: Partial<AfrSummary> = {}): AfrSummary {
  return {
    accountBackupId: newAccountBackupId(),
    appVersion: "1.4.2",
    counts: { folders: 3, files: 5, memories: 0, rows: 8 },
    schemaVersion: 28,
    sourceInstanceId: "afr-vps-1",
    totalBytes: 200 * 1024,
    ...over,
  };
}

interface BuildOptions {
  domain?: BackupDomain;
  /** An array to hand the writer awkward pieces; one buffer for the ordinary case. */
  payload?: Buffer | Buffer[];
  index?: Buffer;
  summary?: Partial<AfrSummary>;
  chunkSize?: number;
  argon2?: AfrArgon2Params;
  masterKey?: Buffer;
  phrase?: string;
  /** Last-moment surgery, for the writer's own guards. */
  over?: Partial<AfrWriteInput>;
}

interface Built {
  bytes: Buffer;
  report: AfrWriteReport;
  /** The ring that wrote it. A reading ring is chosen per test, and often differs. */
  ring: AfrKeyRing;
  masterKey: Buffer;
  input: AfrWriteInput;
  payload: Buffer;
  lines: string[];
  summary: AfrSummary;
}

/**
 * Drives the writer by hand rather than with `for await`, because the report is the
 * generator's *return* value and `for await` throws it away — which is exactly why the
 * route can ignore it while an exporter that wants the trailer's facts can keep them.
 */
async function drain(
  gen: AsyncGenerator<Buffer, AfrWriteReport, void>
): Promise<{ bytes: Buffer; report: AfrWriteReport }> {
  const out: Buffer[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { bytes: Buffer.concat(out), report: step.value };
    out.push(step.value);
  }
}

async function build(opts: BuildOptions = {}): Promise<Built> {
  const masterKey = opts.masterKey ?? randomBytes(32);
  const ring = ringOf(masterKey);
  const payloadParts = Array.isArray(opts.payload)
    ? opts.payload
    : [opts.payload ?? patternBuffer(200 * 1024)];
  const payload = Buffer.concat(payloadParts);
  const index = opts.index === undefined ? filesIndex(5) : { bytes: opts.index, lines: [] };
  const phraseSalt = newPhraseSalt();
  const argon2 = opts.argon2 ?? CHEAP_ARGON2;
  const summary = summaryOf({ totalBytes: payload.length, ...opts.summary });
  const input: AfrWriteInput = {
    domain: opts.domain ?? "files",
    backupId: randomUUID(),
    createdAt: 1_772_000_000_000,
    masterKey: ring.active,
    dek: newDek(),
    recoveryWrappingKey: await deriveRecoveryWrappingKey(
      opts.phrase ?? PHRASE,
      phraseSalt,
      argon2
    ),
    phraseSalt,
    argon2,
    summary,
    index: index.bytes,
    payload: payloadParts,
    chunkSize: opts.chunkSize ?? CHUNK,
    ...opts.over,
  };
  const { bytes, report } = await drain(writeArchive(input));
  return { bytes, report, ring, masterKey, input, payload, lines: index.lines, summary };
}

interface OpenOptions {
  expectedDomain?: BackupDomain;
  phrase?: string;
  /** Feed the reader in pieces of this width, to exercise the seam it has to hold. */
  slice?: number;
}

function open(bytes: Buffer, ring: AfrKeyRing, opts: OpenOptions = {}) {
  return openArchive({
    source: opts.slice === undefined ? [bytes] : pieces(bytes, opts.slice),
    ring,
    expectedDomain: opts.expectedDomain ?? "files",
    phrase: opts.phrase,
  });
}

/** Everything a caller does with an archive, in the one order the reader allows. */
async function readAll(bytes: Buffer, ring: AfrKeyRing, opts: OpenOptions = {}) {
  const reader = await open(bytes, ring, opts);
  const lines = await collect(reader.indexLines());
  const chunks = await collect(reader.readPayload());
  const trailer = await reader.finish();
  return { reader, lines, chunks, payload: Buffer.concat(chunks), trailer };
}

/** Where each region sits, computed from the archive's own plaintext preamble. */
function layoutOf(bytes: Buffer) {
  const preamble = decodePreamble(bytes.subarray(0, PREAMBLE_BYTES));
  const headerMac = PREAMBLE_BYTES + preamble.headerLength;
  const summary = headerMac + HMAC_BYTES;
  const index = summary + preamble.summaryLength;
  return {
    preamble,
    header: PREAMBLE_BYTES,
    headerMac,
    summary,
    index,
    chunks: index + preamble.indexLength,
    region: preamble.chunkSize + GCM_TAG_BYTES,
    trailer: bytes.length - TRAILER_BYTES - HMAC_BYTES,
  };
}

describe("one archive, written forwards and read forwards", () => {
  it("hands back the index, the payload and the trailer unchanged", async () => {
    const written = await build();

    const { reader, lines, payload, trailer } = await readAll(written.bytes, written.ring);

    expect(reader.preamble.domain).toBe("files");
    expect(reader.preamble.chunkSize).toBe(CHUNK);
    expect(reader.header.backupId).toBe(written.input.backupId);
    expect(reader.header.createdAt).toBe(written.input.createdAt);
    expect(reader.summary).toEqual(written.summary);
    expect(reader.via).toBe("master");
    expect(reader.keyId).toBe(written.ring.active.keyId);
    expect(reader.stale).toBe(false);
    expect(lines.map((line) => line.text)).toEqual(written.lines);
    expect(lines.map((line) => line.where)).toEqual([1, 2, 3, 4, 5].map((n) => `index line ${n}`));
    expect(payload.equals(written.payload)).toBe(true);
    expect(trailer.chunkCount).toBe(4);
    expect(trailer.totalPlaintextBytes).toBe(written.payload.length);
    expect(trailer.payloadSha256).toEqual(createHash("sha256").update(written.payload).digest());
    expect(written.report.archiveBytes).toBe(written.bytes.length);
    expect(written.report.chunkCount).toBe(4);
  });

  it("cuts every chunk but the last to exactly chunkSize", async () => {
    // The reader recomputes chunk i's boundaries from `chunkSize` alone, so a short chunk
    // anywhere but the end would desynchronise every chunk after it.
    const written = await build();

    const { chunks } = await readAll(written.bytes, written.ring);

    expect(chunks.map((chunk) => chunk.length)).toEqual([CHUNK, CHUNK, CHUNK, 8 * 1024]);
  });

  it("re-cuts a payload that arrives in pieces of every awkward width", async () => {
    // A producer hands over whatever R2 or a row serialiser gave it. The nonce scheme
    // needs exact widths, and `rechunk` is the only place that knows that.
    const payload = patternBuffer(200 * 1024);
    const written = await build({
      payload: [
        payload.subarray(0, 1),
        payload.subarray(1, 3),
        payload.subarray(3, 100_000),
        Buffer.alloc(0),
        payload.subarray(100_000, 199_999),
        payload.subarray(199_999),
      ],
    });

    const { chunks, payload: read } = await readAll(written.bytes, written.ring);

    expect(read.equals(payload)).toBe(true);
    expect(chunks.map((chunk) => chunk.length)).toEqual([CHUNK, CHUNK, CHUNK, 8 * 1024]);
  });

  it("survives a source that delivers the archive one byte at a time", async () => {
    const written = await build({ payload: patternBuffer(3 * 1024) });

    const { payload, trailer } = await readAll(written.bytes, written.ring, { slice: 1 });

    expect(payload.equals(written.payload)).toBe(true);
    expect(trailer.chunkCount).toBe(1);
  });

  it("writes and reads an archive that carries nothing at all", async () => {
    // A new account exporting an empty Files archive. `rechunk` must not emit a
    // zero-length final chunk, or the trailer's arithmetic counts one chunk too many.
    const written = await build({
      payload: Buffer.alloc(0),
      index: Buffer.alloc(0),
      summary: { counts: { folders: 0, files: 0, memories: 0, rows: 0 }, totalBytes: 0 },
    });

    const { lines, chunks, trailer } = await readAll(written.bytes, written.ring);

    expect(lines).toEqual([]);
    expect(chunks).toEqual([]);
    expect(trailer.chunkCount).toBe(0);
    expect(trailer.totalPlaintextBytes).toBe(0);
    expect(trailer.payloadSha256).toEqual(createHash("sha256").digest());
  });

  it("reaches the payload after skipping the index", async () => {
    // What the exporter's own verification pass does: it has no use for the lines, but it
    // cannot seek past them either, because their tag is what proves they were not edited.
    const written = await build({ payload: patternBuffer(3 * 1024) });
    const reader = await open(written.bytes, written.ring);

    await reader.skipIndex();
    const chunks = await collect(reader.readPayload());
    const trailer = await reader.finish();

    expect(Buffer.concat(chunks).equals(written.payload)).toBe(true);
    expect(trailer.chunkCount).toBe(1);
  });

  it("describes an archive from its first 80 KiB and nothing more", async () => {
    // The confirm screen. A 40 GB archive must not cost more to describe than an empty
    // one, and here the reader is handed a file that literally stops after the summary.
    const written = await build();
    const preview = previewLength(decodePreamble(written.bytes.subarray(0, PREAMBLE_BYTES)));

    const reader = await open(written.bytes.subarray(0, preview), written.ring);

    expect(reader.summary).toEqual(written.summary);
    expect(preview).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });
});

describe("driven out of order, which is our bug and not the file's", () => {
  // These are plain `Error`s on purpose: an `AccountBackupError` is something to show a
  // person, and "the caller read the payload before the index" is not.
  it("refuses the payload before the index has been read", async () => {
    const written = await build();
    const reader = await open(written.bytes, written.ring);

    await expect(reader.readPayload().next()).rejects.toThrow(/index pending/);
  });

  it("refuses to read the index twice", async () => {
    const written = await build();
    const reader = await open(written.bytes, written.ring);
    await reader.skipIndex();

    await expect(reader.indexLines().next()).rejects.toThrow(/index done/);
  });

  it("refuses to finish before the payload is drained", async () => {
    // `finish` is the only thing that authenticates the trailer, so a caller that could
    // call it early could be told an archive is whole while it is still reading it.
    const written = await build();
    const reader = await open(written.bytes, written.ring);
    await reader.skipIndex();

    await expect(reader.finish()).rejects.toThrow(/payload pending/);
  });

  it("refuses to finish twice", async () => {
    const written = await build({ payload: patternBuffer(3 * 1024) });
    const reader = await open(written.bytes, written.ring);
    await reader.skipIndex();
    await collect(reader.readPayload());
    await reader.finish();

    await expect(reader.finish()).rejects.toThrow(/twice/);
  });
});

describe("one edited byte, region by region", () => {
  it("is not an AFR backup when the magic is wrong", async () => {
    // Someone uploaded a photo. That is a sentence about the file, not about a key.
    const written = await build({ payload: patternBuffer(1024) });

    await expect(open(flipByteAt(written.bytes, 2), written.ring)).rejects.toThrow(
      NotAnAfrBackupError
    );
  });

  it("calls a file shorter than a preamble damaged, and says by how much", async () => {
    const written = await build({ payload: patternBuffer(1024) });

    const error = await refusal(() => open(written.bytes.subarray(0, 10), written.ring));

    expect(error).toBeInstanceOf(AfrCorruptError);
    expect(error.reason).toBe(7);
    expect(error.detail).toContain("preamble is 10 bytes");
  });

  it("refuses a header whose HDR_HMAC does not verify", async () => {
    const written = await build({ payload: patternBuffer(1024) });
    const at = layoutOf(written.bytes);

    const error = await refusal(() =>
      open(flipByteAt(written.bytes, at.headerMac + 4), written.ring)
    );

    expect(error).toBeInstanceOf(AfrUnreadableError);
    expect(error.reason).toBe(3);
    expect(error.detail).toContain("HDR_HMAC does not verify");
  });

  it("never acts on an edited header, whichever guard catches it", async () => {
    // The header is parsed before it is authenticated — unavoidable, because its `keyId`
    // is what says which key to authenticate it with. So an edit lands as either a
    // canonicalisation refusal (#7) or an HMAC refusal (#3), and never as a header we used.
    const written = await build({ payload: patternBuffer(1024) });
    const at = layoutOf(written.bytes);

    const error = await refusal(() => open(flipByteAt(written.bytes, at.header + 8), written.ring));

    expect([3, 7]).toContain(error.reason);
  });

  it("refuses a summary that does not authenticate", async () => {
    const written = await build({ payload: patternBuffer(1024) });
    const at = layoutOf(written.bytes);

    const error = await refusal(() =>
      open(flipByteAt(written.bytes, at.summary + 3), written.ring)
    );

    expect(error.reason).toBe(6);
    expect(error.detail).toContain("summary did not authenticate");
  });

  it("refuses an index whose tag was edited, after handing over every line", async () => {
    // The one unavoidable release-before-verify in the format: INDEX is a single GCM
    // region, so its tag arrives last. What makes it safe is the order §7.3 mandates —
    // nothing is committed until `finish` has resolved.
    const written = await build({ payload: patternBuffer(1024) });
    const at = layoutOf(written.bytes);
    const reader = await open(
      flipByteAt(written.bytes, at.index + at.preamble.indexLength - 1),
      written.ring
    );

    const error = await refusal(() => collect(reader.indexLines()));

    expect(error.reason).toBe(6);
    expect(error.detail).toContain("index did not authenticate");
  });

  it("refuses edited index ciphertext", async () => {
    const written = await build({ payload: patternBuffer(1024) });
    const at = layoutOf(written.bytes);
    const reader = await open(flipByteAt(written.bytes, at.index + 2), written.ring);

    // GCM is a stream cipher, so one edited byte garbles exactly one byte of one line.
    // A decoder may refuse that line first; if it does not, the tag refuses the region.
    // Either way no caller is handed the edited lines as good ones.
    const error = await refusal(() => collect(reader.indexLines()));

    expect([6, 7]).toContain(error.reason);
  });

  it("refuses an edited chunk, and names which one", async () => {
    const written = await build();
    const at = layoutOf(written.bytes);
    const reader = await open(flipByteAt(written.bytes, at.chunks + at.region + 5), written.ring);
    await reader.skipIndex();

    const error = await refusal(() => collect(reader.readPayload()));

    expect(error.reason).toBe(6);
    expect(error.detail).toBe("chunk 1 did not authenticate");
  });

  it("refuses two chunks that changed places", async () => {
    // Position is the nonce and the AAD, so a reordered chunk is a forgery even though
    // every byte of it is genuine and came from this very archive.
    const written = await build();
    const at = layoutOf(written.bytes);
    const reader = await open(
      swapRegions(written.bytes, at.chunks, at.chunks + 2 * at.region, at.region),
      written.ring
    );
    await reader.skipIndex();

    const error = await refusal(() => collect(reader.readPayload()));

    expect(error.detail).toBe("chunk 0 did not authenticate");
  });

  it("refuses an archive with a chunk cut out of the middle", async () => {
    const written = await build();
    const at = layoutOf(written.bytes);
    const reader = await open(
      spliceOut(written.bytes, at.chunks + at.region, at.chunks + 2 * at.region),
      written.ring
    );
    await reader.skipIndex();

    const error = await refusal(() => collect(reader.readPayload()));

    expect(error.detail).toBe("chunk 1 did not authenticate");
  });

  it("counts the chunks it read against the trailer's claim", async () => {
    // The last chunk removed. Every remaining chunk authenticates, the trailer
    // authenticates, and the archive is still short one chunk of the user's data —
    // which is exactly the check `finish` exists for.
    const written = await build();
    const at = layoutOf(written.bytes);
    const reader = await open(
      spliceOut(written.bytes, at.chunks + 3 * at.region, at.trailer),
      written.ring
    );
    await reader.skipIndex();
    const chunks = await collect(reader.readPayload());

    const error = await refusal(() => reader.finish());

    expect(chunks).toHaveLength(3);
    expect(error.reason).toBe(6);
    expect(error.detail).toBe("trailer claims 4 chunks, read 3");
  });

  it("refuses an edited trailer, so its numbers are never read", async () => {
    // TRL_HMAC is verified before the trailer is decoded, and it keys on the DEK and
    // chains onto HDR_HMAC — so a trailer lifted from another archive of the same account
    // fails here too, even though every chunk before it verified.
    const written = await build({ payload: patternBuffer(1024) });
    const at = layoutOf(written.bytes);
    const reader = await open(flipByteAt(written.bytes, at.trailer + 7), written.ring);
    await reader.skipIndex();
    await collect(reader.readPayload());

    const error = await refusal(() => reader.finish());

    expect(error.reason).toBe(6);
    expect(error.detail).toContain("trailer did not authenticate");
  });

  it("refuses an edited TRL_HMAC", async () => {
    const written = await build({ payload: patternBuffer(1024) });
    const reader = await open(
      flipByteAt(written.bytes, written.bytes.length - 1),
      written.ring
    );
    await reader.skipIndex();
    await collect(reader.readPayload());

    const error = await refusal(() => reader.finish());

    expect(error.detail).toContain("trailer did not authenticate");
  });

  it("refuses an archive that ends inside its trailer", async () => {
    // Cut mid-upload. The 80-byte reserve is how a forward reader tells "one more chunk"
    // from "the end", so a partial trailer is the one thing it can state exactly.
    const written = await build({ payload: Buffer.alloc(0) });
    const reader = await open(written.bytes.subarray(0, written.bytes.length - 20), written.ring);
    await reader.skipIndex();

    const error = await refusal(() => collect(reader.readPayload()));

    expect(error.reason).toBe(6);
    expect(error.detail).toBe("archive ends 60 bytes into its 80-byte trailer");
  });

  it("refuses a final chunk that is nothing but a tag", async () => {
    // 16 bytes past the reserve is a chunk region with no ciphertext in it. Refused for
    // its width rather than handed to GCM, so the message says what is wrong.
    const written = await build({ payload: Buffer.alloc(0) });
    const at = layoutOf(written.bytes);
    const reader = await open(
      Buffer.concat([
        written.bytes.subarray(0, at.trailer),
        Buffer.alloc(GCM_TAG_BYTES),
        written.bytes.subarray(at.trailer),
      ]),
      written.ring
    );
    await reader.skipIndex();

    const error = await refusal(() => collect(reader.readPayload()));

    expect(error.detail).toBe(`chunk 0 is ${GCM_TAG_BYTES} bytes`);
  });
});

describe("refusal #5, decided before a key is touched", () => {
  it("refuses a Files archive offered to the Brain restore screen", async () => {
    const written = await build({ domain: "files" });
    // A ring that has never seen this archive: proof the answer needed no key at all.
    // Telling someone they picked the wrong file beats a passphrase prompt they cannot
    // satisfy — and the domain is one plaintext byte, so it costs nothing to say.
    const stranger = ringOf(keyMaterial());

    const error = await refusal(() => open(written.bytes, stranger, { expectedDomain: "brain" }));

    expect(error).toBeInstanceOf(AfrDomainMismatchError);
    expect(error.reason).toBe(5);
  });

  it("binds the domain into every tag, so the byte and the crypto agree", async () => {
    const written = await build({ domain: "brain" });

    const { reader, trailer } = await readAll(written.bytes, written.ring, {
      expectedDomain: "brain",
    });

    expect(reader.preamble.domain).toBe("brain");
    expect(trailer.chunkCount).toBe(4);
  });
});

describe("the disaster path: a new server and nine words", () => {
  it("refuses, and says why, when the ring never held the archive's key", async () => {
    const written = await build({ payload: patternBuffer(1024) });
    const rebuilt = ringOf(keyMaterial());

    const error = await refusal(() => open(written.bytes, rebuilt));

    expect(error.reason).toBe(3);
    expect(error.detail).toContain("not in this server's ring");
    expect(error.detail).toContain("no recovery phrase supplied");
  });

  it("opens from keyslot 1 alone, on a server that holds no part of this archive", async () => {
    // The whole feature in one test. The old VPS is gone, the database was rebuilt, the
    // user row is new, and BACKUP_MASTER_KEY is a key this archive has never met. If this
    // ever breaks, the product is a copy of data nobody can read.
    const written = await build();
    const rebuilt = ringOf(keyMaterial());

    const { reader, lines, payload, trailer } = await readAll(written.bytes, rebuilt, {
      phrase: PHRASE,
    });

    expect(reader.via).toBe("phrase");
    expect(reader.keyId).toBe(written.ring.active.keyId);
    expect(reader.stale).toBe(false);
    expect(reader.summary.accountBackupId).toBe(written.summary.accountBackupId);
    expect(lines.map((line) => line.text)).toEqual(written.lines);
    expect(payload.equals(written.payload)).toBe(true);
    expect(trailer.chunkCount).toBe(4);
  });

  it("forgives the spacing a person retypes, and nothing else", async () => {
    const written = await build({ payload: patternBuffer(1024) });
    const rebuilt = ringOf(keyMaterial());

    const reader = await open(written.bytes, rebuilt, {
      phrase: `  ${PHRASE.split(" ").join("   ").toUpperCase()}\n`,
    });
    expect(reader.via).toBe("phrase");

    const error = await refusal(() => open(written.bytes, rebuilt, { phrase: `${PHRASE} lentera` }));
    expect(error.reason).toBe(4);
    expect(error.detail).toContain("keyslot 1 did not authenticate");
  });

  it("opens under a retired key and says the archive is stale", async () => {
    // Rotation, seen from the reading side: the key that wrapped this DEK has moved to
    // BACKUP_MASTER_KEY_PREVIOUS. It still opens, and `stale` is what lets the service
    // offer to re-wrap it before the old key is finally dropped.
    const written = await build();
    const rotated = ringOf(keyMaterial(), written.masterKey);

    const reader = await open(written.bytes, rotated);

    expect(reader.via).toBe("master");
    expect(reader.stale).toBe(true);
    expect(reader.keyId).toBe(written.ring.active.keyId);
  });

  it("lets a typed phrase pick the slot, so an unbound id can still be adopted", async () => {
    // §3.2 rule 2. A phrase is an explicit claim of ownership, and `assertOwnership` only
    // adopts an id no row binds when keyslot 1 is what opened the archive — so on a rebuilt
    // instance whose `.env` survived, preferring keyslot 0 would ignore a correct phrase and
    // refuse the restore as #6. Argon2id's second of CPU is the price of that being possible.
    const written = await build({ payload: patternBuffer(1024) });

    const reader = await open(written.bytes, written.ring, { phrase: PHRASE });

    expect(reader.via).toBe("phrase");
  });
});

describe("the index reader holds one line at a time", () => {
  async function linesOf(index: Buffer): Promise<AfrIndexLine[]> {
    const written = await build({ index, payload: Buffer.alloc(0) });
    const reader = await open(written.bytes, written.ring);
    return collect(reader.indexLines());
  }

  it("assembles lines across slice boundaries", async () => {
    // 600 entries is comfortably more than one 64 KiB decrypt slice, so most lines here
    // are split across two reads and one is split across the tag boundary as well.
    const index = filesIndex(600);

    const lines = await linesOf(index.bytes);

    expect(index.bytes.length).toBeGreaterThan(64 * 1024);
    expect(lines.map((line) => line.text)).toEqual(index.lines);
    expect(lines[0].lineNumber).toBe(1);
    expect(lines[599].where).toBe("index line 600");
  });

  it("refuses a line longer than any real entry, before buffering it", async () => {
    // The reader's memory bound: one line, not one index. An archive claiming a single
    // 64 MiB line would otherwise be a 64 MiB allocation on a 2 GB server.
    const huge = Buffer.concat([
      Buffer.from("x".repeat(AFR_MAX_INDEX_LINE_BYTES + 1), "utf8"),
      Buffer.from("\n", "utf8"),
    ]);

    const error = await refusal(() => linesOf(huge));

    expect(error).toBeInstanceOf(AfrCorruptError);
    expect(error.detail).toContain(`over ${AFR_MAX_INDEX_LINE_BYTES} bytes`);
  });

  it("refuses an index whose last line has no terminator", async () => {
    // Every line ends with one, so leftover bytes mean the INDEX was cut — even though
    // its tag verified, because the writer sealed exactly these bytes.
    const error = await refusal(() => linesOf(Buffer.from('{"kind":"folder"}', "utf8")));

    expect(error.detail).toContain("with no terminator");
  });

  it("refuses a carriage return, which could only be a second spelling of a newline", async () => {
    // Canonical JSON escapes every control character inside a string, so a raw CR can
    // only be framing. Accepting CRLF would make one line two different byte strings.
    const error = await refusal(() => linesOf(Buffer.from('{"kind":"folder"}\r\n', "utf8")));

    expect(error.detail).toContain("carriage return");
  });
});

describe("the writer refuses what it could not read back", () => {
  // These are programming errors rather than refusals to show a person: nothing here can
  // be caused by a file or by a passphrase, only by a caller passing bad arguments.
  it("refuses a chunk size outside the format's range", async () => {
    await expect(build({ chunkSize: MIN_CHUNK_SIZE - 1 })).rejects.toThrow(/is outside/);
    await expect(build({ chunkSize: MAX_CHUNK_SIZE + 1 })).rejects.toThrow(/is outside/);
  });

  it("refuses an index it would have to hold in memory whole", async () => {
    // Not a format rule — INDEX is length-prefixed and unbounded on the wire. It is an
    // honest statement that the *export* side builds this buffer before it seals it, so
    // the exporter has to refuse an account this large before it starts streaming.
    await expect(
      build({ over: { index: Buffer.alloc(AFR_MAX_INDEX_BYTES + 1) } })
    ).rejects.toThrow(/the exporter is expected to refuse/);
  });

  it("parses back the header it just wrote, so an unreadable archive is never produced", async () => {
    // One JSON parse of about a kilobyte per archive. A `backupId` that is not a UUID, a
    // salt of the wrong width, an Argon2 cost outside the readable range — each would
    // produce a file that looks finished and cannot be opened by the build that wrote it.
    await expect(build({ over: { backupId: "not-a-uuid" } })).rejects.toThrow();
    await expect(build({ argon2: { m: 1, t: 1, p: 1 } })).rejects.toThrow();
  });
});

/* ── only AFR can read it ─────────────────────────────────────────────────── */

/**
 * The downloaded file, read by anything that is not this application.
 *
 * The one above proves a stranger's *reader* is refused. This proves there is nothing for
 * a stranger to read in the first place — no key involved, no API called, just `grep` over
 * the bytes a person now has a copy of, on a laptop, in a Downloads folder, forever.
 *
 * Three markers stand in for the three encrypted regions, one each, because they fail
 * separately: SUMMARY holds the account's email, INDEX holds every path and file name, and
 * CHUNKS hold the bytes themselves. A file that sealed two of the three would pass any test
 * that only looked at the one it happened to choose.
 *
 * **What the file does admit**, deliberately and by design, is exactly the plaintext
 * inventory below: that it is an AFR backup, of which domain, in which format version, made
 * when, how large, in how many chunks, under which `keyId`, at which Argon2 cost. A reader
 * has to know where the regions are before it holds a key, and the `payloadSha256` in the
 * plaintext trailer has to be checkable against a stream it has already handed out. That
 * hash is the sharpest edge here: someone who guesses the payload *in its entirety*, byte
 * for byte, can confirm the guess by hashing it. It never reveals content, and it is the
 * only thing standing between a truncated download and a silently short restore, so it
 * stays in the clear — but the boundary is written down here rather than overstated.
 */
describe("what the downloaded file gives away to a stranger", () => {
  /** Non-ASCII on purpose: canonical JSON escapes control bytes, not scripts. */
  const OWNER_EMAIL = "siti.nurhaliza+arsip@contoh.example";
  const SECRET_PATH = "Dokumen Pribadi/Kontrak Rumah — Sitiنور.pdf";
  const SECRET_BODY = "Nomor rekening 8820-4471-9903 — saldo Rp 42.500.000\nkata sandi: melati";

  async function loaded() {
    return build({
      index: encodeFilesEntry({
        kind: "file",
        path: SECRET_PATH,
        size: SECRET_BODY.length,
        sha256: createHash("sha256").update(SECRET_BODY).digest(),
        mime: "application/pdf",
        createdAt: 1_770_000_000_000,
        updatedAt: 1_770_000_001_000,
      }),
      payload: Buffer.from(SECRET_BODY, "utf8"),
      summary: { email: OWNER_EMAIL },
    });
  }

  it("holds no byte of the user's data in the clear", async () => {
    const written = await loaded();

    // The control for every scan below: this one *is* in the file, in the clear, at byte 0.
    expect(written.bytes.includes(AFRBAK_MAGIC)).toBe(true);
    for (const marker of [OWNER_EMAIL, SECRET_PATH, SECRET_BODY]) {
      expect(written.bytes.includes(Buffer.from(marker, "utf8"))).toBe(false);
    }
    // Every substring of the path as well, since a leaked *fragment* of a file name is
    // still a leaked file name, and a partially-encrypted region would show up as one.
    for (const fragment of ["Dokumen", "Kontrak", "Sitiنور", "8820-4471", "melati", "@contoh"]) {
      expect(written.bytes.includes(Buffer.from(fragment, "utf8"))).toBe(false);
    }
    // The field names too: these are structure, not content, but INDEX and SUMMARY are the
    // only places they occur, so finding one means a region was written unsealed.
    for (const key of ['"path":', '"sha256":', '"email":', '"mime":', '"accountBackupId":']) {
      expect(written.bytes.includes(Buffer.from(key, "utf8"))).toBe(false);
    }
    // And the data really was in there: the same file opens and hands it all back.
    const { lines, payload, reader } = await readAll(written.bytes, written.ring);
    expect(reader.summary.email).toBe(OWNER_EMAIL);
    expect(lines[0].text).toContain(SECRET_PATH);
    expect(payload.toString("utf8")).toBe(SECRET_BODY);
  });

  it("says only structure in the regions it must leave readable", async () => {
    const written = await loaded();
    const at = layoutOf(written.bytes);
    const header: unknown = JSON.parse(
      written.bytes.subarray(at.header, at.headerMac).toString("utf8")
    );

    // An inventory, not a sample: `decodeHeader` refuses an unknown key, so a field cannot
    // join the header without also joining this list — which is the moment to ask whether
    // it belongs in the clear. `keyslot[i].ct` is a wrapped DEK, not a key.
    expect(Object.keys(header as Record<string, unknown>).sort()).toEqual([
      "argon2",
      "backupId",
      "chunkNoncePrefix",
      "createdAt",
      "indexNonce",
      "keyId",
      "keyslot",
      "phraseSalt",
      "summaryNonce",
    ]);
    expect(Object.keys(at.preamble).sort()).toEqual([
      "chunkSize",
      "domain",
      "formatVersion",
      "headerLength",
      "indexLength",
      "summaryLength",
    ]);
    // The trailer is 48 fixed bytes: a count, a hash, a length. Nothing to enumerate and
    // nothing to name — asserted as the widths they are, so a fourth field cannot appear
    // without this arithmetic failing.
    expect(TRAILER_BYTES).toBe(4 + 32 + 8 + 4);
    const trailer = decodeTrailer(
      written.bytes.subarray(at.trailer, at.trailer + TRAILER_BYTES),
      at.preamble.chunkSize
    );
    expect(trailer).toEqual({
      chunkCount: 1,
      payloadSha256: createHash("sha256").update(SECRET_BODY).digest(),
      totalPlaintextBytes: Buffer.byteLength(SECRET_BODY, "utf8"),
    });
  });

  it("writes different bytes for the same data twice, so a guess cannot be checked against it", async () => {
    // A fresh DEK, nonce prefix and phrase salt per archive. Deterministic ciphertext would
    // turn every download into an oracle: encrypt a candidate, compare, and the archive
    // answers questions about its own contents without ever being opened.
    const key = keyMaterial();
    const first = await build({ masterKey: key, payload: Buffer.from(SECRET_BODY, "utf8") });
    const second = await build({ masterKey: key, payload: Buffer.from(SECRET_BODY, "utf8") });

    expect(first.bytes.equals(second.bytes)).toBe(false);
    const a = layoutOf(first.bytes);
    const b = layoutOf(second.bytes);
    // The structure is identical — the whole difference is in keyed material, which is the
    // shape this property needs: the plaintext gives the same nothing away both times.
    expect(first.bytes.subarray(0, PREAMBLE_BYTES).equals(second.bytes.subarray(0, PREAMBLE_BYTES))).toBe(true);
    for (const region of ["summary", "index", "chunks"] as const) {
      const one = first.bytes.subarray(a[region], a[region] + 32);
      const two = second.bytes.subarray(b[region], b[region] + 32);
      expect(one.equals(two)).toBe(false);
    }
  });
});

