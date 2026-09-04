import { apiSuccess, handleApiError } from "@/shared/api/response";
import { PASSPHRASE_WORDS } from "@backup/domain/passphrase";
import { readIdentityStatus } from "@backup/account/infrastructure/account-keys";
import { readAccountBackupOverview } from "@backup/account/infrastructure/overview";
import { formatAccountBackupId } from "@backup/account/domain/identity";
import { MAX_PREVIEW_BYTES } from "@backup/account/domain/format";
import { requireBackupRequester } from "../_guard";

/**
 * `GET /api/backup/identity` — everything `/backup` needs to draw itself, in one request.
 *
 * Two things, and neither of them is a secret: which `accountBackupId` this instance minted for
 * the account, and which dead instances' ids it has adopted. No recovery phrase appears here and
 * none can — every archive has its own, derived per download from `BACKUP_MASTER_KEY` and that
 * download's ticket (§4.3), readable only in the `prepare` response that mints it. There is no
 * stored phrase left for this endpoint to report the health of.
 *
 * The two domain overviews ride along rather than living on a sixth endpoint. They are seven
 * `COUNT`/`SUM` aggregates over indexed columns (`infrastructure/overview.ts`), so the page boots
 * in one round trip instead of three, and §10's five-endpoint authorization table stands
 * unchanged. What they are deliberately *not* is an export plan: `planFilesExport` reads every row
 * and every INDEX byte, which would make opening the page cost what a download costs.
 *
 * No CSRF (§10): a GET that writes nothing needs none. `ensureGeneratedIdentity` is the one write
 * hiding in here — the account's identity row is minted lazily on first sight — and it is
 * idempotent under a partial unique index, which is what makes it safe on a read path.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §10, §14.
 */
export async function GET() {
  try {
    const { user } = await requireBackupRequester();

    const [identity, overview] = await Promise.all([
      readIdentityStatus(user.id),
      readAccountBackupOverview(user.id),
    ]);

    return apiSuccess({
      identity,
      overview,
      phraseWords: PASSPHRASE_WORDS,
      previewBytes: MAX_PREVIEW_BYTES,
      accountBackupIdDisplay: formatAccountBackupId(identity.accountBackupId),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
