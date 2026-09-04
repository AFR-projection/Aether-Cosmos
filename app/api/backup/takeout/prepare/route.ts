import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { apiError, apiRateLimited, apiSuccess, handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { getClientIp } from "@/shared/lib/auth/session";
import { checkRateLimit, validateCsrf } from "@/shared/lib/security";
import { accountArchiveFilename } from "@backup/account/application/export";
import { AccountBackupEncryptedFilesError } from "@backup/account/domain/errors";
import { parseMasterKeyRing } from "@backup/account/domain/keys";
import { derivePerFilePhrase } from "@backup/account/domain/per-file-phrase";
import { mintTakeoutTicket, TICKET_TTL_MS } from "@backup/account/domain/ticket";
import { ensureGeneratedIdentity } from "@backup/account/infrastructure/account-keys";
import { readFilesOverview } from "@backup/account/infrastructure/overview";
import { requireBackupRequester } from "../../_guard";

/**
 * `POST /api/backup/takeout/prepare` — everything that must happen *before* a download can start.
 *
 * Three things, in this order, and the order is the point: refuse what cannot be exported, mint
 * the ticket, and return the nine words that open the archive the next request will write.
 *
 * **The phrase comes back every single time.** It is derived from `BACKUP_MASTER_KEY` and this
 * ticket's `ticketId` (`domain/per-file-phrase.ts`), so it is different for every download and
 * nothing about it is stored — not here, not in Redis, not in a row. The download handler
 * recomputes the identical words from the ticket it is handed, which is what lets the dialog and
 * the file agree without a carrier between the two requests.
 *
 * **Why the phrase is shown before the bytes move.** The dialog is the only moment it exists in
 * readable form. Returning it alongside the download URL means the page can block on "write these
 * down" and start the navigation afterwards; the earlier shape — start the download, then show the
 * phrase — meant a user who closed the tab kept a `.afrbak` and lost the only thing that opens it
 * on a rebuilt server.
 *
 * The refusals belong here rather than in the stream for the reason `[ticket]/route.ts` spells
 * out: `AFRBAK_ENCRYPTED_FILES` is a sentence in a dialog while a JSON body is still possible, and
 * a truncated download once it is not.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.3, §6.1, §10.
 */

/** One takeout per domain per window. The window, in ms. */
const PREPARE_WINDOW_MS = 600_000;
const PREPARE_MAX = 1;

const bodySchema = z.object({ domain: z.enum(["files", "brain"]) });

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { user } = await requireBackupRequester();
    const { domain } = bodySchema.parse(await request.json());

    const limit = await checkRateLimit(
      `afrbak-prepare:${user.id}:${domain}`,
      PREPARE_MAX,
      PREPARE_WINDOW_MS
    );
    if (!limit.allowed) {
      return apiRateLimited(
        "A backup was started for this section recently. Try again in a few minutes.",
        Math.ceil(PREPARE_WINDOW_MS / 1000),
        { code: "AFRBAK_PREPARE_RATE_LIMITED" }
      );
    }

    // Throws `AccountBackupNotConfiguredError` (503) when `BACKUP_MASTER_KEY` is absent or
    // unusable. On a deployment made by `scripts/deploy/*` it never is: the installer generates
    // one on first run and never replaces an existing value.
    const ring = parseMasterKeyRing();

    if (domain === "files") {
      const overview = await readFilesOverview(user.id);
      if (overview.encryptedFiles > 0) {
        throw new AccountBackupEncryptedFilesError(overview.encryptedFiles);
      }
    }

    // Minted here rather than left to `mintTakeoutTicket`, because the phrase is derived from it
    // and both sides of the download have to name the same one.
    const ticketId = randomUUID();
    const recovery = derivePerFilePhrase(ring.active.key, ticketId);

    const accountBackupId = await ensureGeneratedIdentity(user.id);

    const ip = getClientIp(request);
    // §13: that a phrase was shown is on the record; the words themselves never are. `words` is
    // the count, nine — the audit trail must stay safe to read out loud.
    await logActivity(user, "backup_recovery_view", {
      resourceType: "account_backup",
      resourceId: accountBackupId,
      metadata: { domain, op: "per_file", words: recovery.words, ticketId },
      ip,
    });

    const now = Date.now();
    const ticket = mintTakeoutTicket({
      domain,
      userId: user.id,
      sessionId: user.sessionId,
      ticketId,
      now,
    });

    return apiSuccess({
      ticket,
      url: `/api/backup/takeout/${encodeURIComponent(ticket)}`,
      expiresAt: new Date(now + TICKET_TTL_MS).toISOString(),
      filename: accountArchiveFilename(domain, now),
      accountBackupId,
      // Always present — every download has its own phrase, and this is the only place it is
      // readable. The page must not start the navigation until the dialog has been acknowledged.
      phrase: recovery.phrase,
      phraseWords: recovery.words,
      phraseBits: recovery.bits,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
