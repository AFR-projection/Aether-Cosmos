import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db, recalculateUsedBytes } from "@/shared/infrastructure/db";
import { files, users } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getAccessibleFile, getEffectiveUserId, fileRefusal } from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf, checkUserApiRateLimit } from "@/shared/lib/security";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { readBoundedText } from "@/shared/api/read-body";
import { objectExists, putR2Object } from "@files/infrastructure/storage/r2";
import { snapshotFileVersion } from "@files/application/commands/versions";
import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";
import {
  TEXT_EDIT_MAX_BYTES,
  isTextEditable,
  withinTextEditBounds,
} from "@files/domain/services/text-edit-limits";

/**
 * Save edited text back over a stored file.
 *
 * Reading a text file already works (`GET /api/files/[id]/preview`); this is the write
 * half, so a project uploaded here can be worked on here instead of being downloaded,
 * edited locally and uploaded again.
 *
 * The body is the file's bytes, sent raw as `text/plain` rather than wrapped in JSON.
 * JSON would escape the content, so a 512 KB file could arrive as a 1 MB request and
 * the one ceiling the user is told about would no longer be the ceiling being applied.
 * Raw text keeps the number the user sees, the number the reader enforces and the
 * number of bytes stored the same number. CSRF is unaffected — it is a header/cookie
 * pair (`validateCsrf`), never a body field.
 */

/**
 * Two ceilings, doing two jobs. `withinTextEditBounds` is the POLICY — the size the
 * editor tells the user about, checked exactly. The reader's cap is only an
 * ALLOCATION guard, set above the policy so that anything a real editor session can
 * produce reaches the friendly refusal instead of a bare "body too large".
 */
const BODY_READ_CEILING_BYTES = TEXT_EDIT_MAX_BYTES * 2;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const { id } = await params;
    const actorId = getEffectiveUserId(sessionUser);
    const ip = getClientIp(request);

    const settings = await getAdminSettings();
    const rl = await checkUserApiRateLimit(actorId, settings.rateLimitPerMinute);
    if (!rl.allowed) return apiError("Rate limit exceeded", 429);

    const content = await readBoundedText(request, BODY_READ_CEILING_BYTES);

    const accessible = await getAccessibleFile(sessionUser, id);
    if (!accessible) return apiError("File not found", 404);
    // A viewer in a shared folder is told WHY, in the same words every other refusal
    // for that role uses, rather than a 404 that reads like a bug.
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);
    const file = accessible.file;

    // Notes keep their body in the database and have their own editor; there is no R2
    // object here to write over.
    if (file.isNote || file.r2Key.startsWith("notes/")) {
      return apiError("Notes are edited in the note editor", 400, { code: "EDIT_NOTE_REFUSED" });
    }

    /**
     * An encrypted file is stored as ciphertext and decrypted in the browser. The
     * editor is looking at the decrypted text, so saving would write plaintext over
     * the ciphertext and leave a file that no longer matches its own
     * `encryptionMeta` — unreadable, and silently so.
     */
    if (file.encrypted) {
      return apiError("Encrypted files can't be edited in the browser", 400, {
        code: "EDIT_ENCRYPTED_REFUSED",
      });
    }

    if (!isTextEditable(file.mimeType, file.name)) {
      return apiError("Only text and code files can be edited here", 400, {
        code: "EDIT_MIME_REFUSED",
      });
    }

    if (!withinTextEditBounds(content)) {
      return apiError("This file is too large to edit in the browser", 413, {
        code: "EDIT_TEXT_TOO_LARGE",
        maxBytes: TEXT_EDIT_MAX_BYTES,
      });
    }

    if (file.r2Key === "pending" || !(await objectExists(file.r2Key))) {
      return apiError("This file isn't in storage yet. Upload it again first.", 404);
    }

    /**
     * Optimistic concurrency. `files.version` is bumped by every snapshot, so the
     * version the editor loaded is a token for "the bytes I am editing". If a
     * collaborator (or another tab) saved in between, the token is stale and this
     * save would silently discard their work.
     *
     * The header is optional so a scripted client can opt out; the editor always
     * sends it.
     */
    const expected = request.headers.get("x-expected-version");
    if (expected !== null) {
      const expectedVersion = Number(expected);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return apiError("x-expected-version must be a positive integer", 400);
      }
      if (expectedVersion !== file.version) {
        return apiError(
          "This file changed since you opened it. Reload it before saving.",
          409,
          { code: "EDIT_VERSION_CONFLICT", currentVersion: file.version }
        );
      }
    }

    const body = Buffer.from(content, "utf8");

    /**
     * Quota is the OWNER's, not the editor's — a collaborator saving inside someone
     * else's shared folder spends the folder owner's allowance. Only the delta
     * counts: `recalculateUsedBytes` sums live files, so the version snapshot this
     * save leaves behind is not charged.
     */
    const [owner] = await db.select().from(users).where(eq(users.id, file.userId)).limit(1);
    if (!owner) return apiError("File owner not found", 404);
    const delta = body.length - Number(file.sizeBytes);
    if (delta > 0 && owner.usedBytes + delta > owner.quotaBytes) {
      return apiError("Storage quota exceeded", 400, { code: "QUOTA_EXCEEDED" });
    }

    // Keep the previous bytes recoverable before overwriting them — the same
    // guarantee the image editor and the trim job give.
    await snapshotFileVersion(file, actorId);

    await putR2Object(file.r2Key, body, file.mimeType || "text/plain");

    /**
     * The checksum is refreshed with the bytes. Leaving a stale one behind would make
     * every later integrity check disagree with storage — the reconciliation worker
     * would read a mismatch as corruption.
     *
     * `contentText` is deliberately NOT written: it feeds the generated search
     * vector, it is only ever set for notes today, and Postgres refuses a tsvector
     * over ~1 MB, so a large body would fail the save itself.
     */
    const [updated] = await db
      .update(files)
      .set({
        sizeBytes: body.length,
        checksumSha256: createHash("sha256").update(body).digest("hex"),
        updatedAt: new Date(),
      })
      .where(eq(files.id, file.id))
      .returning({
        sizeBytes: files.sizeBytes,
        version: files.version,
        updatedAt: files.updatedAt,
      });

    await recalculateUsedBytes(file.userId);
    cacheDelPattern(`files:${file.userId}:*`).catch(() => {});

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { kind: "text_content", sizeBytes: body.length, version: updated.version },
      ip,
    });

    return apiSuccess({
      sizeBytes: updated.sizeBytes,
      version: updated.version,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
