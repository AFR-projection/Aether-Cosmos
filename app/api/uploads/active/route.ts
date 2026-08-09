import { NextRequest } from "next/server";
import { requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { getActiveUploads } from "@/lib/storage/upload-service";

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["upload"]);
    return apiSuccess({ uploads: await getActiveUploads(getEffectiveUserId(sessionUser)) });
  } catch (error) {
    return handleApiError(error);
  }
}
