import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { extractBearerToken } from "@/lib/auth/api-key";
import { AuthError } from "@/lib/auth/session";
import { checkRateLimit, peekRateLimit } from "@/lib/security";
import { BrainError } from "@/lib/brain/errors";
import { createBrainMcpServer } from "./server";
import { resolveMcpPrincipal } from "./principal";

/**
 * Streamable HTTP entry point for the Brain MCP server, in STATELESS mode.
 *
 * Every request builds its own server + transport and tears them down when the
 * response is done. That costs a few object allocations and buys correctness
 * behind nginx or `docker compose` with more than one app process: there is no
 * session map that only one process knows about, so no "Invalid or expired MCP
 * session" the moment a request lands on a different worker.
 *
 * Authorization is resolved BEFORE the transport sees the body, so an
 * unauthenticated or unscoped caller never reaches a tool.
 */

const MCP_RATE_MAX = 120;
const MCP_RATE_WINDOW_MS = 60_000;

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  extra?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      ...(extra ?? {}),
    },
  });
}

export async function handleBrainMcpRequest(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse({ error: "Authorization required" }, 401, origin, {
      "WWW-Authenticate": `Bearer realm="Storage ByAFR Brain"`,
    });
  }

  // Rate limit on the key prefix, before any hashing work: a looping agent must
  // not be able to spend argon2 verifications without bound (§65).
  const prefix = token.slice(0, 12);
  const peek = await peekRateLimit(`brain:mcp:${prefix}`, MCP_RATE_MAX, MCP_RATE_WINDOW_MS);
  if (!peek.allowed) {
    return jsonResponse({ error: "Rate limit exceeded" }, 429, origin);
  }
  void checkRateLimit(`brain:mcp:${prefix}`, MCP_RATE_MAX, MCP_RATE_WINDOW_MS);

  let principal;
  try {
    principal = await resolveMcpPrincipal(token);
  } catch (error) {
    if (error instanceof BrainError) {
      return jsonResponse({ error: error.message, code: error.code }, error.status, origin);
    }
    if (error instanceof AuthError) {
      return jsonResponse({ error: error.message }, error.status, origin, {
        "WWW-Authenticate": `Bearer realm="Storage ByAFR Brain"`,
      });
    }
    console.error("brain mcp auth failed", error);
    return jsonResponse({ error: "Internal error" }, 500, origin);
  }

  if (principal.grants.length === 0) {
    return jsonResponse(
      {
        error:
          "This credential has no brain access. Grant the agent access to a brain in Settings.",
        code: "BRAIN_FORBIDDEN",
      },
      403,
      origin
    );
  }

  const server = createBrainMcpServer(principal);
  // sessionIdGenerator undefined = stateless: no session id is issued or required.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);

    const response = await transport.handleRequest(request, {
      authInfo: {
        token,
        clientId: principal.apiKeyId,
        scopes: principal.grants.flatMap((grant) => grant.scopes),
        extra: {
          userId: principal.userId,
          principalType: principal.type,
          agentId: principal.agentId,
        },
      },
    });

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      headers.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error("brain mcp request failed", error);
    return jsonResponse({ error: "Internal error" }, 500, origin);
  } finally {
    // enableJsonResponse means the body is fully buffered before we return, so
    // closing here cannot cut off a stream mid-flight.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
