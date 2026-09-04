import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiRateLimited, apiSuccess, handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { getClientIp } from "@/shared/lib/auth/session";
import { checkRateLimit, validateCsrf } from "@/shared/lib/security";
import { readStreamBounded } from "@/shared/lib/stream/read-bounded";
import { planFilesSplit, type FilesSplitPreview } from "@backup/account/application/preview";
import { openArchive } from "@backup/account/domain/archive";
import { AccountBackupTooBigError, AfrTooLargeError } from "@backup/account/domain/errors";
import {
  decodePreamble,
  MAX_PREVIEW_BYTES,
  previewLength,
  PREAMBLE_BYTES,
} from "@backup/account/domain/format";
import { formatAccountBackupId, isBoundIdentity } from "@backup/account/domain/identity";
import { parseMasterKeyRing } from "@backup/account/domain/keys";
import { assertWithinRowCaps, rowCap, type AfrCounts } from "@backup/account/domain/summary";
import { listBoundIdentities } from "@backup/account/infrastructure/account-keys";
import {
  liveAccountFiles,
  liveAccountFolders,
} from "@backup/account/infrastructure/files-sink";
import type { BackupDomain } from "@backup/domain/types";
import { requireBackupRequester } from "../../_guard";

/**
 * `POST /api/backup/restore/inspect` — what is in this file, before any of it is uploaded.
 *
 * The client sends a **prefix**, not the archive: 32 bytes of PREAMBLE tell it exactly how far
 * to read (`previewLength`), and that is at most 81,984 bytes however large the `.afrbak` is
 * (§7.1). A 40 GB archive is described by 80 KiB crossing the wire, and nothing at all is
 * written to disk on the way — the prefix is held in one bounded `Buffer` and dropped when the
 * response is written.
 *
 * ## The transport, and why it is not `multipart/form-data`
 *
 * The body is the raw bytes; everything else rides in headers:
 *
 * | header | meaning |
 * | --- | --- |
 * | `X-Afr-Domain` | which card the user dropped the file on — refusal #5 is decided from it |
 * | `X-Afr-Mode` | `merge` or `replace`, because the split differs and `replace` never renames |
 * | `X-Afr-Phrase` | only when the person typed one |
 *
 * `request.formData()` would buffer the whole part in memory before this route saw a byte of
 * it, which defeats the ceiling. A query string would put the recovery phrase in nginx's
 * `combined` access log, which §12 forbids outright — a header is not logged by that format,
 * and the phrase is never written anywhere else here.
 *
 * ## Exact numbers, or none
 *
 * §7.2 permits the restore/skip/rename split to be stated as fact **only** when it was
 * computed from the archive's own INDEX. So the client may send a longer prefix — through the
 * end of the INDEX — and get `split` back with `splitExact: true`. When the INDEX is over
 * 2 MiB, or the prefix stopped short of it, `split` is `null` and `splitBytesNeeded` says what
 * a second attempt would cost. What this endpoint never does is estimate: a number nobody can
 * reconcile with the report afterwards is worse than no number.
 *
 * ## What it answers about ownership
 *
 * `bound` is whether the archive's `accountBackupId` is one this account holds. When it is
 * not, the restore refuses (#6) *unless* keyslot 1 opened the file — so `willAdopt` is the
 * flag that turns the disaster path on, and it is only ever true when the person typed the
 * phrase. Inspecting without one is how the UI learns it needs to ask.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.1, §7.2, §10.
 */

/** §7.2: an INDEX past this is described by the SUMMARY alone. */
const MAX_SPLIT_INDEX_BYTES = 2 * 1024 * 1024;

/** The preview prefix, plus the largest INDEX an exact split is allowed to read. */
const MAX_INSPECT_BYTES = MAX_PREVIEW_BYTES + MAX_SPLIT_INDEX_BYTES;

const INSPECT_WINDOW_MS = 600_000;
const INSPECT_MAX = 20;

const headerSchema = z.object({
  domain: z.enum(["files", "brain"]),
  mode: z.enum(["merge", "replace"]).default("merge"),
  phrase: z.string().min(1).max(512).optional(),
});

/** Why an exact split was not computed. `ok` is the only value that comes with numbers. */
type SplitReason = "ok" | "brain-has-no-split" | "index-too-large" | "need-more-bytes" | "over-row-cap";

/**
 * The row caps as a question rather than a refusal.
 *
 * An over-cap archive cannot be restored (#8), but it can absolutely be *described*, and
 * describing it is what stops someone uploading 40 GB to be told the same thing. The single
 * source of the limits stays `assertWithinRowCaps`, so this cannot drift from the refusal.
 */
function rowCapCheck(
  domain: BackupDomain,
  counts: AfrCounts
): { ok: true } | { ok: false; rows: number; cap: number } {
  try {
    assertWithinRowCaps(domain, counts);
    return { ok: true };
  } catch (error) {
    if (error instanceof AfrTooLargeError) {
      return { ok: false, rows: error.rows, cap: error.cap };
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { user } = await requireBackupRequester();

    const parsed = headerSchema.safeParse({
      domain: request.headers.get("x-afr-domain") ?? undefined,
      mode: request.headers.get("x-afr-mode") ?? undefined,
      phrase: request.headers.get("x-afr-phrase") ?? undefined,
    });
    if (!parsed.success) {
      return apiError("Missing or invalid X-Afr-Domain / X-Afr-Mode header", 400, {
        code: "AFRBAK_BAD_REQUEST",
      });
    }
    const { domain, mode, phrase } = parsed.data;

    const limit = await checkRateLimit(
      `afrbak-inspect:${user.id}`,
      INSPECT_MAX,
      INSPECT_WINDOW_MS
    );
    if (!limit.allowed) {
      return apiRateLimited(
        "Too many previews. Try again in a few minutes.",
        Math.ceil(INSPECT_WINDOW_MS / 1000),
        { code: "AFRBAK_INSPECT_RATE_LIMITED" }
      );
    }

    const ring = parseMasterKeyRing();

    // 413 with an archive-specific code, not the generic body-size error: the client is
    // expected to send a prefix, and being told the ceiling is how it computes the next one.
    const prefix = await readStreamBounded(
      request.body,
      MAX_INSPECT_BYTES,
      (max) => new AccountBackupTooBigError(`preview prefix over ${max} bytes`)
    );

    // A file too short to hold a preamble is "not an AFR backup", which `openArchive` says
    // for us — decoding here is only so `previewLength` can be reported back.
    const preamble = prefix.length >= PREAMBLE_BYTES ? decodePreamble(prefix) : null;

    const reader = await openArchive({
      source: [prefix],
      ring,
      expectedDomain: domain,
      ...(phrase === undefined ? {} : { phrase }),
    });

    const summary = reader.summary;
    const bound = await listBoundIdentities(user.id);
    const isBound = isBoundIdentity(summary.accountBackupId, bound);
    const willAdopt = !isBound && reader.via === "phrase";
    const caps = rowCapCheck(domain, summary.counts);

    const indexEnd = preamble === null ? null : previewLength(preamble) + preamble.indexLength;

    let split: FilesSplitPreview | null = null;
    let reason: SplitReason = "ok";
    if (domain === "brain") {
      // `merge` inserts every row under a fresh UUID, so nothing is skipped and nothing is
      // renamed. The SUMMARY's counts already say everything there is to say.
      reason = "brain-has-no-split";
    } else if (!caps.ok) {
      reason = "over-row-cap";
    } else if (preamble === null || preamble.indexLength > MAX_SPLIT_INDEX_BYTES) {
      reason = "index-too-large";
    } else if (indexEnd === null || prefix.length < indexEnd) {
      reason = "need-more-bytes";
    } else {
      split = await planFilesSplit({
        reader,
        source: {
          liveFolders: () => liveAccountFolders(user.id),
          liveFiles: () => liveAccountFiles(user.id),
        },
        mode,
      });
    }

    await logActivity(user, "backup_restore_preview", {
      resourceType: "account_backup",
      resourceId: reader.header.backupId,
      metadata: {
        domain,
        mode,
        accountBackupId: summary.accountBackupId,
        rowCount: summary.counts.rows,
        totalBytes: summary.totalBytes,
        formatVersion: reader.preamble.formatVersion,
        keyId: reader.keyId,
        via: reader.via,
        stale: reader.stale,
        bound: isBound,
        willAdopt,
        // Never the phrase, and never a path: the split is four integers.
        splitExact: split !== null,
        result: caps.ok ? "ok" : "over_row_cap",
        ...(caps.ok ? {} : { reason: 8 }),
      },
      ip: getClientIp(request),
    });

    return apiSuccess({
      domain,
      mode,
      backupId: reader.header.backupId,
      createdAt: new Date(reader.header.createdAt).toISOString(),
      formatVersion: reader.preamble.formatVersion,
      keyId: reader.keyId,
      via: reader.via,
      stale: reader.stale,
      summary: {
        accountBackupId: summary.accountBackupId,
        accountBackupIdDisplay: formatAccountBackupId(summary.accountBackupId),
        appVersion: summary.appVersion,
        counts: summary.counts,
        dateRange: summary.dateRange,
        // Metadata, and labelled as such by the UI: it is whatever the source instance knew,
        // which may be an address the account no longer uses (§3.1, test #8).
        email: summary.email,
        schemaVersion: summary.schemaVersion,
        sourceInstanceId: summary.sourceInstanceId,
        totalBytes: summary.totalBytes,
      },
      ownership: {
        bound: isBound,
        willAdopt,
        /** False here means a restore would refuse; the UI must not offer the button. */
        restorable: caps.ok && (isBound || reader.via === "phrase"),
      },
      capacity: {
        withinRowCaps: caps.ok,
        rows: summary.counts.rows,
        cap: rowCap(domain),
      },
      split,
      splitExact: split !== null,
      splitReason: reason,
      /**
       * What the client should send to get an exact split, or `null` when no prefix length
       * would produce one. Sent even when the split succeeded, so a retry is idempotent.
       */
      splitBytesNeeded:
        domain === "files" && indexEnd !== null && preamble !== null
          ? preamble.indexLength <= MAX_SPLIT_INDEX_BYTES
            ? indexEnd
            : null
          : null,
      previewBytesRead: prefix.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
