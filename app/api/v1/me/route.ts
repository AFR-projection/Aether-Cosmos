import { NextRequest } from "next/server";
import { requireAuthOrApiKey, keyHasScope, type SessionUserFromApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import { buildApiV1Docs } from "@/lib/api/v1-docs";
import { buildMasterApiDocs } from "@/lib/api/master-v1-docs";
import { appPublicUrl } from "@/lib/env/runtime";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import type { SessionUser } from "@/lib/auth/session";

function isApiKeySession(user: SessionUser): user is SessionUserFromApiKey {
  return "authMethod" in user && user.authMethod === "api_key";
}

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, []);
    const userId = getEffectiveUserId(sessionUser);
    const isMasterKey =
      isApiKeySession(sessionUser) && sessionUser.apiKeyTier === "master";
    const docs = isMasterKey ? buildMasterApiDocs() : buildApiV1Docs();
    const scopes = isApiKeySession(sessionUser) ? sessionUser.apiKeyScopes : null;

    const availableEndpoints = docs.endpoints.filter((endpoint) => {
      if (!scopes) return true;
      return keyHasScope(scopes, endpoint.scope);
    });

    return apiSuccess({
      connected: true,
      authMethod: isApiKeySession(sessionUser) ? sessionUser.authMethod : "session",
      tier: isApiKeySession(sessionUser) ? sessionUser.apiKeyTier : "session",
      user: {
        id: userId,
        username: sessionUser.username,
        role: sessionUser.role,
        quotaBytes: sessionUser.quotaBytes,
        usedBytes: sessionUser.usedBytes,
      },
      apiKey: scopes
        ? {
            id: isApiKeySession(sessionUser) ? sessionUser.apiKeyId : null,
            tier: isApiKeySession(sessionUser) ? sessionUser.apiKeyTier : null,
            scopes,
            hasSupreme: scopes.includes("supreme"),
            availableEndpoints,
          }
        : null,
      baseUrl: appPublicUrl() || request.nextUrl.origin,
      docsUrl: `${appPublicUrl() || request.nextUrl.origin}/api/v1/docs`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
