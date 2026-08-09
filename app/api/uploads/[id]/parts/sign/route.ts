import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { signMultipartParts } from "@/lib/storage/upload-service";

const schema = z.object({
  partNumbers: z.array(z.number().int().positive()).min(1).max(100),
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
    const parts = await signMultipartParts(id, getEffectiveUserId(sessionUser), body.partNumbers);
    return apiSuccess({ parts });
  } catch (error) {
    return handleApiError(error);
  }
}
