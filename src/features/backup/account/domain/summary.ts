import type { BackupDomain } from "@backup/domain/types";
import { GCM_TAG_BYTES } from "@backup/domain/types";
import { canonicalBytes } from "./canonical";
import { AfrTooLargeError } from "./errors";
import { fail, exactKeys, intField, knownKeys, stringField, textField } from "./fields";
import { ACCOUNT_BACKUP_ID_RE, normalizeAccountBackupId } from "./identity";
import { MAX_SUMMARY_BYTES } from "./format";

/**
 * What the archive says it is, in the first region only a key can read.
 *
 * SUMMARY is the whole preview: a client reads 32 bytes of preamble, then
 * `headerLength + 32 + summaryLength` more, and that is enough to draw the confirm
 * screen — *"1,247 files · 3.2 GB · written 2026-09-03 by afr-vps-1"* — without
 * uploading the archive and without the server holding a byte of it (§5.4, §7.1).
 * Which is why the format caps it at 64 KiB: preview cost must not scale with the
 * number of files, or a 40 GB archive would make its own preview a denial of service.
 *
 * Two things about the contents.
 *
 * `accountBackupId` lives here, inside the encryption, and not in the plaintext
 * header. It is the answer to "whose archive is this", and an identifier that says
 * whose data a file holds is metadata worth protecting: a stolen `.afrbak` should not
 * tell its holder which account to go after (§3.1).
 *
 * Every number here is a *claim*. `counts` and `totalBytes` are what the writing
 * instance believed when it started streaming, and the importer never trusts them: it
 * reserves against `totalBytes` and then aborts the moment its running counter passes
 * the reservation (§7.3). What they are actually for is the two cheap refusals that
 * must happen before the first write — #8, more rows than the importer will take, and
 * #9, not enough quota — and for the sentence on the confirm screen.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5, §11.
 */

/** Plaintext ceiling, derived so the encrypted region cannot exceed the format's cap. */
export const MAX_SUMMARY_PLAINTEXT_BYTES = MAX_SUMMARY_BYTES - GCM_TAG_BYTES;

/**
 * A label for the instance that wrote the archive, for the audit trail and the preview
 * line. Deliberately not a secret and deliberately not a gate: on the disaster path the
 * instance in question no longer exists.
 */
export const INSTANCE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export const MAX_EMAIL_CHARS = 320;
export const MAX_APP_VERSION_CHARS = 64;

/** Roughly the year 9999 — a sanity bound, the same one the header uses for `createdAt`. */
const MAX_TIMESTAMP = 253_402_300_799_000;

export interface AfrCounts {
  /** Zero in a brain archive. */
  folders: number;
  /** Zero in a brain archive. */
  files: number;
  /** Zero in a files archive. */
  memories: number;
  /**
   * Every row the importer will insert, across every table the domain covers — so for
   * brain it is more than `memories` (tags, links, agents), and for files it is
   * `files + folders`. This is the number refusal #8 is measured against.
   */
  rows: number;
}

/** The span the archive covers, by row timestamp. Absent when there are no rows. */
export interface AfrDateRange {
  /** Epoch milliseconds. */
  from: number;
  to: number;
}

export interface AfrSummary {
  /** Canonical 52 characters. The root identity of §3.1, never `users.id`. */
  accountBackupId: string;
  /** Which build wrote it, for the preview line and the audit row. */
  appVersion: string;
  counts: AfrCounts;
  dateRange?: AfrDateRange;
  /**
   * Metadata, and nothing else. It is here so a person with three archives can tell
   * which account each one came from; it is never an authorization check and never a
   * gate, because it is editable on the settings page (§3.1, §18). Optional: an
   * instance with no address on file writes no field rather than an empty string.
   */
  email?: string;
  /** The migration number the writing instance was at, for the operator's benefit. */
  schemaVersion: number;
  sourceInstanceId: string;
  /** Plaintext payload bytes the writer expected to produce. A claim, not a fact. */
  totalBytes: number;
}

const SUMMARY_REQUIRED = [
  "accountBackupId",
  "appVersion",
  "counts",
  "schemaVersion",
  "sourceInstanceId",
  "totalBytes",
] as const;

const SUMMARY_OPTIONAL = ["dateRange", "email"] as const;
const COUNTS_KEYS = ["files", "folders", "memories", "rows"] as const;
const DATE_RANGE_KEYS = ["from", "to"] as const;

export function encodeSummary(summary: AfrSummary): Buffer {
  const bytes = canonicalBytes({
    accountBackupId: normalizeAccountBackupId(summary.accountBackupId),
    appVersion: summary.appVersion,
    counts: {
      files: summary.counts.files,
      folders: summary.counts.folders,
      memories: summary.counts.memories,
      rows: summary.counts.rows,
    },
    dateRange: summary.dateRange
      ? { from: summary.dateRange.from, to: summary.dateRange.to }
      : undefined,
    email: summary.email,
    schemaVersion: summary.schemaVersion,
    sourceInstanceId: summary.sourceInstanceId,
    totalBytes: summary.totalBytes,
  });
  if (bytes.length > MAX_SUMMARY_PLAINTEXT_BYTES) {
    // Our own writer overflowing this is a bug, not a damaged file — but it is a bug
    // that would otherwise surface as an unreadable archive weeks later, so it stops
    // here, at the moment the oversized value is still in hand.
    fail(`summary is ${bytes.length} bytes, cap ${MAX_SUMMARY_PLAINTEXT_BYTES}`);
  }
  return bytes;
}

/**
 * Reached only after the SUMMARY's GCM tag verified, which means whoever wrote these
 * bytes held the DEK. That is what licenses a specific `detail` here (§12): the archive
 * is either ours or opened with the account's own phrase, so "damaged" is the honest
 * description and there is no oracle to feed.
 */
export function decodeSummary(bytes: Buffer): AfrSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("summary is not JSON");
  }

  const record = knownKeys(parsed, SUMMARY_REQUIRED, SUMMARY_OPTIONAL, "summary");
  const counts = exactCounts(record.counts);
  const summary: AfrSummary = {
    accountBackupId: normalizeAccountBackupId(
      stringField(record, "accountBackupId", "summary", ACCOUNT_BACKUP_ID_RE)
    ),
    appVersion: textField(record, "appVersion", "summary", MAX_APP_VERSION_CHARS),
    counts,
    dateRange: "dateRange" in record ? exactDateRange(record.dateRange) : undefined,
    email: "email" in record ? textField(record, "email", "summary", MAX_EMAIL_CHARS) : undefined,
    schemaVersion: intField(record, "schemaVersion", "summary", 0, 100_000),
    sourceInstanceId: stringField(record, "sourceInstanceId", "summary", INSTANCE_ID_RE),
    totalBytes: intField(record, "totalBytes", "summary", 0, Number.MAX_SAFE_INTEGER),
  };

  // A total smaller than its own parts is the one arithmetic lie worth catching here:
  // it is free to check, and it means the two numbers the caps and the quota are read
  // from were not produced by the same walk over the same rows.
  const parts = counts.files + counts.folders + counts.memories;
  if (counts.rows < parts) {
    fail(`summary.counts.rows ${counts.rows} is below its own parts ${parts}`);
  }
  return summary;
}

function exactCounts(value: unknown): AfrCounts {
  const record = exactKeys(value, COUNTS_KEYS, "summary.counts");
  const where = "summary.counts";
  return {
    files: intField(record, "files", where, 0, Number.MAX_SAFE_INTEGER),
    folders: intField(record, "folders", where, 0, Number.MAX_SAFE_INTEGER),
    memories: intField(record, "memories", where, 0, Number.MAX_SAFE_INTEGER),
    rows: intField(record, "rows", where, 0, Number.MAX_SAFE_INTEGER),
  };
}

function exactDateRange(value: unknown): AfrDateRange {
  const record = exactKeys(value, DATE_RANGE_KEYS, "summary.dateRange");
  const from = intField(record, "from", "summary.dateRange", 1, MAX_TIMESTAMP);
  const to = intField(record, "to", "summary.dateRange", 1, MAX_TIMESTAMP);
  if (from > to) {
    fail(`summary.dateRange runs backwards, ${from} to ${to}`);
  }
  return { from, to };
}

/* ── row caps ─────────────────────────────────────────────────────────────── */

/**
 * Refusal #8, and why it is checked against a *claim*.
 *
 * The importer counts as it goes and aborts on its own if the payload disagrees with
 * the summary, so these caps are not the thing that keeps the account safe — they are
 * what keeps a 5-million-row archive from being started at all. Free to check, before
 * the first write, from 80 KiB of preview: that is the whole argument for them.
 *
 * The numbers come from §11 and are per domain because the rows are not comparable:
 * 500,000 brain rows are small inserts in one transaction, while 200,000 file rows each
 * carry an R2 object.
 */
export const AFR_FILE_ROW_CAP = 200_000;
export const AFR_FOLDER_ROW_CAP = 50_000;
export const AFR_BRAIN_ROW_CAP = 500_000;

export function rowCap(domain: BackupDomain): number {
  return domain === "brain" ? AFR_BRAIN_ROW_CAP : AFR_FILE_ROW_CAP + AFR_FOLDER_ROW_CAP;
}

/**
 * Throws {@link AfrTooLargeError} — which carries the two numbers, so the audit row can
 * record what was asked for and what the limit was.
 */
export function assertWithinRowCaps(domain: BackupDomain, counts: AfrCounts): void {
  if (domain === "files") {
    if (counts.files > AFR_FILE_ROW_CAP) {
      throw new AfrTooLargeError(counts.files, AFR_FILE_ROW_CAP);
    }
    if (counts.folders > AFR_FOLDER_ROW_CAP) {
      throw new AfrTooLargeError(counts.folders, AFR_FOLDER_ROW_CAP);
    }
  }
  const cap = rowCap(domain);
  if (counts.rows > cap) {
    throw new AfrTooLargeError(counts.rows, cap);
  }
}

