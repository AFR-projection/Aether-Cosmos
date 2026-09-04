/**
 * The importer's ports, the shapes that cross them, and the counter both halves share.
 *
 * The mirror of `export-types.ts`, for the same reason: everything that *decides* something
 * — which path is legal, which row is a duplicate, what a name becomes when it collides —
 * lives in `application/` behind these interfaces, and everything that talks to Postgres or
 * R2 lives in `infrastructure/` implementing them. So the whole of §7.5's merge algebra and
 * §11's hostile-input rules are unit-testable against a fake, with no database and no bucket.
 *
 * Three things this file deliberately does not describe:
 *
 *   - **A transaction.** The Brain import runs inside one and the Files import does not
 *     (§7.3). That is a difference between the two sinks' *implementations*, not between
 *     their ports: `import.ts` owns the transaction and hands a sink one already open.
 *   - **Anything about keys.** A sink never sees a DEK, a phrase, or an archive. It is given
 *     rows and byte streams that have already been decrypted, validated and remapped.
 *   - **When to commit.** No port here can commit, because the one rule that makes the
 *     reader safe — nothing is committed before `finish()` resolves — is `import.ts`'s to
 *     keep, and a sink that could commit would be a place to break it from.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.5.
 */

import { AfrCorruptError } from "@backup/account/domain/errors";
import type { AfrIndexLine } from "@backup/account/domain/archive";
import type { AfrSummary } from "@backup/account/domain/summary";
import type { AccountTable } from "@backup/account/domain/tables";
import type { BackupDomain } from "@backup/domain/types";

/** §7.5's two behaviours. `replace` differs only at commit — and in never reusing a row. */
export type RestoreMode = "merge" | "replace";

/**
 * As much of `AfrArchiveReader` as an importer is allowed to touch.
 *
 * Structural on purpose: a test drives the real reader over real bytes for the format tests,
 * and a three-line fake for the hundred tests about paths and merges. What is missing is the
 * part that must not be called from here — `finish()`, whose result is the gate on committing
 * and therefore belongs to the stage that commits.
 */
export interface AfrReadable {
  readonly summary: AfrSummary;
  indexLines(): AsyncGenerator<AfrIndexLine, void, void>;
  readPayload(): AsyncGenerator<Buffer, void, void>;
}

/* ── the byte counter ─────────────────────────────────────────────────────── */

/**
 * How many bytes this restore may still write.
 *
 * §11 puts it plainly: the size an archive announces is not trusted. The SUMMARY's
 * `totalBytes` is what stage 2 reserved quota for, so it is also the ceiling stage 3 is
 * allowed to write — and the check has to be a running one, because a header claiming 40 MB
 * in front of a 40 GB payload is a disk-filling attack that a check at the end would perform
 * in full before noticing.
 *
 * A hard refusal rather than a truncation: half a file is not a restore.
 */
export interface ImportBudget {
  /** Charge bytes about to be written. Throws when the archive exceeds what it declared. */
  spend(bytes: number): void;
  /** What has been charged, for the batch's `written_bytes` column. */
  spent(): number;
}

/**
 * A budget of exactly what the SUMMARY declared.
 *
 * Refusal #7 rather than #9: the quota question was settled under a row lock in stage 2 and
 * the answer was yes. An archive that then delivers more bytes than its own SUMMARY promised
 * is an archive disagreeing with itself, which is damage, and telling the user "you are out
 * of space" would send them to buy storage they do not need.
 */
export function declaredBudget(totalBytes: number): ImportBudget {
  let used = 0;
  return {
    spend(bytes: number): void {
      used += bytes;
      if (used > totalBytes) {
        throw new AfrCorruptError(
          `payload has delivered ${used} bytes, past the declared ${totalBytes}`
        );
      }
    },
    spent: () => used,
  };
}

/* ── Files ────────────────────────────────────────────────────────────────── */

/**
 * A folder row the importer has decided on.
 *
 * `materializedPath` and `depth` are computed here, from the parent chain this importer
 * itself walked — never carried from the archive (§11). They are in the app's own storage
 * spelling, `/Photos/2026/`, not the archive's `Photos/2026`.
 */
export interface StagedFolder {
  parentId: string | null;
  name: string;
  materializedPath: string;
  depth: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A file row the importer has decided on.
 *
 * `sha256` is what the INDEX declared, and the bytes are checked against it — but *when* that
 * check happens differs by body kind, and a sink has to know which it is looking at. A note's
 * body is collected before `createFile` is called, so its digest is already proven. An object's
 * body *is* the stream `createFile` drains, so its digest cannot be known until `createFile`
 * has returned, and the importer checks it immediately afterwards.
 *
 * That asymmetry is exactly what staging pays for. A row and an object can already be written
 * when the digest turns out to be wrong; neither is visible, the restore is refused before any
 * commit, and the sweeper owns what is left behind.
 */
export interface StagedFile {
  folderId: string | null;
  name: string;
  mime: string;
  size: number;
  /** Lowercase hex, the spelling `files.checksum_sha256` already uses. */
  sha256: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The body, in the one shape the sink can act on.
 *
 * A note's body is a row in `file_contents` and never an object in the bucket, which is why
 * the two are different variants rather than one stream and a flag: there is no `r2Key` in
 * the note case and no plaintext to hold in the object case. `is_note` is not carried by the
 * archive at all — it is this discriminant, inferred by `import-files.ts` from the name, the
 * MIME and whether the bytes parse.
 */
export type StagedBody =
  | { kind: "object"; bytes: AsyncIterable<Uint8Array> }
  | { kind: "note"; content: unknown; annotations: unknown };

/**
 * What the Files import writes through.
 *
 * The two `live*` readers exist for `merge` and are not called at all by `replace`, which
 * soft-deletes everything it did not write and therefore has nothing to match against. They
 * are streams rather than lookups on purpose: one pass over the account's own rows costs one
 * query, where a `findByPath` per entry costs fifty thousand.
 *
 * `createFile` inserts the row **before** it writes the object, and that order is not an
 * implementation detail. The row is the only handle the sweeper has on a staged object: an
 * upload that succeeded under a row that was never written is an object nobody can find and
 * everybody keeps paying for.
 */
export interface FilesImportSink {
  /** Live folders, as archive-form paths (`Photos/2026`, no surrounding separator). */
  liveFolders(): AsyncIterable<{ path: string; id: string }>;
  /**
   * Live files, as archive-form paths, with the stored digest where there is one.
   *
   * `null` is common and means the row predates checksum recording. §7.5 matches on digest
   * *and* path, so a null can never match: the archive's copy lands beside it as
   * `name (restored)`. Duplicating a file is undoable in one click; overwriting the wrong
   * one because two unknowns looked equal is not.
   */
  liveFiles(): AsyncIterable<{ path: string; sha256: string | null }>;
  /** Insert one staged folder row. Returns its id. */
  createFolder(row: StagedFolder): Promise<string>;
  /** Insert one staged file row, then write its body. */
  createFile(row: StagedFile, body: StagedBody): Promise<void>;
}

/* ── Brain ────────────────────────────────────────────────────────────────── */

/**
 * What the Brain import writes through.
 *
 * Rows arrive already remapped: every id is a fresh uuid, every reference points at the id
 * this same import minted for its target, and every `owner` column has been overwritten with
 * the restoring account. So a sink here is a `INSERT INTO <table> (<keys>) VALUES …` and
 * nothing else — it does not know what a brain is.
 *
 * Batched because the cap is half a million rows and a round trip each would be a restore
 * measured in hours. The importer batches within one table, in rank order, so a batch never
 * straddles a foreign-key dependency.
 */
export interface BrainImportSink {
  /**
   * Does the account already have a default brain?
   *
   * `brains_owner_default_unique` is a partial unique index on `(owner_user_id) WHERE
   * is_default`, and it is the single brain-domain constraint a restore can collide with. So
   * `is_default` is decided here rather than carried: yes for the first brain of an empty
   * account, no for every brain arriving beside one.
   */
  hasDefaultBrain(): Promise<boolean>;
  insert(table: AccountTable, rows: readonly Record<string, unknown>[]): Promise<void>;
  /**
   * The self-reference second pass — `memories.superseded_by_id`, and anything shaped like
   * it. It cannot be part of the INSERT: the row it points at may not exist yet, and the
   * archive is free to list a memory before the one that superseded it.
   */
  relink(
    table: AccountTable,
    column: string,
    pairs: readonly { id: string; value: string }[]
  ): Promise<void>;
}

/* ── the result ───────────────────────────────────────────────────────────── */

/**
 * What one import wrote, in the vocabulary the audit row and the UI both use.
 *
 * `rows` and `bytes` are what actually landed, never what the SUMMARY claimed — they are the
 * `written_rows`/`written_bytes` half of the pair `restore_batches` keeps precisely so an
 * archive's own arithmetic can be checked against reality.
 *
 * `skipped` and `renamed` are zero for `replace` and for Brain, and are the two numbers that
 * make `merge` explicable to the person who ran it: "1,204 already here, 3 came back under a
 * new name" is a sentence; "1,207 files processed" is not.
 */
export interface ImportReport {
  domain: BackupDomain;
  mode: RestoreMode;
  rows: number;
  bytes: number;
  skipped: number;
  renamed: number;
}





