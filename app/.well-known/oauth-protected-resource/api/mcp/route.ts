import { buildProtectedResourceMetadata } from "@/shared/lib/auth/oauth/metadata";
import { resolvePublicOrigin } from "@/shared/lib/env/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = resolvePublicOrigin(request);
  return Response.json(buildProtectedResourceMetadata(origin), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
