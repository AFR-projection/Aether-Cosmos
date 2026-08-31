import { NextRequest } from "next/server";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { buildApiV1Docs } from "@/shared/api/v1-docs";
import { buildMasterApiDocs } from "@/shared/api/master-v1-docs";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import type { SessionUser } from "@/shared/lib/auth/session";

function isKeySession(user: SessionUser): user is import("@/shared/lib/auth/api-key").SessionUserFromApiKey {
  return "authMethod" in user && user.authMethod === "api_key";
}

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, []);
    const docs =
      isKeySession(sessionUser) && sessionUser.apiKeyTier === "master"
        ? buildMasterApiDocs()
        : buildApiV1Docs();
    return apiSuccess(docs);
  } catch (error) {
    return handleApiError(error);
  }
}
