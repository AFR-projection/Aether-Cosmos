/**
 * What the exporter needs from the world, stated as two small ports.
 *
 * Everything downstream of these interfaces — which rows travel, what an INDEX line says,
 * where a payload byte comes from, when an account is refused — is decided by pure code
 * over these types, and is therefore testable without a database, without R2, and without
 * a network. The Drizzle and S3 implementations live in `../infrastructure` and hold no
 * policy at all beyond "which rows belong to this caller".
 *
 * **Both ports are read twice.** The format puts INDEX ahead of CHUNKS, so the archive
 * has to say what it holds before it sends it: one pass measures, a second pass streams.
 * That is the single most important thing to know about this file, and the source
 * implementations are written to make the two passes agree — a stable order, and rows
 * restricted to those that already existed when the export began.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §6.4.
 */

import type { BackupDomain } from "@backup/domain/types";
import type { AfrCounts, AfrDateRange } from "@backup/account/domain/summary";
import type { AccountTable } from "@backup/account/domain/tables";

/* ── files ────────────────────────────────────────────────────────────────── */

/** A folder, which is content in its own right: an empty one still travels. */
export interface ExportFolderRow {
  /** Slash-joined, relative to the account root, no leading or trailing separator. */
  path: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/**
 * Where a file's bytes come from.
 *
 * A note has no R2 object: its body is Tiptap JSON in `file_contents`, and the archive
 * carries the canonical bytes of `{annotations, content}` as that file's payload. Nothing
 * in the entry says which kind it is — the importer infers a note from the name, the mime
 * type, and whether the bytes parse — so this discriminator never leaves the exporter.
 */
export type ExportFileBody =
  | { readonly kind: "object"; readonly r2Key: string }
  | { readonly kind: "note" };

export interface ExportFileRow {
  /** Internal. The archive names a file by path and never carries an id (§11). */
  id: string;
  path: string;
  mime: string;
  createdAt: number;
  updatedAt: number;
  /** Encrypted in the browser under a key this server has never held. Refused (§17). */
  encrypted: boolean;
  body: ExportFileBody;
}

export interface FilesExportSource {
  /** Live folders of this account. Read once — the list is small and kept in memory. */
  folders(): AsyncIterable<ExportFolderRow>;
  /** Live, readable files of this account. Read once, for the same reason. */
  files(): AsyncIterable<ExportFileRow>;
  /**
   * The bytes of one stored object, called once per file in each pass. R2 objects are
   * immutable in this application — an edit writes a new key — so the two passes see the
   * same bytes or the object is gone, and a vanished object stops the stream rather than
   * being quietly skipped.
   */
  openObject(r2Key: string): AsyncIterable<Uint8Array>;
  /**
   * The canonical body of a note, called once per note in each pass. Deliberately not
   * cached: a body is small but ten thousand of them are not, and the memory profile this
   * design promises (§6.3) is flat in the number of files.
   */
  noteBody(fileId: string): Promise<Buffer>;
}

/* ── brain ────────────────────────────────────────────────────────────────── */

export interface BrainExportSource {
  /**
   * Rows of one table belonging to this account, keyed by database column name, in a
   * stable order, restricted to rows that already existed when the export began.
   *
   * Called once per table in each pass. The exporter records the id and position of every
   * row it emitted and checks the second pass against that record, so an order that is
   * not in fact stable fails the download instead of writing an archive whose INDEX and
   * payload disagree.
   */
  rows(table: AccountTable): AsyncIterable<Record<string, unknown>>;
}

/* ── the plan ─────────────────────────────────────────────────────────────── */

/**
 * The result of the measuring pass: everything `writeArchive` needs up front, plus a
 * closure that produces the payload when the stream asks for it.
 *
 * `payload()` is a function and not an iterable so that nothing is read until the archive
 * is actually being written — a prepare step that only wants the numbers pays for one
 * pass, not two.
 */
export interface AccountExportPlan {
  domain: BackupDomain;
  /** Complete NDJSON, encrypted as one region by the writer. */
  index: Buffer;
  counts: AfrCounts;
  dateRange?: AfrDateRange;
  /** Plaintext payload bytes this plan expects to produce, byte for byte. */
  totalBytes: number;
  payload(): AsyncGenerator<Uint8Array, void, void>;
}
