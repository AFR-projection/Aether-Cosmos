/**
 * The five stages, over fakes: no archive bytes, no database, no bucket.
 *
 * What `restoreAccountArchive` owns is an *order* — validate, reserve, import/stage, verify,
 * commit — and two invariants that only an order can carry: nothing is committed before the
 * trailer verifies, and the archive never gets a say in who owns the rows. So the reader is a
 * fake with no keys in it and the session is a fake that records when it would have committed,
 * which is the only way to assert on a sequence rather than on an outcome. The importers
 * underneath are the real ones — their own decisions are covered by their own suites.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3–§7.5, §10.
 */

import { createHash } from "crypto";
import { describe, expect, it } from "vitest";

import {
  describeFailure,
  restoreAccountArchive,
  type RestoreCaller,
  type RestoreLedger,
  type RestoreReadable,
  type RestoreReservationInput,
  type RestoreSession,
} from "@backup/account/application/import";
import type {
  BrainImportSink,
  FilesImportSink,
  RestoreMode,
} from "@backup/account/application/import-types";
import { BackupError } from "@backup/domain/errors";
import {
  AfrCorruptError,
  AfrQuotaError,
  AfrTooLargeError,
  AfrUnreadableError,
} from "@backup/account/domain/errors";
import type { AfrHeader, AfrPreamble, AfrTrailer } from "@backup/account/domain/format";
import {
  encodeFilesEntry,
  type AfrFileEntry,
  type AfrFilesEntry,
} from "@backup/account/domain/index-entries";
import type { AfrKeyRing } from "@backup/account/domain/keys";
import type { AfrSummary } from "@backup/account/domain/summary";
import type { BackupDomain } from "@backup/domain/types";

/**
 * A canonical `accountBackupId`: 52 base32 characters whose last one has four zero padding
 * bits. `"A".repeat(52)` is *not* one — `normalizeAccountBackupId` refuses it — and the
 * orchestrator normalizes, so the fixture has to be real.
 */
const OURS = `${"A".repeat(51)}0`;
const THEIRS = `${"B".repeat(51)}0`;

const CREATED = 1_700_000_000_000;
const UPDATED = 1_700_000_100_000;
const NOW = 1_700_000_200_000;

const RING: AfrKeyRing = { active: { keyId: "k1", key: Buffer.alloc(32, 7) }, previous: [] };

const BODY = "hello";
const BODY_BYTES = Buffer.from(BODY, "utf8");

function preamble(domain: BackupDomain): AfrPreamble {
  return {
    formatVersion: 1,
    domain,
    headerLength: 512,
    summaryLength: 320,
    indexLength: 128,
    chunkSize: 1024 * 1024,
  };
}

function header(): AfrHeader {
  const slot = {
    alg: "AES-256-GCM",
    nonce: Buffer.alloc(12, 1),
    ct: Buffer.alloc(48, 2),
  } as const;
  return {
    backupId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
    createdAt: CREATED,
    keyId: "k1",
    keyslot: [slot, slot],
    phraseSalt: Buffer.alloc(16, 3),
    argon2: { m: 65_536, t: 3, p: 1 },
    chunkNoncePrefix: Buffer.alloc(8, 4),
    summaryNonce: Buffer.alloc(12, 5),
    indexNonce: Buffer.alloc(12, 6),
  };
}

interface ReaderOptions {
  domain: BackupDomain;
  entries?: AfrFilesEntry[];
  payload?: Buffer[];
  summary?: Partial<AfrSummary>;
  via?: "master" | "phrase";
  stale?: boolean;
  /** Overrides the trailer's own arithmetic, which is all stage 4 checks. */
  trailerBytes?: number;
  /** A trailer that never verifies: truncation, or a chunk from another archive. */
  finishFails?: Error;
}

/** A reader that yields a well-formed archive and records when it was asked to verify. */
function fakeReader(options: ReaderOptions, trace: string[]): RestoreReadable {
  const entries = options.entries ?? [];
  const files = entries.filter((entry) => entry.kind === "file");
  const declared = files.reduce((sum, entry) => sum + entry.size, 0);
  const summary: AfrSummary = {
    accountBackupId: OURS,
    appVersion: "test",
    counts: {
      folders: entries.length - files.length,
      files: files.length,
      memories: 0,
      rows: entries.length,
    },
    schemaVersion: 28,
    sourceInstanceId: "test-instance",
    totalBytes: declared,
    ...options.summary,
  };
  return {
    preamble: preamble(options.domain),
    header: header(),
    summary,
    via: options.via ?? "master",
    keyId: "k1",
    stale: options.stale ?? false,
    async *indexLines() {
      trace.push("reader:index");
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
      trace.push("reader:payload");
      for (const piece of options.payload ?? []) yield piece;
    },
    async finish(): Promise<AfrTrailer> {
      trace.push("reader:finish");
      if (options.finishFails) throw options.finishFails;
      return {
        chunkCount: (options.payload ?? []).length,
        payloadSha256: createHash("sha256")
          .update(Buffer.concat(options.payload ?? []))
          .digest(),
        totalPlaintextBytes: options.trailerBytes ?? summary.totalBytes,
      };
    },
  };
}

interface LedgerOptions {
  reserveFails?: Error;
  abandonFails?: Error;
}

/** The bookkeeping half, recorded rather than performed. */
function fakeLedger(options: LedgerOptions = {}, trace: string[] = []) {
  const reserved: RestoreReservationInput[] = [];
  const settled: { id: string; rows: number; bytes: number }[] = [];
  const abandoned: { id: string; reason: string }[] = [];
  const ledger: RestoreLedger = {
    async reserve(input) {
      trace.push("ledger:reserve");
      if (options.reserveFails) throw options.reserveFails;
      reserved.push(input);
      return "batch-1";
    },
    async settle(restoreBatchId, written) {
      trace.push("ledger:settle");
      settled.push({ id: restoreBatchId, ...written });
    },
    async abandon(restoreBatchId, reason) {
      trace.push("ledger:abandon");
      if (options.abandonFails) throw options.abandonFails;
      abandoned.push({ id: restoreBatchId, reason });
    },
  };
  return { ledger, reserved, settled, abandoned };
}

/**
 * A session whose commit is observable.
 *
 * `run` commits by returning, so "committed" is recorded *after* the body resolves — which is
 * exactly the seam every ordering assertion in this file is about.
 */
function fakeSession<S>(sink: S, trace: string[]) {
  const state = { committed: false, rolledBack: false };
  const session: RestoreSession<S> = {
    async run(restoreBatchId, body) {
      trace.push(`session:open ${restoreBatchId}`);
      try {
        const result = await body(sink);
        trace.push("session:commit");
        state.committed = true;
        return result;
      } catch (error) {
        trace.push("session:rollback");
        state.rolledBack = true;
        throw error;
      }
    },
  };
  return { session, state };
}

/** A sink that accepts everything and remembers only that it was written through. */
function fakeFilesSink(trace: string[], createFileFails?: Error) {
  const written: string[] = [];
  const noFolders: { path: string; id: string }[] = [];
  const noFiles: { path: string; sha256: string | null }[] = [];
  const sink: FilesImportSink = {
    async *liveFolders() {
      for (const row of noFolders) yield row;
    },
    async *liveFiles() {
      for (const row of noFiles) yield row;
    },
    async createFolder(row) {
      trace.push(`sink:folder ${row.materializedPath}`);
      written.push(row.materializedPath);
      return `fld-${written.length}`;
    },
    async createFile(row, body) {
      trace.push(`sink:file ${row.name}`);
      if (createFileFails) throw createFileFails;
      if (body.kind === "object") {
        for await (const piece of body.bytes) written.push(`${piece.length}b`);
      }
    },
  };
  return { sink, written };
}

function fakeBrainSink(trace: string[]) {
  const sink: BrainImportSink = {
    async hasDefaultBrain() {
      trace.push("sink:hasDefaultBrain");
      return false;
    },
    async insert(table, rows) {
      trace.push(`sink:insert ${table.name} ${rows.length}`);
    },
    async relink(table, column, pairs) {
      trace.push(`sink:relink ${table.name}.${column} ${pairs.length}`);
    },
  };
  return { sink };
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** One folder and one five-byte file: the smallest archive that writes anything. */
function filesArchive(): { entries: AfrFilesEntry[]; payload: Buffer[] } {
  const entry: AfrFileEntry = {
    kind: "file",
    path: "Photos/note.txt",
    size: BODY_BYTES.length,
    sha256: createHash("sha256").update(BODY_BYTES).digest(),
    mime: "text/plain",
    createdAt: CREATED,
    updatedAt: UPDATED,
  };
  return {
    entries: [{ kind: "folder", path: "Photos", createdAt: CREATED, updatedAt: UPDATED }, entry],
    payload: [BODY_BYTES],
  };
}

interface RunOptions {
  mode?: RestoreMode;
  caller?: Partial<RestoreCaller>;
  phrase?: string;
  reader?: Partial<ReaderOptions>;
  ledger?: LedgerOptions;
  createFileFails?: Error;
}

async function runFiles(options: RunOptions = {}) {
  const wired = wireFiles(options);
  const outcome = await restoreAccountArchive(wired.input);
  return { outcome, ...wired };
}

function wireFiles(options: RunOptions = {}) {
  const trace: string[] = [];
  const archive = filesArchive();
  const opened: { expectedDomain: BackupDomain; phrase?: string }[] = [];
  const reader = fakeReader(
    { domain: "files", entries: archive.entries, payload: archive.payload, ...options.reader },
    trace
  );
  const { sink, written } = fakeFilesSink(trace, options.createFileFails);
  const { session, state } = fakeSession(sink, trace);
  const { ledger, reserved, settled, abandoned } = fakeLedger(options.ledger, trace);
  const input = {
    source: [],
    ring: RING,
    mode: options.mode ?? "merge",
    caller: { userId: "user-1", boundIds: [{ accountBackupId: OURS }], ...options.caller },
    ledger,
    target: { domain: "files" as const, session },
    phrase: options.phrase,
    now: NOW,
    open: async (input: { expectedDomain: BackupDomain; phrase?: string }) => {
      trace.push("reader:open");
      opened.push({ expectedDomain: input.expectedDomain, phrase: input.phrase });
      return reader;
    },
  };
  return { input, trace, written, state, reserved, settled, abandoned, opened };
}

/**
 * The brain path, over an empty archive.
 *
 * Empty on purpose: what is under test here is which sink the orchestrator reaches for and
 * what it forwards to it, not the row mapping — sixty-one tests already cover that, and a
 * hand-built brain payload would only re-test them badly.
 */
function wireBrain(options: RunOptions = {}) {
  const trace: string[] = [];
  const opened: { expectedDomain: BackupDomain; phrase?: string }[] = [];
  const reader = fakeReader({ domain: "brain", ...options.reader }, trace);
  const { sink } = fakeBrainSink(trace);
  const { session, state } = fakeSession(sink, trace);
  const { ledger, reserved, settled, abandoned } = fakeLedger(options.ledger, trace);
  const input = {
    source: [],
    ring: RING,
    mode: options.mode ?? "merge",
    caller: { userId: "user-1", boundIds: [{ accountBackupId: OURS }], ...options.caller },
    ledger,
    target: { domain: "brain" as const, session },
    phrase: options.phrase,
    now: NOW,
    open: async (input: { expectedDomain: BackupDomain; phrase?: string }) => {
      trace.push("reader:open");
      opened.push({ expectedDomain: input.expectedDomain, phrase: input.phrase });
      return reader;
    },
  };
  return { input, trace, state, reserved, settled, abandoned, opened };
}

/**
 * The refusal a call raised, typed.
 *
 * Every crypto and integrity refusal shares one fixed `message` by design (§12), so
 * `rejects.toThrow` cannot tell them apart — the error has to be caught to be read.
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
  throw new Error(`expected ${ctor.name}, but the call resolved`);
}

/* ── the order ────────────────────────────────────────────────────────────── */

describe("restoreAccountArchive — the five stages", () => {
  it("validates, reserves, imports, verifies, then commits — in that order", async () => {
    const { trace, state } = await runFiles();

    expect(trace).toEqual([
      "reader:open",
      "ledger:reserve",
      "session:open batch-1",
      "reader:index",
      "sink:folder /Photos/",
      // The payload is pulled from inside `createFile`: the sink is handed a lazy body, so
      // the first byte is read only when the row that owns it is being written.
      "sink:file note.txt",
      "reader:payload",
      "reader:finish",
      "session:commit",
      "ledger:settle",
    ]);
    expect(state.committed).toBe(true);
  });

  it("verifies the trailer before the session commits", async () => {
    const { trace } = await runFiles();

    expect(trace.indexOf("reader:finish")).toBeLessThan(trace.indexOf("session:commit"));
  });

  it("reserves before it writes, and settles only after the commit", async () => {
    const { trace } = await runFiles();

    expect(trace.indexOf("ledger:reserve")).toBeLessThan(trace.indexOf("sink:folder /Photos/"));
    expect(trace.indexOf("session:commit")).toBeLessThan(trace.indexOf("ledger:settle"));
  });

  it("asks the archive for the domain the caller chose, and forwards the phrase", async () => {
    const { opened } = await runFiles({ phrase: "correct horse battery staple" });

    expect(opened).toEqual([
      { expectedDomain: "files", phrase: "correct horse battery staple" },
    ]);
  });
});

/* ── what the ledger is told ───────────────────────────────────────────────── */

describe("restoreAccountArchive — the reservation", () => {
  it("reserves against the header and the summary, never against the request", async () => {
    const { reserved } = await runFiles({ mode: "replace" });

    expect(reserved).toEqual([
      {
        userId: "user-1",
        domain: "files",
        mode: "replace",
        backupId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
        formatVersion: 1,
        keyId: "k1",
        expectedRows: 2,
        expectedBytes: BODY_BYTES.length,
      },
    ]);
  });

  it("settles with what landed, not with what the archive claimed", async () => {
    const { settled, outcome } = await runFiles();

    // One folder plus one file, five bytes: `written_rows`/`written_bytes` are measured.
    expect(settled).toEqual([{ id: "batch-1", rows: 2, bytes: BODY_BYTES.length }]);
    expect(outcome.report).toEqual({
      domain: "files",
      mode: "merge",
      rows: 2,
      bytes: BODY_BYTES.length,
      skipped: 0,
      renamed: 0,
    });
  });

  it("reports the provenance the audit row and the identity binding both read", async () => {
    const { outcome } = await runFiles({ reader: { stale: true } });

    expect(outcome.restoreBatchId).toBe("batch-1");
    expect(outcome.backupId).toBe("3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8");
    expect(outcome.createdAt).toBe(CREATED);
    expect(outcome.formatVersion).toBe(1);
    expect(outcome.keyId).toBe("k1");
    expect(outcome.via).toBe("master");
    expect(outcome.stale).toBe(true);
    expect(outcome.adopted).toBe(false);
    expect(outcome.summary.accountBackupId).toBe(OURS);
  });
});

/* ── who the archive belongs to ────────────────────────────────────────────── */

describe("restoreAccountArchive — ownership", () => {
  it("refuses an archive this account never bound, before it reserves anything", async () => {
    const wired = wireFiles({ reader: { summary: { accountBackupId: THEIRS } } });

    const error = await caught(AfrUnreadableError, () => restoreAccountArchive(wired.input));

    expect(error.reason).toBe(6);
    expect(error.detail).toBe(`accountBackupId AFR-BBBB-BBBB… is not bound to this account`);
    // The response says nothing about which of the nine this was (§12).
    expect(error.code).toBe("AFRBAK_UNREADABLE");
    expect(wired.trace).toEqual(["reader:open"]);
    expect(wired.reserved).toEqual([]);
    expect(wired.abandoned).toEqual([]);
  });

  it("refuses it even though the server's own key opened it", async () => {
    const wired = wireFiles({
      reader: { via: "master", summary: { accountBackupId: THEIRS } },
    });

    // The whole point of #6: one `BACKUP_MASTER_KEY` opens every archive this instance wrote,
    // so holding the key is not evidence of ownership (§10).
    await caught(AfrUnreadableError, () => restoreAccountArchive(wired.input));
    expect(wired.reserved).toEqual([]);
  });

  it("adopts an unbound id when the recovery phrase opened it", async () => {
    const { outcome, settled } = await runFiles({
      reader: { via: "phrase", summary: { accountBackupId: THEIRS } },
      phrase: "correct horse battery staple",
    });

    // The disaster path: after a rebuild no identity row mentions the old archive, and the
    // phrase is the proof the missing row can no longer give (§3.2, §7.1).
    expect(outcome.adopted).toBe(true);
    expect(outcome.via).toBe("phrase");
    expect(settled).toHaveLength(1);
  });

  it("does not adopt what is already bound, phrase or no phrase", async () => {
    const { outcome } = await runFiles({ reader: { via: "phrase" } });

    expect(outcome.adopted).toBe(false);
  });

  it("matches a bound id through its canonical form, not by string equality", async () => {
    const { outcome } = await runFiles({
      caller: { boundIds: [{ accountBackupId: OURS.toLowerCase() }] },
    });

    expect(outcome.adopted).toBe(false);
  });
});

/* ── giving up ─────────────────────────────────────────────────────────────── */

describe("restoreAccountArchive — failure", () => {
  it("refuses a payload shorter than the summary declared, and never commits", async () => {
    const wired = wireFiles({ reader: { trailerBytes: BODY_BYTES.length - 1 } });

    const error = await caught(AfrCorruptError, () => restoreAccountArchive(wired.input));

    expect(error.detail).toBe("payload carried 4 bytes, the summary declared 5");
    expect(wired.state.committed).toBe(false);
    expect(wired.state.rolledBack).toBe(true);
    expect(wired.settled).toEqual([]);
    expect(wired.abandoned).toEqual([
      { id: "batch-1", reason: "refusal 7: payload carried 4 bytes, the summary declared 5" },
    ]);
  });

  it("rolls back and abandons when the trailer itself does not verify", async () => {
    const wired = wireFiles({
      reader: { finishFails: new AfrUnreadableError(6, "TRL_HMAC mismatch") },
    });

    const error = await caught(AfrUnreadableError, () => restoreAccountArchive(wired.input));

    expect(error.reason).toBe(6);
    expect(wired.state.committed).toBe(false);
    expect(wired.abandoned).toEqual([
      { id: "batch-1", reason: "refusal 6: TRL_HMAC mismatch" },
    ]);
  });

  it("keeps a driver failure out of `restore_batches.error`, and its code in", async () => {
    const duplicate = Object.assign(new Error("duplicate key value violates …"), {
      name: "PostgresError",
      code: "23505",
    });
    const wired = wireFiles({ createFileFails: duplicate });

    await expect(restoreAccountArchive(wired.input)).rejects.toThrow(duplicate);

    // A Postgres message quotes the offending row, which is the user's own content.
    expect(wired.abandoned).toEqual([{ id: "batch-1", reason: "PostgresError (23505)" }]);
    expect(wired.state.rolledBack).toBe(true);
    expect(wired.settled).toEqual([]);
  });

  it("stops at the reservation when the quota refuses it (#9)", async () => {
    const wired = wireFiles({ ledger: { reserveFails: new AfrQuotaError(10, 5) } });

    const error = await caught(AfrQuotaError, () => restoreAccountArchive(wired.input));

    expect(error.status).toBe(409);
    // No batch id exists yet, so there is nothing to abandon and nothing to sweep.
    expect(wired.trace).toEqual(["reader:open", "ledger:reserve"]);
    expect(wired.abandoned).toEqual([]);
  });

  it("refuses a row count over the cap before it reserves (#8)", async () => {
    const wired = wireFiles({
      reader: { summary: { counts: { folders: 1, files: 400_000, memories: 0, rows: 400_001 } } },
    });

    const error = await caught(AfrTooLargeError, () => restoreAccountArchive(wired.input));

    expect(error.reason).toBe(8);
    expect(wired.trace).toEqual(["reader:open"]);
  });

  it("lets the original failure through when the release itself fails", async () => {
    const wired = wireFiles({
      reader: { trailerBytes: 1 },
      ledger: { abandonFails: new Error("connection lost") },
    });

    // The sweeper is the backstop for the row this could not mark (§7.6); what the user must
    // see is why the restore stopped, not why the cleanup did.
    const error = await caught(AfrCorruptError, () => restoreAccountArchive(wired.input));

    expect(error.detail).toBe("payload carried 1 bytes, the summary declared 5");
    expect(wired.settled).toEqual([]);
  });
});

/* ── the other domain ──────────────────────────────────────────────────────── */

describe("restoreAccountArchive — brain", () => {
  it("runs the brain importer through the brain session, in the same order", async () => {
    const wired = wireBrain();

    const outcome = await restoreAccountArchive(wired.input);

    expect(wired.opened).toEqual([{ expectedDomain: "brain", phrase: undefined }]);
    expect(wired.trace).toEqual([
      "reader:open",
      "ledger:reserve",
      "session:open batch-1",
      "reader:index",
      "sink:hasDefaultBrain",
      "reader:payload",
      "reader:finish",
      "session:commit",
      "ledger:settle",
    ]);
    expect(outcome.report).toEqual({
      domain: "brain",
      mode: "merge",
      rows: 0,
      bytes: 0,
      skipped: 0,
      renamed: 0,
    });
    expect(wired.state.committed).toBe(true);
  });

  it("carries the mode into the report without letting it change the import", async () => {
    const wired = wireBrain({ mode: "replace" });

    const outcome = await restoreAccountArchive(wired.input);

    expect(outcome.report.mode).toBe("replace");
    expect(wired.reserved[0].mode).toBe("replace");
    expect(wired.reserved[0].domain).toBe("brain");
  });
});

/* ── what the batch row is allowed to remember ─────────────────────────────── */

describe("describeFailure", () => {
  it("keeps a refusal's number and its detail — both written by us", () => {
    expect(describeFailure(new AfrCorruptError("indexLength 9 exceeds the cap"))).toBe(
      "refusal 7: indexLength 9 exceeds the cap"
    );
  });

  it("reduces another backup error to its class and its code", () => {
    expect(describeFailure(new BackupError("gone", 404, "BACKUP_NOT_FOUND"))).toBe(
      "BackupError (BACKUP_NOT_FOUND)"
    );
  });

  it("keeps a driver's code and drops its message", () => {
    const error = Object.assign(new Error("null value in column \"name\" of relation \"files\""), {
      name: "PostgresError",
      code: "23502",
    });

    expect(describeFailure(error)).toBe("PostgresError (23502)");
  });

  it("falls back to a name when there is no code at all", () => {
    expect(describeFailure(new Error("something opaque"))).toBe("Error");
    expect(describeFailure(new TypeError("x is not a function"))).toBe("TypeError");
    expect(describeFailure("a thrown string")).toBe("string");
    expect(describeFailure(undefined)).toBe("undefined");
  });

  it("clips a long detail to what the column should hold", () => {
    const reason = describeFailure(new AfrCorruptError("x".repeat(500)));

    expect(reason).toHaveLength(200);
    expect(reason.endsWith("…")).toBe(true);
    expect(reason.startsWith("refusal 7: xxx")).toBe(true);
  });
});
