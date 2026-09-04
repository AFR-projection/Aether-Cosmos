import type { BackupDomain } from "@backup/domain/types";
import type { RestoreMode } from "@backup/account/application/import-types";

export interface IdentityResponse {
  identity: {
    accountBackupId: string;
    adopted: Array<{ accountBackupId: string; source: string; boundAt: string }>;
  };
  overview: {
    files: {
      folders: number;
      files: number;
      bytes: number;
      encryptedFiles: number;
    };
    brain: {
      brains: number;
      /** Live memories — the rows the archive carries, Recycle Bin excluded. */
      memories: number;
      /**
       * How many of `memories` are archived rather than active.
       *
       * The card prints the total and this number together, because `/brain` shows active and
       * archived in two separate tiles: without the split, "9" here against "3" there reads as a
       * bug even when both are right.
       */
      archivedMemories: number;
    };
  };
  phraseWords: number;
  previewBytes: number;
  accountBackupIdDisplay: string;
}

/**
 * What `POST /api/backup/takeout/prepare` returns.
 *
 * `phrase` comes back on **every** takeout, and it is a different nine words each time: it is
 * derived from `BACKUP_MASTER_KEY` and this ticket's `ticketId`, so nothing is stored and nothing
 * is reused. The three fields are required rather than optional because there is no longer any
 * successful `prepare` that cannot produce them — a server without a master key fails the whole
 * request with `AFRBAK_NOT_CONFIGURED` instead of answering without a phrase.
 *
 * The page must therefore treat the dialog as part of the download, not an extra: navigate only
 * after the user has acknowledged the words, because this response is the one and only place they
 * are readable.
 */
export interface PrepareResponse {
  ticket: string;
  /** Ready to navigate to, ticket already encoded. */
  url: string;
  expiresAt: string;
  filename: string;
  accountBackupId: string;
  /** The nine words that open this archive's keyslot 1. Never logged, never stored. */
  phrase: string;
  phraseWords: number;
  phraseBits: number;
}

export type SplitReason =
  | "ok"
  | "brain-has-no-split"
  | "index-too-large"
  | "need-more-bytes"
  | "over-row-cap";

export interface InspectResponse {
  domain: BackupDomain;
  mode: RestoreMode;
  backupId: string;
  createdAt: string;
  formatVersion: number;
  keyId: string;
  via: "master" | "phrase";
  stale: boolean;
  summary: {
    accountBackupId: string;
    accountBackupIdDisplay: string;
    appVersion: string;
    counts: {
      folders?: number;
      files?: number;
      memories?: number;
      rows: number;
    };
    dateRange: { oldest: string; newest: string } | null;
    email: string | null;
    schemaVersion: number;
    sourceInstanceId: string;
    totalBytes: number;
  };
  ownership: {
    bound: boolean;
    willAdopt: boolean;
    restorable: boolean;
  };
  capacity: {
    withinRowCaps: boolean;
    rows: number;
    cap: number;
  };
  split: {
    restored: number;
    skipped: number;
    renamed: number;
    newFolders: number;
    bytes: number;
  } | null;
  splitExact: boolean;
  splitReason: SplitReason;
  splitBytesNeeded: number | null;
  previewBytesRead: number;
}

export interface RestoreResponse {
  restoreBatchId: string;
  domain: BackupDomain;
  mode: RestoreMode;
  report: {
    rows: number;
    bytes: number;
    skipped: number;
    renamed: number;
  };
  backupId: string;
  createdAt: string;
  formatVersion: number;
  keyId: string;
  via: "master" | "phrase";
  stale: boolean;
  adopted: boolean;
  accountBackupId: string;
  expected: {
    rows: number;
    bytes: number;
  };
  removed:
    | {
        folders: number;
        files: number;
      }
    | {
        tables: number;
        rows: number;
      }
    | null;
  /**
   * The derived-graph sweep a Brain restore hands to the worker — the one field here that
   * describes work which has not happened yet.
   *
   * `null` for Files, which has no graph. `queued < brains` means the queue refused the jobs
   * (Redis disabled or unreachable), so the edges behind `/brain/graph` rebuild when the worker
   * is running again rather than now. Nothing was lost either way; the archive never carried
   * `memory_derived_links`.
   */
  graph: {
    brains: number;
    queued: number;
  } | null;
}
