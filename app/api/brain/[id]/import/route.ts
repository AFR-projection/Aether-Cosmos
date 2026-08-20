import { NextRequest } from "next/server";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainOwnerContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { BrainValidationError } from "@/lib/brain/errors";
import {
  IMPORT_MAX_TOTAL_BYTES,
  parseBrainArchive,
  previewImport,
  runImport,
} from "@/lib/brain/import-service";

type RouteParams = { params: Promise<{ id: string }> };

/** Upload cap for the compressed archive itself, before anything is decompressed. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * POST /api/brain/[id]/import — load an `.afrbrain` archive into this brain (§37).
 *
 * Two-step by design: without `apply=true` the archive is validated and a preview of
 * counts and warnings is returned with nothing written, so the user confirms against
 * real numbers rather than a filename. `apply=true` writes in one transaction.
 *
 * Owner-only. An agent key must not be able to bulk-load arbitrary content into
 * someone's permanent brain, whatever grant it holds.
 *
 * Body: multipart/form-data with a `file` part, or the raw archive bytes.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const apply = request.nextUrl.searchParams.get("apply") === "true";

    const { userId, principal } = await requireBrainOwnerContext(
      request,
      brainId,
      ["brain.import"],
      apply ? { write: true } : undefined
    );
    await enforceBrainRateLimit(userId, "import", apply ? 5 : 2);

    // Refuse on the declared length before reading a byte of it.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new BrainValidationError("Archive upload is too large");
    }

    const bytes = await readArchiveBytes(request);
    if (bytes.byteLength === 0) throw new BrainValidationError("No archive was uploaded");
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new BrainValidationError("Archive upload is too large");
    }

    const parsed = await parseBrainArchive(bytes);

    if (!apply) {
      // Nothing is written on this path, so nothing is audited as a change — the
      // preview is a read of a file the caller already has.
      return apiSuccess({ applied: false, preview: previewImport(parsed) });
    }

    const result = await runImport({
      brainId,
      principal: { userId, agentId: principal.agentId },
      parsed,
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "brain.imported",
      resourceType: "brain",
      resourceId: brainId,
      metadata: {
        formatVersion: parsed.formatVersion,
        written: result.written,
        dropped: result.dropped,
        warningCount: result.warnings.length,
      },
    });

    return apiSuccess({ applied: true, result });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Accept either a multipart `file` part or the raw body. */
async function readArchiveBytes(request: NextRequest): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new BrainValidationError("Expected a `file` part containing the archive");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BrainValidationError("Archive upload is too large");
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > IMPORT_MAX_TOTAL_BYTES) {
    throw new BrainValidationError("Archive upload is too large");
  }
  return new Uint8Array(buffer);
}
