import { BackupError } from "@backup/domain/errors";

/**
 * Refusals, in the shape the caller is allowed to see them.
 *
 * Two rules from the spec are enforced by the *types* here rather than by everyone
 * remembering them:
 *
 *   1. Every cryptographic and integrity failure — a bad `HDR_HMAC`, an unknown
 *      `keyId`, two dead keyslots, an identity mismatch, a GCM tag that did not
 *      verify, a truncated file — is one class with one code and one message. If
 *      those cases could be told apart from the outside, an attacker holding a
 *      stolen `.afrbak` would have an oracle for guessing recovery phrases.
 *   2. The technical detail still exists, but it lives in `detail`/`reason`, which
 *      only the audit trail reads. `handleApiError` serializes `message` and `code`
 *      and nothing else, so a `detail` cannot leak by being forgotten.
 *
 * Non-cryptographic refusals stay specific on purpose: "this is a Files backup, not
 * a Brain backup" gives away nothing and saves the user a support ticket.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §9, §12.
 */

/** The refusal numbers of §9, as recorded in the audit trail. */
export type RefusalReason = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * The one sentence every crypto failure gets. English here, like the rest of the
 * codebase's API messages; the user-facing page translates by `code` and keeps this
 * only as a fallback.
 */
export const GENERIC_UNREADABLE_MESSAGE =
  "This backup cannot be opened. The recovery phrase is wrong, or the file is damaged.";

export abstract class AccountBackupError extends BackupError {
  /** Which of the nine refusals this was. Audit only. */
  readonly reason: RefusalReason;
  /** Why, in words no response ever carries. Audit and internal logs only. */
  readonly detail: string;

  protected constructor(
    message: string,
    status: number,
    code: string,
    reason: RefusalReason,
    detail: string
  ) {
    super(message, status, code);
    this.name = "AccountBackupError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** #1 — the bytes are not an AFR archive at all. */
export class NotAnAfrBackupError extends AccountBackupError {
  constructor(detail: string) {
    super("This file is not an AFR backup.", 422, "AFRBAK_NOT_AFR", 1, detail);
  }
}

/** #2 — written by a newer build. Specific, because upgrading is the fix. */
export class AfrVersionTooNewError extends AccountBackupError {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      "This backup was written by a newer version of the app.",
      422,
      "AFRBAK_VERSION_TOO_NEW",
      2,
      `formatVersion ${found} > supported ${supported}`
    );
    this.found = found;
    this.supported = supported;
  }
}

/**
 * #3, #4, #6, and every post-validation crypto failure. One class, one message.
 *
 * `reason` still separates them for the audit trail, so an operator reading
 * `activity_logs` can tell an unknown `keyId` from a wrong phrase even though the
 * response cannot.
 */
export class AfrUnreadableError extends AccountBackupError {
  constructor(reason: 3 | 4 | 6, detail: string) {
    super(GENERIC_UNREADABLE_MESSAGE, 422, "AFRBAK_UNREADABLE", reason, detail);
  }
}

/** #5 — the right archive, the wrong card. */
export class AfrDomainMismatchError extends AccountBackupError {
  readonly found: "files" | "brain";
  readonly expected: "files" | "brain";

  constructor(found: "files" | "brain", expected: "files" | "brain") {
    super(
      `This is a ${found} backup, not a ${expected} backup.`,
      422,
      "AFRBAK_DOMAIN_MISMATCH",
      5,
      `header domain ${found} != requested ${expected}`
    );
    this.found = found;
    this.expected = expected;
  }
}

/**
 * #7 — lengths that contradict each other or exceed their caps.
 *
 * Read from the plaintext preamble before any key is touched, so a specific message
 * leaks nothing: the file's own header already says what it claims.
 */
export class AfrCorruptError extends AccountBackupError {
  constructor(detail: string) {
    super("This backup file is damaged.", 422, "AFRBAK_CORRUPT", 7, detail);
  }
}

/** #8 — more rows than the importer will take, refused before the first insert. */
export class AfrTooLargeError extends AccountBackupError {
  readonly rows: number;
  readonly cap: number;

  constructor(rows: number, cap: number) {
    super(
      "This backup is too large to process.",
      422,
      "AFRBAK_TOO_LARGE",
      8,
      `claims ${rows} rows, cap ${cap}`
    );
    this.rows = rows;
    this.cap = cap;
  }
}

/** #9 — the only refusal about the destination rather than the file. */
export class AfrQuotaError extends AccountBackupError {
  readonly needBytes: number;
  readonly availableBytes: number;

  constructor(needBytes: number, availableBytes: number) {
    super(
      "Not enough storage space to restore this backup.",
      409,
      "AFRBAK_QUOTA",
      9,
      `needs ${needBytes} bytes, ${availableBytes} available`
    );
    this.needBytes = needBytes;
    this.availableBytes = availableBytes;
  }
}

/* ── failures that are not one of the nine ────────────────────────────────── */

/**
 * `BACKUP_MASTER_KEY` is absent or unusable, so the feature is off.
 *
 * 503 rather than 500: nothing is broken, the server was simply never configured
 * for this. The message says which env var to set and never says anything about the
 * value it expected to find there.
 */
export class AccountBackupNotConfiguredError extends BackupError {
  readonly detail: string;

  constructor(detail = "BACKUP_MASTER_KEY is not set") {
    super(
      "Per-account backup is not configured on this server.",
      503,
      "AFRBAK_NOT_CONFIGURED"
    );
    this.name = "AccountBackupNotConfiguredError";
    this.detail = detail;
  }
}

/**
 * The account's sealed recovery wrapping key cannot be opened by any key in the
 * ring, so keyslot 1 cannot be filled and no new archive may be written.
 *
 * Distinct from {@link AccountBackupNotConfiguredError} because the operator's next
 * action is different: the server is configured, this one account's stored key is
 * stale — almost always `BACKUP_MASTER_KEY` was replaced without keeping the old
 * value in `BACKUP_MASTER_KEY_PREVIOUS`. Archives already downloaded are unaffected;
 * their keyslot 1 was sealed by the phrase, which lives in the user's head.
 *
 * Refusing to export is deliberate. Writing an archive with a keyslot 1 nobody can
 * open would produce a file that looks like a backup and is one master-key rotation
 * away from being landfill — exactly the failure this whole design exists to prevent.
 */
export class AccountRecoveryKeyUnreadableError extends BackupError {
  readonly detail: string;

  constructor(detail: string) {
    super(
      "Your recovery phrase needs to be set up again before a new backup can be " +
        "made. Backups you already downloaded are unaffected.",
      409,
      "AFRBAK_RECOVERY_KEY_UNREADABLE"
    );
    this.name = "AccountRecoveryKeyUnreadableError";
    this.detail = detail;
  }
}

/** A download ticket that is expired, malformed, or minted for someone else. */

export class AccountBackupTicketError extends BackupError {
  readonly detail: string;

  constructor(detail: string) {
    super("This download link is no longer valid.", 403, "AFRBAK_TICKET");
    this.name = "AccountBackupTicketError";
    this.detail = detail;
  }
}

/**
 * The account holds files that were encrypted in the browser, and this server has never
 * held the keys to them.
 *
 * Refusing is the only honest option. The bytes in R2 are ciphertext under a key derived
 * from a passphrase the user typed into a page; `encryptionMeta` records the salt and IV
 * and nothing else. An archive carrying those bytes would carry a file nobody can ever
 * open again — the passphrase is not in the archive, and this format has no field to put
 * it in — while the SUMMARY counted it as backed up. That is worse than no backup, so the
 * export stops before the first byte and says which files are in the way.
 *
 * The existing folder download refuses the same case for the same reason
 * (`app/api/folders/[id]/download/route.ts`). Covering these accounts needs an `enc`
 * field on the `file` INDEX entry and a `formatVersion` bump, which is a format change
 * and therefore not something this version does quietly.
 */
export class AccountBackupEncryptedFilesError extends BackupError {
  readonly count: number;

  constructor(count: number) {
    super(
      `This account has ${count} client-side encrypted file${count === 1 ? "" : "s"}, ` +
        `which cannot be included in a backup. Decrypt or remove them first.`,
      409,
      "AFRBAK_ENCRYPTED_FILES"
    );
    this.name = "AccountBackupEncryptedFilesError";
    this.count = count;
  }
}

/**
 * The archive's own table of contents would not fit inside the format.
 *
 * The row caps of §9 bound how many entries an archive may hold; this bounds how many
 * *bytes* those entries take, which is a different number because a path may be 4 KiB
 * long. It is checked on the way out, before a single byte is streamed, because the
 * alternative is a download that runs for an hour and then dies — and because the
 * writer's own guard on the same limit is a programming error, not a message a user
 * should ever be shown.
 */
export class AccountBackupTooBigError extends BackupError {
  readonly detail: string;

  constructor(detail: string) {
    super(
      "This account is too large to back up in a single archive.",
      413,
      "AFRBAK_ACCOUNT_TOO_BIG"
    );
    this.name = "AccountBackupTooBigError";
    this.detail = detail;
  }
}

/**
 * A folder or file name this format has no way to spell.
 *
 * The archive's path validator is stricter than the upload path on purpose (§11): it
 * refuses a name with surrounding whitespace, a control character, or a direction
 * override, because two spellings of one path would let a restore build two rows where
 * the account has one. A row predating those checks can still hold such a name, and the
 * only two options are to write a path the importer will refuse — an archive that looks
 * like a backup and is not one — or to stop here and say which name is in the way.
 *
 * The name is passed through `safeLabel`, so nothing unprintable reaches the response.
 */
export class AccountBackupBadNameError extends BackupError {
  readonly detail: string;

  constructor(label: string, detail: string) {
    super(
      `The name ${label} cannot be written to a backup. Rename it and try again.`,
      409,
      "AFRBAK_BAD_NAME"
    );
    this.name = "AccountBackupBadNameError";
    this.detail = detail;
  }
}

/**
 * The account changed while the archive was being written.
 *
 * The archive's table of contents is fixed before the first payload byte goes out — the
 * format puts INDEX ahead of CHUNKS — so the export reads the account twice: once to say
 * what it holds, once to send it. Almost nothing can differ between those two reads.
 * R2 objects are immutable, a memory that is merely edited changes no INDEX field, and
 * rows created after the export began are excluded from both passes by timestamp. What
 * remains is a row deleted mid-stream, or a note whose body was rewritten mid-stream.
 *
 * Both produce an archive whose INDEX describes bytes it does not carry, which is exactly
 * the kind of file that looks restorable until the day it is needed. So the stream dies
 * instead, and the honest fix is the trivial one: run it again.
 */
export class AccountBackupChangedError extends BackupError {
  readonly detail: string;

  constructor(detail: string) {
    super(
      "Your data changed while the backup was being written. Please try again.",
      409,
      "AFRBAK_CHANGED"
    );
    this.name = "AccountBackupChangedError";
    this.detail = detail;
  }
}

/**
 * A live row points at bytes the bucket does not have.
 *
 * Distinct from {@link AccountBackupChangedError}, whose advice is "try again": an object
 * that is already gone when the *measuring* pass looks for it will still be gone on the
 * next attempt, so telling the user to retry would send them round a loop forever. The
 * account is inconsistent — a row survived its object — and the only person who can fix
 * that is the one who can see which file it is.
 *
 * Refused rather than skipped for the reason every other omission is refused: an archive
 * whose SUMMARY counts a file it does not carry is a backup that lies. A vanished object
 * discovered by the *streaming* pass is a different event — it was readable minutes ago —
 * and stays {@link AccountBackupChangedError}.
 *
 * Only a 404 from storage lands here. A timeout or a 5xx propagates untouched, because
 * "the bucket is having a bad day" must not be reported to a user as "your file is gone".
 */
export class AccountBackupFileUnreadableError extends BackupError {
  readonly detail: string;

  constructor(label: string | null, detail: string) {
    super(
      label === null
        ? "A file in this account cannot be read from storage, so the backup was stopped."
        : `The file ${label} cannot be read from storage, so it cannot be backed up. ` +
          `Remove it or upload it again.`,
      409,
      "AFRBAK_FILE_UNREADABLE"
    );
    this.name = "AccountBackupFileUnreadableError";
    this.detail = detail;
  }
}

/** One restore at a time per account — the second would race the first's quota. */
export class AccountBackupBusyError extends BackupError {
  constructor() {
    super(
      "A restore is already running for this account. Wait for it to finish.",
      409,
      "AFRBAK_BUSY"
    );
    this.name = "AccountBackupBusyError";
  }
}

/**
 * The upload ended before the archive did.
 *
 * §12 folds a truncated *file* in with a wrong phrase, and for a file that is right: an attacker
 * cutting bytes off a stolen `.afrbak` must not learn anything from the difference. A truncated
 * *upload* is not a fact about the archive at all. The body stopped short of the `Content-Length`
 * the browser itself set, so the caller already knows both numbers and there is nothing left to
 * leak — while being told "the recovery phrase is wrong" sends someone hunting for a phrase that
 * was correct all along.
 *
 * Both counts travel in the response because they are the two numbers that make the sentence
 * actionable, and neither describes the archive's contents.
 *
 * How it happened once: `proxy.ts` matched the restore route, so Next cloned the request body
 * with the 10 MB cap of `experimental.proxyClientMaxBodySize` and quietly closed the copy the
 * route was reading (`tests/proxy-restore-body.test.ts`). What is left after that fix is the
 * ordinary reason — a connection that dropped part-way through a long upload.
 */
export class AccountBackupUploadTruncatedError extends BackupError {
  readonly receivedBytes: number;
  readonly expectedBytes: number;

  constructor(receivedBytes: number, expectedBytes: number) {
    super(
      "The upload stopped before the whole backup arrived, so there was nothing complete to " +
        "restore. Nothing was changed — please try again.",
      400,
      "AFRBAK_UPLOAD_TRUNCATED"
    );
    this.name = "AccountBackupUploadTruncatedError";
    this.receivedBytes = receivedBytes;
    this.expectedBytes = expectedBytes;
  }
}
