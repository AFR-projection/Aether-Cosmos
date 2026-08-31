import { registerOAuthClient, OAuthClientError } from "@/shared/lib/auth/oauth/clients";
import { oauthBodyErrorResponse, oauthError, oauthJson } from "@/shared/lib/auth/oauth/http";
import { readBoundedJson } from "@/shared/api/read-body";
import { getClientIp } from "@/shared/lib/auth/session";
import { checkRateLimit } from "@/shared/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dynamic client registration (RFC 7591) is unauthenticated by design, which made
 * this the one endpoint where anyone on the internet could create rows:
 *
 *  - the body was read with an unbounded `request.json()`;
 *  - the metadata was stored with no length, count or vocabulary check (see
 *    `src/features/auth/domain/services/clients.ts`);
 *  - there was no rate limit at all, so the table could be filled at request speed;
 *  - and the catch-all returned `e.message`, handing the caller driver text —
 *    constraint names, column names — from a 500.
 *
 * A registered client is inert until a user approves it at `/oauth/consent`, so the
 * impact was storage and noise rather than access; the ceilings below make it a
 * bounded amount of both.
 */
const REGISTER_MAX_PER_HOUR = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = await checkRateLimit(`oauth-register:${ip}`, REGISTER_MAX_PER_HOUR, REGISTER_WINDOW_MS);
  if (!limit.allowed) {
    return oauthError("temporarily_unavailable", "Too many registration attempts", 429, {
      retry_after: Math.ceil(REGISTER_WINDOW_MS / 1000),
    });
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (e) {
    return oauthBodyErrorResponse(e) ?? oauthError("invalid_request", "Invalid request body", 400);
  }

  const metadata = (body ?? {}) as {
    client_name?: unknown;
    redirect_uris?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
    token_endpoint_auth_method?: unknown;
  };

  try {
    // Every field is validated inside registerOAuthClient, so unknown shapes become
    // a 400 there rather than reaching a jsonb column.
    const result = await registerOAuthClient({
      client_name: metadata.client_name as string | undefined,
      redirect_uris: (metadata.redirect_uris ?? []) as string[],
      grant_types: metadata.grant_types as string[] | undefined,
      response_types: metadata.response_types as string[] | undefined,
      token_endpoint_auth_method: (metadata.token_endpoint_auth_method ?? "none") as string,
    });

    return oauthJson(result, 201, {
      "Access-Control-Allow-Origin": "*",
    });
  } catch (e) {
    if (e instanceof OAuthClientError) {
      return oauthError("invalid_client_metadata", e.message, e.status);
    }
    // Never echo the internal message to an unauthenticated caller.
    console.error("[oauth/register] registration failed", e);
    return oauthError("server_error", "Registration failed", 500);
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
