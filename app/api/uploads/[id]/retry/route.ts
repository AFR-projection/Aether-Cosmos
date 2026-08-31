import { NextRequest } from "next/server";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { retryUpload } from "@files/infrastructure/storage/upload-service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const { id } = await params;
    return apiSuccess(await retryUpload(id, getEffectiveUserId(sessionUser)));
  } catch (error) {
    return handleApiError(error);
  }
}
