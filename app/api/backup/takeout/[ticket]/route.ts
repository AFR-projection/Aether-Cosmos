import { NextRequest } from "next/server";
import { Readable } from "stream";

import { handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { getClientIp } from "@/shared/lib/auth/session";
import { SECURITY_HEADERS } from "@/shared/lib/security";
import {
  buildAccountArchive,
  type AccountArchive,
  type AccountArchiveKeys,
} from "@backup/account/application/export";
import { planBrainExport } from "@backup/account/application/export-brain";
import { planFilesExport } from "@backup/account/application/export-files";
import { AFR_FORMAT_VERSION } from "@backup/account/domain/format";
import { deriveRecoveryWrappingKey, parseMasterKeyRing } from "@backup/account/domain/keys";
import { derivePerFilePhrase } from "@backup/account/domain/per-file-phrase";
import { verifyTakeoutTicket } from "@backup/account/domain/ticket";
import { ensureGeneratedIdentity } from "@backup/account/infrastructure/account-keys";
import { drizzleBrainSource } from "@backup/account/infrastructure/brain-source";
import { drizzleFilesSource } from "@backup/account/infrastructure/files-source";
import { requireBackupRequester } from "../../_guard";

/**
 * `GET /api/backup/takeout/[ticket]` — the download itself, streamed, nothing staged.
 *
 * This is a navigation, so it is the one endpoint in the feature with no CSRF token and no
 * request body (§10). What replaces them is not the ticket: the session is still checked in
 * full by `requireBackupRequester()`, and the ticket is then required to name *this* user and
 * *this* session. A ticket is therefore useless to anyone who steals it — it is a 90-second
 * statement that a dialog was answered, not a bearer credential, and it carries no key
 * material at all.
 *
 * **Keyslot 1 is rebuilt here, not carried here.** `prepare` showed the user nine words derived
 * from `BACKUP_MASTER_KEY` and the ticket's `ticketId`; this handler recomputes the identical
 * words from the same two inputs and runs them through Argon2id to get the wrapping key that
 * seals keyslot 1. Nothing was stored between the two requests, so there is no row to expire, no
 * cache to be down, and a retried navigation inside the 90-second window still produces a file
 * the phrase already written down will open.
 *
 * **The plan is built before the first byte leaves.** `planFilesExport` reads every row and
 * hashes every object; `planBrainExport` reads every table twice. Doing that inside the stream
 * would be cheaper to write and much worse to use: `AccountBackupEncryptedFilesError`,
 * `AccountBackupBadNameError` and `AccountBackupTooBigError` would arrive as a truncated
 * `.afrbak` in the user's Downloads folder instead of as a sentence in a dialog. Everything
 * that can refuse, refuses while a JSON body is still possible.
 *
 * Once the response is returned, a failure has no way to become an error page. A missing R2
 * object or a row deleted mid-read raises `AccountBackupChangedError` inside the generator,
 * which destroys the stream — the browser sees a transfer that ended early rather than a file
 * that looks complete. That is deliberate: an `.afrbak` is either whole or visibly broken, and
 * `finish()` on the way back in proves which.
 *
 * No `Content-Length` (§6.2). The archive's length is not known until it has been written, and
 * writing it to find out is exactly the second copy this design refuses to make.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.2, §10, §13.
 */

/**
 * Drive the archive, then wipe the wrapping key — whichever way the stream ends.
 *
 * The zeroing has to happen *here* rather than beside `buildAccountArchive`. `bytes()` reads
 * `keys.recoveryWrappingKey` lazily, on the first pull, which is after the `Response` has been
 * returned; a buffer cleared before then would seal keyslot 1 under thirty-two zero bytes and
 * hand the user nine words that open nothing. The `finally` covers the client that disconnects
 * at 90% as well as the clean finish.
 *
 * The error path logs and rethrows. A `BackupError` carries a fixed message and a `detail` —
 * never key material, never a full path (`safeLabel` in the exporters) — so this is safe to
 * write to the server log and is the only trace a mid-stream failure leaves.
 */
async function* streamArchive(
  archive: AccountArchive,
  recoveryWrappingKey: Buffer
): AsyncGenerator<Buffer, void, void> {
  try {
    yield* archive.bytes();
  } catch (error) {
    console.error("[afrbak] takeout stream failed", error);
    throw error;
  } finally {
    recoveryWrappingKey.fill(0);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticket: string }> }
) {
  try {
    const { user } = await requireBackupRequester();
    const { ticket } = await params;

    // Throws `AccountBackupTicketError` (403) for every failure — expired, forged, another
    // user's, another session's — with the distinguishing reason kept in `detail` for audit.
    const payload = verifyTakeoutTicket(ticket, {
      userId: user.id,
      sessionId: user.sessionId,
    });

    const ring = parseMasterKeyRing();
    const startedAt = Date.now();

    // The same nine words `prepare` put in the dialog, recomputed from the ticket. Argon2id at
    // m=256 MiB, t=4 costs about a second and 256 MiB of RSS — paid once, before the first byte,
    // rather than per chunk, which is what keeps this inside a 2 GB VPS.
    const recovery = derivePerFilePhrase(ring.active.key, payload.ticketId);
    const keys: AccountArchiveKeys = {
      masterKey: ring.active,
      recoveryWrappingKey: await deriveRecoveryWrappingKey(recovery.phrase, recovery.phraseSalt),
      phraseSalt: recovery.phraseSalt,
    };

    const accountBackupId = await ensureGeneratedIdentity(user.id);

    const plan =
      payload.domain === "files"
        ? await planFilesExport(drizzleFilesSource(user.id))
        : await planBrainExport(drizzleBrainSource(user.id, new Date(startedAt)));

    const archive = buildAccountArchive({
      plan,
      identity: {
        accountBackupId,
        // Metadata only (§3.1), and omitted rather than blanked when the row has none.
        ...(user.email ? { email: user.email } : {}),
      },
      keys,
      createdAt: startedAt,
    });

    // Before the first byte, so a download that dies halfway is still on the record.
    await logActivity(user, "backup_takeout", {
      resourceType: "account_backup",
      resourceId: archive.backupId,
      metadata: {
        domain: archive.domain,
        accountBackupId,
        rowCount: archive.summary.counts.rows,
        totalBytes: archive.summary.totalBytes,
        formatVersion: AFR_FORMAT_VERSION,
        keyId: keys.masterKey.keyId,
        ticketId: payload.ticketId,
        result: "ok",
        phraseMode: "per_file",
      },
      ip: getClientIp(request),
    });

    // `objectMode: false` on purpose: in object mode the high-water mark counts chunks, so
    // sixteen 4 MiB chunks — 64 MiB — could sit in memory ahead of a slow client. In byte mode
    // the mark is 16 KiB, which the first chunk overshoots, so at most one chunk is resident
    // and the generator stops until the socket drains. This runs on a 2 GB VPS.
    const source = Readable.from(streamArchive(archive, keys.recoveryWrappingKey), {
      objectMode: false,
    });

    return new Response(Readable.toWeb(source) as unknown as ReadableStream, {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${archive.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
