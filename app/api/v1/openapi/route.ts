import { NextRequest } from "next/server";
import { requireAuthOrApiKey, isMasterApiKey, extractBearerToken } from "@/shared/lib/auth/api-key";
import { buildOpenApiSpec } from "@/shared/api/openapi";
import { handleApiError } from "@/shared/api/response";

export async function GET(request: NextRequest) {
  try {
    await requireAuthOrApiKey(request, []);
    const token = extractBearerToken(request);
    const includeAdmin = token ? isMasterApiKey(token) : false;
    const spec = buildOpenApiSpec(includeAdmin);

    return new Response(JSON.stringify(spec, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
