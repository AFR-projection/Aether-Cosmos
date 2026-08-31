import { NextRequest } from "next/server";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { getActiveUploads } from "@files/infrastructure/storage/upload-service";

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    return apiSuccess({ uploads: await getActiveUploads(getEffectiveUserId(sessionUser)) });
  } catch (error) {
    return handleApiError(error);
  }
}
