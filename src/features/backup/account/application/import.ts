/**
 * One restore, in the five stages §7.3 fixes: validate → reserve → import/stage → verify →
 * commit. Never delete → import.
 *
 * Two invariants are the reason this file exists, and both are structural here rather than
 * remembered:
 *
 *   - **Nothing is committed before `finish()` resolves.** Chunk plaintext reaches an importer
 *     before the digest covering it has been checked, so a truncated upload — or a chunk region
 *     lifted from an older archive of the same account — is caught by the trailer and nowhere
 *     earlier. `RestoreSession.run` commits exactly when its body returns, and the body's last
 *     act is `finish()`. There is no ordering left for a caller to get wrong.
 *   - **Scope comes from the authenticated caller.** `caller.userId` is the only owner any row
 *     gets. What the archive says about who it belongs to is a preview line (§3.1) and an
 *     anti-misrouting check (#6); it is never authority.
 *
 * What this file deliberately does not do: open a transaction, touch R2, write an audit row, or
 * bind an adopted identity. Those live behind the three ports below, which is what makes the
 * whole order of operations testable with no database and no bucket.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3–§7.5, §8.
 */

import { openArchive, type AfrOpenInput } from "@backup/account/domain/archive";
import {
  AccountBackupError,
  AfrCorruptError,
  AfrUnreadableError,
} from "@backup/account/domain/errors";
import type { AfrHeader, AfrPreamble, AfrTrailer } from "@backup/account/domain/format";
import { isBoundIdentity, shortAccountBackupId } from "@backup/account/domain/identity";
import type { AfrKeyRing } from "@backup/account/domain/keys";
import { assertWithinRowCaps, type AfrSummary } from "@backup/account/domain/summary";
import { BackupError } from "@backup/domain/errors";
import type { BackupDomain } from "@backup/domain/types";
import { importBrain } from "@backup/account/application/import-brain";
import { importFiles } from "@backup/account/application/import-files";
import {
  declaredBudget,
  type AfrReadable,
  type BrainImportSink,
  type FilesImportSink,
  type ImportReport,
  type RestoreMode,
} from "@backup/account/application/import-types";

/** How much of a failure is worth keeping in `restore_batches.error`. */
const MAX_REASON_CHARS = 200;

/* ── ports ────────────────────────────────────────────────────────────────── */

/**
 * The authenticated caller, and the archive identities this account has already proved it owns.
 *
 * `boundIds` is this user's whole of `account_backup_identities`: one `generated` row, plus
 * however many `adopted` ones (§3.2). A miss does not end the restore — it means keyslot 1 must
 * have opened the archive, which is refusal #6's exact condition and the disaster path's exact
 * shape.
 */
export interface RestoreCaller {
  /** From `requireAuth()`. Never from a request body (§10). */
  userId: string;
  boundIds: readonly { accountBackupId: string }[];
}

/** What stage 2 writes into `restore_batches`, before a single row is imported. */
export interface RestoreReservationInput {
  userId: string;
  domain: BackupDomain;
  mode: RestoreMode;
  /** The archive's own uuid, read from the header the `HDR_HMAC` authenticated. */
  backupId: string;
  formatVersion: number;
  /** Which master-key generation opened it — on the phrase path, one this server may not hold. */
  keyId: string;
  /** The SUMMARY's claims: what the quota check runs against, and what stage 4 is audited by. */
  expectedRows: number;
  expectedBytes: number;
}

/**
 * Stage 2, and the bookkeeping half of stage 5.
 *
 * `reserve` is a transaction of its own and **must commit before it returns** (§7.3). Two
 * reasons, both binding: a reservation is only authoritative against a concurrent restore if
 * another session can see it, and `restore_reservations.restore_batch_id` points at a
 * `restore_batches` row that a rolled-back import transaction would drag down with it.
 *
 * It is also where the two refusals that need a row lock live — #9, the quota check, and
 * `AccountBackupBusyError` for an account that already has a batch in `staging`.
 */
export interface RestoreLedger {
  /** Returns the new `restore_batches.id`. Throws `AfrQuotaError` (#9) or `AccountBackupBusyError`. */
  reserve(input: RestoreReservationInput): Promise<string>;
  /** Committed: record what landed, drop the reservation, recompute `used_bytes`. */
  settle(restoreBatchId: string, written: { rows: number; bytes: number }): Promise<void>;
  /**
   * This batch will never commit. Releases the reservation so the user can retry at once, and
   * marks the row `aborted` with a reason short enough for a column and safe enough for a log.
   *
   * The sweeper (§7.6) stays the backstop rather than the mechanism: a process killed mid-restore
   * never reaches this call, and for Files there are staged rows and R2 objects that only the
   * sweeper can remove.
   */
  abandon(restoreBatchId: string, reason: string): Promise<void>;
}

/**
 * One domain's write side for the length of one restore — and the place the commit rule is
 * enforced instead of documented.
 *
 * `run` hands its body a sink and commits **exactly when the body returns**; a throw rolls back.
 * So "nothing is committed before `finish()` resolves" is not a rule anyone has to keep:
 * `finish()` is the last thing the body awaits, and returning is the only way to commit.
 *
 * The two domains implement it differently, and the difference is §7.3's rather than this port's.
 * *Brain* opens a transaction, inserts into it, and commits — uncommitted rows are invisible by
 * MVCC, so there is no staging column and a failure leaves no data row behind. *Files* cannot do
 * that, because a `PutObject` does not roll back: it writes rows with `deleted_at = NOW()` and
 * `restore_batch_id`, which every existing read path already filters out, and commits by clearing
 * both in one transaction (plus, for `replace`, soft-deleting the old rows first).
 */
export interface RestoreSession<Sink> {
  run<T>(restoreBatchId: string, body: (sink: Sink) => Promise<T>): Promise<T>;
}

/**
 * As much of `AfrArchiveReader` as the five stages touch.
 *
 * Structural for the same reason `AfrReadable` is: the format tests drive the real reader over
 * real bytes, while the tests about *ordering* — that nothing commits before the trailer
 * verifies, that a stage-3 refusal still abandons the batch — drive a fake with no keys in it.
 */
export interface RestoreReadable extends AfrReadable {
  readonly preamble: AfrPreamble;
  readonly header: AfrHeader;
  readonly via: "master" | "phrase";
  readonly keyId: string;
  readonly stale: boolean;
  finish(): Promise<AfrTrailer>;
}

/**
 * Which domain is being restored, with the session that can write it.
 *
 * A union rather than two loose fields so the pairing cannot be got wrong: there is no way to
 * spell "a brain archive, restored through the files sink".
 */
export type RestoreTarget =
  | {
      domain: "files";
      session: RestoreSession<FilesImportSink>;
      /** This instance's upload policy — see `FilesImportInput.mimeAllowed`. */
      mimeAllowed?: (mime: string, name: string) => boolean;
    }
  | { domain: "brain"; session: RestoreSession<BrainImportSink> };

export interface RestoreInput {
  /** The upload, in whatever pieces the network chose. Never held whole. */
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  ring: AfrKeyRing;
  mode: RestoreMode;
  caller: RestoreCaller;
  ledger: RestoreLedger;
  target: RestoreTarget;
  /** Only when the person typed one — the whole of the disaster path (§7.1). */
  phrase?: string;
  /** Import time, for clamping provenance timestamps. Injected so tests are not clocks. */
  now?: number;
  /** Only so a test can drive the five stages over a fake reader. */
  open?: (input: AfrOpenInput) => Promise<RestoreReadable>;
}

/** What the audit row, the response and the identity binding all read off one restore. */
export interface RestoreOutcome {
  restoreBatchId: string;
  report: ImportReport;
  summary: AfrSummary;
  backupId: string;
  createdAt: number;
  formatVersion: number;
  keyId: string;
  via: "master" | "phrase";
  /** Opened by a retired master key: correct, and the account is due for rewrapping. */
  stale: boolean;
  /**
   * The phrase opened an archive whose id this account had not bound yet (§3.2).
   *
   * The caller writes the `adopted` row and the `backup_restore_adopted` audit line. Doing it
   * here would put a database write inside the module that decides refusals, and it is also the
   * wrong moment: the binding is worth keeping only if the restore it enabled succeeded.
   */
  adopted: boolean;
}

/* ── the five stages ──────────────────────────────────────────────────────── */

export async function restoreAccountArchive(input: RestoreInput): Promise<RestoreOutcome> {
  const { caller, ledger, target, mode } = input;

  // ── stage 1: validate ─────────────────────────────────────────────────────
  // Refusals #1–#5 and #7 are `openArchive`'s, decided from the preamble, the header MAC and the
  // SUMMARY's own GCM tag — about 80 KiB read, and not one byte of payload (§7.1).
  const open = input.open ?? openArchive;
  const reader = await open({
    source: input.source,
    ring: input.ring,
    expectedDomain: target.domain,
    phrase: input.phrase,
  });
  const summary = reader.summary;

  // Refusal #6, and §3.2's one legitimate way past it. Before the reservation, because a
  // refusal that leaves a `restore_batches` row behind is a refusal that needs sweeping.
  const adopted = assertOwnership(summary, reader.via, caller);

  // #8. Both importers check it again — they hold the INDEX in memory and this is the only
  // thing that bounds it — but the spec's claim is that it is refused before the first write,
  // and stage 2 writes.
  assertWithinRowCaps(target.domain, summary.counts);

  // ── stage 2: reserve ──────────────────────────────────────────────────────
  // Committed by the time it returns (§7.3). #9's quota check and `AccountBackupBusyError`
  // both need a row lock another session can see, and `restore_reservations` cannot point at
  // a parent row that a later rollback would take down with it.
  const restoreBatchId = await ledger.reserve({
    userId: caller.userId,
    domain: target.domain,
    mode,
    backupId: reader.header.backupId,
    formatVersion: reader.preamble.formatVersion,
    keyId: reader.keyId,
    expectedRows: summary.counts.rows,
    expectedBytes: summary.totalBytes,
  });

  // ── stages 3–5: import/stage, verify, commit ──────────────────────────────
  let report: ImportReport;
  try {
    report = await runStaged(input, reader, restoreBatchId);
  } catch (error) {
    // Nothing this batch wrote can be seen: brain went down with its transaction, and files
    // are staged rows every existing read path already filters out.
    await release(ledger, restoreBatchId, error);
    throw error;
  }

  await ledger.settle(restoreBatchId, { rows: report.rows, bytes: report.bytes });

  return {
    restoreBatchId,
    report,
    summary,
    backupId: reader.header.backupId,
    createdAt: reader.header.createdAt,
    formatVersion: reader.preamble.formatVersion,
    keyId: reader.keyId,
    via: reader.via,
    stale: reader.stale,
    adopted,
  };
}

/**
 * Stages 3, 4 and 5, as one expression — because the commit *is* the body returning.
 *
 * `verify` is the last thing the body awaits, so the trailer is checked while the session is
 * still open: a failure there throws out of the body, which rolls the brain transaction back
 * and leaves the staged files rows for a stage 5 that never runs. The invariant is not a rule
 * a caller could forget here; there is no order left to get wrong.
 */
async function runStaged(
  input: RestoreInput,
  reader: RestoreReadable,
  restoreBatchId: string
): Promise<ImportReport> {
  const { target, mode } = input;
  const budget = declaredBudget(reader.summary.totalBytes);

  const verify = async (report: ImportReport): Promise<ImportReport> => {
    // ── stage 4: verify ─────────────────────────────────────────────────────
    // `TRL_HMAC`, then `chunkCount`, `totalPlaintextBytes` and `payloadSha256`: the first
    // moment the plaintext already handed to the sink is known to be the plaintext the
    // exporter wrote, rather than a truncation or a region lifted from an older archive.
    const trailer = await reader.finish();
    if (trailer.totalPlaintextBytes !== reader.summary.totalBytes) {
      // The one seam nothing else covers. The SUMMARY is what the user was shown and what
      // stage 2 reserved quota against; the trailer is what arrived. Each importer compares
      // itself against the INDEX, and the budget only refuses over-delivery — so a payload
      // of correctly shaped but shorter rows passes both, and is caught here or nowhere.
      throw new AfrCorruptError(
        `payload carried ${trailer.totalPlaintextBytes} bytes, the summary declared ` +
          `${reader.summary.totalBytes}`
      );
    }
    return report;
  };

  if (target.domain === "files") {
    return target.session.run(restoreBatchId, async (sink) =>
      verify(await importFiles({ reader, sink, mode, budget, mimeAllowed: target.mimeAllowed }))
    );
  }
  return target.session.run(restoreBatchId, async (sink) =>
    verify(
      await importBrain({
        reader,
        sink,
        mode,
        budget,
        ownerUserId: input.caller.userId,
        now: input.now,
      })
    )
  );
}

/* ── ownership, and giving up ─────────────────────────────────────────────── */

/**
 * Refusal #6, and the single legitimate way past it.
 *
 * This is not authorization — `caller.userId` settled that, and it is the only owner any row
 * gets. It is anti-misrouting: this instance's own key opens *every* archive it wrote, so
 * without the check user A's backup would restore into user B's account for no better reason
 * than both accounts living on the same server (§10).
 *
 * A miss is refused unless the phrase opened it, and that exception is the whole disaster
 * path. After a rebuild the account's `generated` identity is a fresh id no old archive
 * mentions, so the miss is *expected*; the phrase is the proof of ownership the missing row
 * can no longer give, and the id is adopted (§3.2) — by the caller, once the restore it
 * enabled has actually succeeded.
 */
function assertOwnership(
  summary: AfrSummary,
  via: "master" | "phrase",
  caller: RestoreCaller
): boolean {
  if (isBoundIdentity(summary.accountBackupId, caller.boundIds)) return false;
  if (via !== "phrase") {
    throw new AfrUnreadableError(
      6,
      `accountBackupId ${shortAccountBackupId(summary.accountBackupId)} is not bound to this account`
    );
  }
  return true;
}

/**
 * The other outcome: this batch will never commit.
 *
 * The failure that got us here is the one the caller must see, so a second failure while
 * releasing the reservation is swallowed rather than allowed to replace it. Whatever this call
 * could not finish is the sweeper's (§7.6).
 */
async function release(
  ledger: RestoreLedger,
  restoreBatchId: string,
  error: unknown
): Promise<void> {
  try {
    await ledger.abandon(restoreBatchId, describeFailure(error));
  } catch {
    // Deliberately ignored — see above.
  }
}
/**
 * A failure, as `restore_batches.error` is allowed to keep it: short, and safe to read.
 *
 * A refusal's `detail` is ours, written to be said out loud — that is what §12 makes it for —
 * so it travels, with the refusal number in front of it. Anything else is reduced to a class
 * name and, where there is one, a driver code: a Postgres `message` quotes the row that
 * violated the constraint, which is the user's own content, and this column is read by
 * whoever looks at the batch afterwards.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof AccountBackupError) {
    return clip(`refusal ${error.reason}: ${error.detail}`);
  }
  if (error instanceof BackupError) {
    return clip(`${error.name} (${error.code})`);
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const name = error instanceof Error ? error.name : typeof error;
  return clip(typeof code === "string" && code.length > 0 ? `${name} (${code})` : name);
}

function clip(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}
