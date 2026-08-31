import { NextRequest } from "next/server";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { getUpload } from "@files/infrastructure/storage/upload-service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    const { id } = await params;
    return apiSuccess(await getUpload(id, getEffectiveUserId(sessionUser)));
  } catch (error) {
    return handleApiError(error);
  }
}
