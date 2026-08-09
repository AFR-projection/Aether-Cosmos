import { NextRequest } from "next/server";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { abortUpload } from "@/lib/storage/upload-service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const { id } = await params;
    return apiSuccess(await abortUpload(id, getEffectiveUserId(sessionUser)));
  } catch (error) {
    return handleApiError(error);
  }
}
