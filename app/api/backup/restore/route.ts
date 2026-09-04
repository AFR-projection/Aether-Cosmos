import { NextRequest } from "next/server";
import { Readable } from "stream";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";
import { logActivity } from "@/shared/lib/auth/audit";
import { getClientIp, type SessionUser } from "@/shared/lib/auth/session";
import { validateCsrf } from "@/shared/lib/security";
import { STEP_CODE_MAX_LENGTH, STEP_CODE_MIN_LENGTH } from "@/shared/lib/security/step-code";
import { checkStepCode } from "@/shared/lib/security/step-code-gate";
import { getAdminSettings, isUploadAllowed } from "@/shared/lib/settings/admin-settings";
import { listBrains } from "@brain/application/commands/brain-service";
import {
  describeFailure,
  restoreAccountArchive,
  type RestoreOutcome,
  type RestoreTarget,
} from "@backup/account/application/import";
import {
  AccountBackupError,
  AccountBackupUploadTruncatedError,
} from "@backup/account/domain/errors";
import { parseMasterKeyRing } from "@backup/account/domain/keys";
import { adoptIdentity, listBoundIdentities } from "@backup/account/infrastructure/account-keys";
import { drizzleRestoreLedger } from "@backup/account/infrastructure/ledger";
import {
  brainRestoreSession,
  filesRestoreSession,
  type BrainRestoreSession,
  type FilesRestoreSession,
} from "@backup/account/infrastructure/sessions";
import { requireBackupRequester } from "../_guard";
// Relative because this is the seam between two features and `app/` is where the layer rules put
// one. See `_aftercare.ts` — the module needs `@brain/*` and lives here so `@backup` need not.
import {
  scheduleDerivedGraphRebuild,
  type DerivedRebuildReport,
} from "./_aftercare";

/**
 * `POST /api/backup/restore` — the archive goes in, and the five stages decide.
 *
 * This route is thin on purpose. `restoreAccountArchive` owns the order §7.3 fixes — validate →
 * reserve → import/stage → verify → commit — and every refusal it can raise is already shaped for
 * `handleApiError`. What is left here is the four things only a route can do: prove the request is
 * this session's, ask for the second factor when the mode can remove data, hand the upload over as
 * a stream, and write the three audit lines that outlive the request.
 *
 * ## The upload is never a `Buffer`
 *
 * `Readable.fromWeb(request.body)` is the whole of the body handling. There is no
 * `request.formData()`, no `arrayBuffer()`, and no temporary file: a 40 GB `.afrbak` is read
 * 4 MiB at a time and each chunk is decrypted, written and dropped. The `X-Afr-*` headers carry
 * everything else, for the reason `restore/inspect` documents — a query string would put the
 * recovery phrase in nginx's access log, and `formData()` would buffer the archive before this
 * function saw a byte of it.
 *
 * The bytes are counted on the way past, for the one failure the archive reader cannot describe:
 * an upload that ended early reaches the reader as a file missing its trailer, and §12 requires
 * that to be reported as "wrong phrase or damaged file". Comparing what arrived against the
 * `Content-Length` the browser itself set tells the two apart — see the `catch`.
 *
 * ## Why `replace` asks for the 2-Step Code and `merge` does not
 *
 * `merge` cannot lose anything: unmatched paths are renamed, matched ones are skipped, and the
 * worst outcome is a folder with more in it than the person expected. `replace` sends everything
 * the account currently has to the Recycle Bin (Files) or deletes it outright (Brain), so it is
 * the one action in this feature that destroys data — and a stolen session should not be able to
 * take it. The code is read from `X-Afr-Step-Code` and checked against the same counters login
 * uses, so a brute force locks the account out of both at once.
 *
 * ## The three audit lines
 *
 * A restore writes `backup_restore_merge` or `backup_restore_replace` on success — with
 * `swap`/`deleted` counts the application layer has no field for, because only the session that
 * committed knows them — plus `backup_restore_adopted` when the phrase bound a new identity, and
 * `backup_restore_refused` on every failure carrying the refusal number and its `detail`. The
 * refusal line is written *before* `handleApiError`, so the record exists even for the failures
 * that return a deliberately vague sentence to the browser (§12).
 *
 * ## What a Brain restore leaves for the worker
 *
 * The archive carries the graph the account *authored* and `memories.embedding` besides, but not
 * `memory_derived_links` — the scored edges behind `/brain/graph` are `DERIVED_TABLES` and are
 * recomputed, never carried. Nothing recomputes them on its own, so a brain restore ends by
 * asking for the sweep: `scheduleDerivedGraphRebuild` over every brain the account owns, after
 * the commit and never before it. It cannot fail the request, and the count it returns travels in
 * the response and the audit line so a stopped worker reads as "queued 0 of 1" rather than as an
 * empty graph nobody can explain.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §10, §13.
 */

const headerSchema = z.object({
  domain: z.enum(["files", "brain"]),
  mode: z.enum(["merge", "replace"]).default("merge"),
  phrase: z.string().min(1).max(512).optional(),
  stepCode: z.string().trim().min(STEP_CODE_MIN_LENGTH).max(STEP_CODE_MAX_LENGTH).optional(),
});

/**
 * What `replace` sent away, in the shape each domain can actually count.
 *
 * Files soft-deletes rows into the Recycle Bin, so the numbers are folders and files. Brain
 * deletes outright across a handful of tables, so the numbers are tables touched and rows gone.
 * Both are counts and nothing else — §13 forbids a name or a path here.
 */
type RemovedCounts =
  | { folders: number; files: number }
  | { tables: number; rows: number };

/**
 * What the browser is told about a restore that worked.
 *
 * `report` is the four numbers §7.5 defines — rows, bytes, skipped, renamed — and `removed` is
 * what `replace` sent away, present only when there was a swap to describe. Nothing here is
 * derived from the archive's claims: these are counts of what was actually written.
 *
 * `graph` is the one field that describes work that has *not* happened yet: the derived-edge
 * sweep a Brain restore hands to the worker. `null` for Files, which has no graph.
 */
function successBody(
  outcome: RestoreOutcome,
  removed: RemovedCounts | null,
  graph: DerivedRebuildReport | null
) {
  return {
    restoreBatchId: outcome.restoreBatchId,
    domain: outcome.report.domain,
    mode: outcome.report.mode,
    report: {
      rows: outcome.report.rows,
      bytes: outcome.report.bytes,
      skipped: outcome.report.skipped,
      renamed: outcome.report.renamed,
    },
    backupId: outcome.backupId,
    createdAt: new Date(outcome.createdAt).toISOString(),
    formatVersion: outcome.formatVersion,
    keyId: outcome.keyId,
    via: outcome.via,
    stale: outcome.stale,
    adopted: outcome.adopted,
    accountBackupId: outcome.summary.accountBackupId,
    expected: {
      rows: outcome.summary.counts.rows,
      bytes: outcome.summary.totalBytes,
    },
    removed,
    graph,
  };
}

/**
 * `Content-Length`, or `null` if there is nothing trustworthy to compare against.
 *
 * A browser posting a `File` always sets it, so in practice this is the size of the archive the
 * person picked. Anything else — absent, `chunked`, a negative, a number past `Number`'s exact
 * range — means the request carries no claim about its own length, and a missing claim must never
 * become evidence of truncation.
 */
function parseContentLength(header: string | null): number | null {
  if (header === null) return null;
  const value = Number(header.trim());
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * The upload, with a running total.
 *
 * `ended` is set only after the body's own iterator finishes, which is the whole point: a reader
 * that stops early — a GCM tag that did not verify, a `replace` refused on the header's domain —
 * closes this generator through `.return()`, the line after the loop never runs, and the failure
 * it raised is reported as itself. So `ended === true` means "the body said it was over", and
 * only then is a short count worth anything.
 *
 * A connection that drops mid-upload is a third case and needs nothing here: the iterator rejects
 * rather than completing, so `ended` stays false and the stream's own error propagates.
 */
async function* counted(
  stream: AsyncIterable<Uint8Array>,
  tally: { received: number; ended: boolean }
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    tally.received += chunk.byteLength;
    yield chunk;
  }
  tally.ended = true;
}

export async function POST(request: NextRequest) {
  // Read before the first `await` that can throw, so the refusal audit line has an IP even when
  // the failure happened on the first 32 bytes of the upload.
  const ip = getClientIp(request);
  let actor: SessionUser | null = null;
  let context: { domain?: "files" | "brain"; mode?: "merge" | "replace" } = {};

  // What the browser said it was sending, and what actually arrived. Declared out here because the
  // `catch` is the only place the two numbers mean anything together.
  const expectedBytes = parseContentLength(request.headers.get("content-length"));
  const tally = { received: 0, ended: false };

  /**
   * §13's seventh label, for every way a restore can end without data moving.
   *
   * Shared by the step-code denial and the catch because both are refusals and neither is more
   * worth recording than the other — a `replace` stopped by a wrong second factor is exactly the
   * event an account owner wants to find afterwards. A failure to write it is swallowed: the
   * caller's error is the one that matters.
   */
  async function auditRefusal(detail: string, extra: Record<string, unknown> = {}) {
    const who = actor;
    if (who === null) return;
    try {
      await logActivity(who, "backup_restore_refused", {
        resourceType: "account_backup",
        metadata: { ...context, ...extra, result: "refused", detail },
        ip,
      });
    } catch {
      // Deliberately ignored — see above.
    }
  }

  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { user } = await requireBackupRequester();
    actor = user;

    const parsed = headerSchema.safeParse({
      domain: request.headers.get("x-afr-domain") ?? undefined,
      mode: request.headers.get("x-afr-mode") ?? undefined,
      phrase: request.headers.get("x-afr-phrase") ?? undefined,
      stepCode: request.headers.get("x-afr-step-code") ?? undefined,
    });
    if (!parsed.success) {
      return apiError("Missing or invalid X-Afr-Domain / X-Afr-Mode header", 400, {
        code: "AFRBAK_BAD_REQUEST",
      });
    }
    const { domain, mode, phrase, stepCode } = parsed.data;
    context = { domain, mode };

    // The second factor, before the body is touched at all: an upload that is going to be
    // refused should be refused while it is still one round trip rather than 40 GB.
    if (mode === "replace") {
      if (stepCode === undefined) {
        // Not `STEP_CODE_REQUIRED`: that code already means "your administrator requires a
        // 2-Step Code and it cannot be removed", and the i18n registry answers it with that
        // sentence. This one means "type it now".
        await auditRefusal("step code required", { code: "AFRBAK_STEP_CODE_REQUIRED" });
        return apiError("Enter your 2-Step Code to replace this section.", 401, {
          code: "AFRBAK_STEP_CODE_REQUIRED",
        });
      }
      const gate = await checkStepCode(user.id, stepCode);
      if (!gate.ok) {
        await auditRefusal(`step code ${gate.reason}`, {
          code: gate.code,
          justLocked: gate.justLocked,
        });
        // `remaining` travels because the dialog is worth being honest with — the alternative is
        // an account that discovers the lockout by hitting it.
        return apiError(gate.message, gate.status, {
          code: gate.code,
          remaining: gate.remaining,
        });
      }
    }

    const ring = parseMasterKeyRing();

    if (request.body === null) {
      return apiError("No backup file was uploaded.", 400, { code: "AFRBAK_BAD_REQUEST" });
    }
    // The same cast the ZIP download and `r2-stream` use: `request.body` is undici's
    // `ReadableStream`, structurally the `stream/web` one `fromWeb` is typed against.
    const body = Readable.fromWeb(request.body as import("stream/web").ReadableStream);
    const source = counted(body, tally);

    // Each session is kept in its concrete type rather than only as a `RestoreTarget`, because
    // `swap` and `deleted` are readable off the implementation alone — and they are what §13's
    // audit row for `replace` is made of. Exactly one of the two is ever built.
    let target: RestoreTarget;
    let files: FilesRestoreSession | null = null;
    let brain: BrainRestoreSession | null = null;
    if (domain === "files") {
      // This instance's upload policy, resolved once rather than per file: `isUploadAllowed`
      // otherwise falls back to `getAdminSettingsSync()`, which can be a cold cache inside a long
      // restore. A blocked type is skipped as a renamed-away row, never a refusal (§7.5).
      const settings = await getAdminSettings();
      files = filesRestoreSession({ userId: user.id, mode });
      target = {
        domain: "files",
        session: files,
        mimeAllowed: (mime, name) => isUploadAllowed(mime, name, settings).allowed,
      };
    } else {
      brain = brainRestoreSession({ ownerUserId: user.id, mode });
      target = { domain: "brain", session: brain };
    }

    const outcome = await restoreAccountArchive({
      source,
      ring,
      mode,
      caller: { userId: user.id, boundIds: await listBoundIdentities(user.id) },
      ledger: drizzleRestoreLedger({ userId: user.id }),
      target,
      ...(phrase === undefined ? {} : { phrase }),
    });

    // Only now, and in this order: the binding is worth keeping because the restore it enabled
    // succeeded, and it is written before the response so a reload cannot find the archive
    // unbound again (§3.2).
    if (outcome.adopted) {
      await adoptIdentity(user.id, outcome.summary.accountBackupId);
      await logActivity(user, "backup_restore_adopted", {
        resourceType: "account_backup",
        resourceId: outcome.summary.accountBackupId,
        metadata: {
          domain,
          mode,
          backupId: outcome.backupId,
          restoreBatchId: outcome.restoreBatchId,
          formatVersion: outcome.formatVersion,
          keyId: outcome.keyId,
          via: outcome.via,
          source: "adopted",
          result: "ok",
        },
        ip,
      });
    }

    const swap = files?.swap ?? null;
    const deleted = brain?.deleted ?? null;
    const removed: RemovedCounts | null =
      swap !== null
        ? { folders: swap.softDeletedFolders, files: swap.softDeletedFiles }
        : deleted !== null
          ? { tables: deleted.deletedByTable.size, rows: deleted.deletedRows }
          : null;

    /**
     * The derived graph, asked for after the data is safely committed.
     *
     * Every brain the account owns rather than only the ones the archive named, and for two
     * reasons: a `merge` can attach memories to a brain that already existed, whose neighbours
     * now score differently; and the sweep is idempotent, so a brain the restore never touched
     * costs one enqueue and a no-op. `listBrains` is the same query `/brain` lists with, so the
     * set can never be wider than the account's own.
     *
     * Wrapped because a failure here is not a failed restore. The rows are in; a Redis that
     * refused a connection must not turn that into a 500 that tells the person their data did
     * not arrive.
     */
    let graph: DerivedRebuildReport | null = null;
    if (domain === "brain") {
      try {
        const owned = await listBrains(user.id);
        graph = await scheduleDerivedGraphRebuild(owned.map((each) => each.id));
      } catch {
        graph = { brains: 0, queued: 0 };
      }
    }

    const action = mode === "replace" ? "backup_restore_replace" : "backup_restore_merge";
    await logActivity(user, action, {
      resourceType: "account_backup",
      resourceId: outcome.backupId,
      metadata: {
        domain,
        mode,
        restoreBatchId: outcome.restoreBatchId,
        accountBackupId: outcome.summary.accountBackupId,
        rowCount: outcome.report.rows,
        totalBytes: outcome.report.bytes,
        skipped: outcome.report.skipped,
        renamed: outcome.report.renamed,
        expectedRows: outcome.summary.counts.rows,
        expectedBytes: outcome.summary.totalBytes,
        formatVersion: outcome.formatVersion,
        keyId: outcome.keyId,
        via: outcome.via,
        stale: outcome.stale,
        adopted: outcome.adopted,
        // §13: `replace` records what it removed. Counts only — never a name, never a path. The
        // per-table breakdown is spelled out for Brain because "4 tables" is not a number anyone
        // can act on; a `Map` would serialize to `{}`, so it is flattened here.
        ...(removed === null ? {} : { removed }),
        ...(deleted === null ? {} : { removedByTable: Object.fromEntries(deleted.deletedByTable) }),
        // Recorded because "the graph was empty after a restore" is a support question, and this
        // is the line that answers it: `queued` below `brains` means the worker was not reachable.
        ...(graph === null ? {} : { graphRebuild: graph }),
        result: "ok",
      },
      ip,
    });

    return apiSuccess(successBody(outcome, removed, graph));
  } catch (error) {
    /**
     * A body that ended cleanly but short of what the browser said it was sending was cut in
     * transit, and everything the reader threw afterwards is a symptom of the bytes that never
     * arrived — most often the trailer check, which is the last 80 bytes of every archive.
     *
     * Replacing the refusal here rather than inside the reader is deliberate: the reader knows
     * only that the stream ended, and §12 is right to fold that in with a wrong phrase. This
     * function knows something the reader cannot — the length the *sender* claimed — and that
     * number came from the caller, so handing it back is not an oracle.
     */
    const truncated =
      tally.ended && expectedBytes !== null && tally.received < expectedBytes
        ? new AccountBackupUploadTruncatedError(tally.received, expectedBytes)
        : null;

    // Written before `handleApiError` so the record exists even for the failures that return a
    // deliberately vague sentence to the browser (§12). `describeFailure` is the same string the
    // batch row kept, so the audit trail and `restore_batches.error` cannot disagree — and when the
    // response is rewritten, the row keeps both codes so an operator can see which was replaced.
    const refusal: Record<string, unknown> =
      error instanceof AccountBackupError ? { reason: error.reason, code: error.code } : {};
    await auditRefusal(
      describeFailure(error),
      truncated === null
        ? refusal
        : {
            ...refusal,
            ...(refusal.code === undefined ? {} : { replacedCode: refusal.code }),
            code: truncated.code,
            receivedBytes: truncated.receivedBytes,
            expectedBytes: truncated.expectedBytes,
          }
    );
    return handleApiError(truncated ?? error);
  }
}
