/**
 * One `.afrbak`, assembled: a plan on one side, key material on the other, bytes out.
 *
 * Everything above this line is domain logic that reads an account; everything below it is
 * the format. This module is the seam, and it is deliberately thin — it owns exactly four
 * decisions, each of which would be a security bug if a route made it instead:
 *
 *   1. **The DEK is minted here**, per archive, and never leaves. `newDek()` is called at
 *      the moment the stream starts; no caller supplies one in production, and no field of
 *      the result carries it.
 *   2. **The SUMMARY is built from the plan**, not from anything a caller passes. A caller
 *      that could pass its own counts could write an archive claiming 12 rows and carrying
 *      500,000 — which the importer would then trust for its quota reservation.
 *   3. **`accountBackupId` comes from the account's identity row**, never from a request.
 *      §3.1: the id is the archive's root identity, so accepting one from the client would
 *      let a caller write an archive that a *different* account will happily adopt.
 *   4. **Both keyslots are filled by `writeArchive`** from one AAD context, which is why
 *      the recovery wrapping key is passed down rather than used here.
 *
 * The row caps are not re-checked. `planFilesExport` refuses past `AFR_FOLDER_ROW_CAP` and
 * `AFR_FILE_ROW_CAP`, whose sum is exactly `rowCap("files")`, and `planBrainExport` refuses
 * past `AFR_BRAIN_ROW_CAP` — so an archive this module can reach is already inside the
 * caps `assertWithinRowCaps` enforces on the way back in.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5, §6.2.
 */

import { writeArchive, type AfrWriteReport } from "@backup/account/domain/archive";
import { normalizeAccountBackupId } from "@backup/account/domain/identity";
import { newDek, type AfrMasterKey } from "@backup/account/domain/keys";
import { INSTANCE_ID_RE, type AfrSummary } from "@backup/account/domain/summary";
import { compactTimestamp } from "@backup/domain/naming";
import type { BackupDomain } from "@backup/domain/types";
import { SCHEMA_VERSION } from "@backup/domain/version";
import type { AccountExportPlan } from "@backup/account/application/export-types";
import { APP_VERSION } from "@/shared/lib/app-version";
import { appPublicUrl } from "@/shared/lib/env/runtime";

/** The extension, in one place, because the route and the importer both spell it. */
export const AFRBAK_EXTENSION = ".afrbak";

/** What every `.afrbak` says about the account that owns it. */
export interface AccountArchiveIdentity {
  /** Canonical 52 characters, from `account_backup_identities`. Never from a request. */
  accountBackupId: string;
  /**
   * Metadata only (§3.1). Present so a person holding three archives can tell them
   * apart; never compared, never a gate, and omitted rather than blanked when absent.
   */
  email?: string;
}

/**
 * The three secrets an archive is sealed with.
 *
 * `recoveryWrappingKey` is Argon2id over *this archive's* nine words, which the route derived a
 * moment earlier from `BACKUP_MASTER_KEY` and the download's `ticketId` (§4.3) — never the phrase
 * itself, which is a string this layer has no use for. `phraseSalt` is the matching per-archive
 * salt and travels in the header, so the words the user wrote down open this file and only this
 * file. Nothing here is read from or written to the database.
 */
export interface AccountArchiveKeys {
  masterKey: AfrMasterKey;
  recoveryWrappingKey: Buffer;
  phraseSalt: Buffer;
}

export interface AccountArchiveInput {
  plan: AccountExportPlan;
  identity: AccountArchiveIdentity;
  keys: AccountArchiveKeys;
  /** This archive's own uuid. Generated when absent; supplied so an audit row can match. */
  backupId?: string;
  /** Epoch milliseconds, supplied for the same reason. */
  createdAt?: number;
  /** Overridable only so a test can pin an archive byte for byte. */
  dek?: Buffer;
  chunkSize?: number;
}

export interface AccountArchive {
  backupId: string;
  createdAt: number;
  domain: BackupDomain;
  /** Exactly what the header and the encrypted SUMMARY were built from. */
  summary: AfrSummary;
  /** For `Content-Disposition`. */
  filename: string;
  /**
   * The archive, in order. Driving it is what reads the account a second time, so calling
   * this twice would produce two archives — correct, but paid for twice.
   */
  bytes(): AsyncGenerator<Buffer, AfrWriteReport, void>;
}

/**
 * A label for the instance, derived rather than configured.
 *
 * `sourceInstanceId` is audit metadata and never a gate — on the disaster path the
 * instance it names no longer exists — so the public hostname is exactly the right amount
 * of information: enough to tell two deployments apart in a preview line, and nothing that
 * is not already in the URL bar.
 */
export function sourceInstanceId(): string {
  let host = "";
  try {
    host = new URL(appPublicUrl()).hostname;
  } catch {
    host = "";
  }
  const label = host.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
  return INSTANCE_ID_RE.test(label) ? label : "localhost";
}

/**
 * `afr-files-20260903.afrbak` (§10).
 *
 * Two exports on one day collide in a Downloads folder and the browser appends ` (1)`,
 * which is the spec's stated shape and is left alone: the date is what someone scanning
 * the folder in six months actually reads, and the archive's own header carries the
 * millisecond for anyone who needs it.
 */
export function accountArchiveFilename(domain: BackupDomain, createdAt: number): string {
  const day = compactTimestamp(new Date(createdAt)).split("-")[0];
  return `afr-${domain}-${day}${AFRBAK_EXTENSION}`;
}

export function buildAccountArchive(input: AccountArchiveInput): AccountArchive {
  const { plan, identity, keys } = input;
  const backupId = input.backupId ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const dek = input.dek ?? newDek();

  const summary: AfrSummary = {
    accountBackupId: normalizeAccountBackupId(identity.accountBackupId),
    appVersion: APP_VERSION,
    counts: plan.counts,
    dateRange: plan.dateRange,
    email: identity.email,
    // A number in the summary, a zero-padded string in the repository: `SCHEMA_VERSION`
    // is compared as a string by the operator's restore script, and squeezed into the
    // 80 KiB summary as an integer.
    schemaVersion: Number(SCHEMA_VERSION),
    sourceInstanceId: sourceInstanceId(),
    totalBytes: plan.totalBytes,
  };

  return {
    backupId,
    createdAt,
    domain: plan.domain,
    summary,
    filename: accountArchiveFilename(plan.domain, createdAt),
    bytes: () =>
      writeArchive({
        domain: plan.domain,
        backupId,
        createdAt,
        masterKey: keys.masterKey,
        dek,
        recoveryWrappingKey: keys.recoveryWrappingKey,
        phraseSalt: keys.phraseSalt,
        summary,
        index: plan.index,
        payload: plan.payload(),
        chunkSize: input.chunkSize,
      }),
  };
}
