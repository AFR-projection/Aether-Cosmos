import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { commitUploadedPart } from "@files/infrastructure/storage/upload-service";

const schema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().min(1).max(512),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const { id } = await params;
    const body = schema.parse(await request.json());
    return apiSuccess(await commitUploadedPart(id, getEffectiveUserId(sessionUser), body.partNumber, body.etag, body.checksumSha256));
  } catch (error) {
    return handleApiError(error);
  }
}
