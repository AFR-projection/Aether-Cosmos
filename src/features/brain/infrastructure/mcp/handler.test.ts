import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthError } from "@/shared/lib/auth/session";
import { BrainForbiddenError } from "@brain/domain/errors";
import type { McpPrincipal } from "./principal";

/**
 * The HTTP boundary in front of the MCP server. Nothing here is about what a tool
 * does — it is about what never reaches one: a request with no credential, a
 * credential over its rate limit, a credential that resolves to zero brain grants.
 *
 * Three orderings are load-bearing and each is asserted rather than assumed:
 * the token is required before the rate limiter runs, the rate limiter runs before
 * the (argon2) key verification, and the principal is resolved before the transport
 * ever sees the body. The last one is what makes "MCP never bypasses Brain
 * authorization" true at the door instead of per tool.
 */

const peekRateLimit = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/shared/lib/security", () => ({
  peekRateLimit: (...args: unknown[]) => peekRateLimit(...args),
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));

const resolveMcpPrincipal = vi.fn();

vi.mock("./principal", () => ({
  resolveMcpPrincipal: (...args: unknown[]) => resolveMcpPrincipal(...args),
}));

type ServerStub = { connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
type TransportStub = {
  options: unknown;
  handleRequest: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const servers: ServerStub[] = [];
const transports: TransportStub[] = [];
/** What the transport returns; a test may replace it to simulate a tool failure. */
let transportResponse: () => Promise<Response> = async () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-From-Transport": "yes" },
  });
/** Set by the teardown test: closing an already-closed transport must not 500. */
let closeFails = false;

vi.mock("./server", () => ({
  createBrainMcpServer: vi.fn(() => {
    const server: ServerStub = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    servers.push(server);
    return server;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    constructor(options: unknown) {
      const transport: TransportStub = {
        options,
        handleRequest: vi.fn(() => transportResponse()),
        close: vi.fn(async () => {
          if (closeFails) throw new Error("already closed");
        }),
      };
      transports.push(transport);
      Object.assign(this, transport);
    }
  },
}));

const { handleBrainMcpRequest } = await import("./handler");
const { createBrainMcpServer } = await import("./server");

const TOKEN = "sk_abcdefghijklmnopqrstuvwxyz0123456789";
const PREFIX = TOKEN.slice(0, 12);

function principal(overrides: Partial<McpPrincipal> = {}): McpPrincipal {
  return {
    type: "agent",
    id: "agent-1",
    userId: "user-1",
    agentId: "agent-1",
    agentName: "OpenClaw",
    apiKeyId: "key-1",
    grants: [
      {
        brainId: "aaaaaaaa-1111-4111-8111-111111111111",
        brainName: "Personal Brain",
        isDefault: true,
        scopes: ["brain.read", "brain.search"],
      },
    ],
    ...overrides,
  };
}

function post(headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Request {
  return new Request("https://example.test/api/brain/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  servers.length = 0;
  transports.length = 0;
  closeFails = false;
  transportResponse = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-From-Transport": "yes" },
    });
  peekRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  resolveMcpPrincipal.mockResolvedValue(principal());
});

describe("the door", () => {
  it("answers a preflight without authentication", async () => {
    const response = await handleBrainMcpRequest(
      new Request("https://example.test/api/brain/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai" },
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(peekRateLimit).not.toHaveBeenCalled();
    expect(resolveMcpPrincipal).not.toHaveBeenCalled();
  });

  it("does not echo an origin that was not sent", async () => {
    // A blanket `*` on a credentialed endpoint is how a browser page starts making
    // authenticated MCP calls on someone's behalf.
    const response = await handleBrainMcpRequest(
      new Request("https://example.test/api/brain/mcp", { method: "OPTIONS" })
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows only GET, POST and DELETE", async () => {
    const response = await handleBrainMcpRequest(
      new Request("https://example.test/api/brain/mcp", { method: "PUT" })
    );

    expect(response.status).toBe(405);
    expect(resolveMcpPrincipal).not.toHaveBeenCalled();
  });

  it("requires a bearer token, and says how to present one", async () => {
    const response = await handleBrainMcpRequest(post({}));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    // No token means no rate-limit bucket to charge and nothing to verify.
    expect(peekRateLimit).not.toHaveBeenCalled();
    expect(resolveMcpPrincipal).not.toHaveBeenCalled();
  });

  it("ignores a non-bearer Authorization header", async () => {
    const response = await handleBrainMcpRequest(post({ authorization: `Basic ${TOKEN}` }));

    expect(response.status).toBe(401);
    expect(resolveMcpPrincipal).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("charges the limiter before verifying the key", async () => {
    // Key verification is argon2. If it ran first, a looping agent could spend the
    // CPU of the whole box on requests that were going to be rejected anyway.
    peekRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const response = await handleBrainMcpRequest(post());

    expect(response.status).toBe(429);
    expect(resolveMcpPrincipal).not.toHaveBeenCalled();
    expect(servers).toHaveLength(0);
  });

  it("buckets on the key prefix, never on the secret itself", async () => {
    await handleBrainMcpRequest(post());

    const key = peekRateLimit.mock.calls[0][0] as string;
    expect(key).toBe(`brain:mcp:${PREFIX}`);
    expect(key).not.toContain(TOKEN);
    // Peek decides, then the counter is advanced for the request that got through.
    expect(checkRateLimit).toHaveBeenCalledWith(`brain:mcp:${PREFIX}`, 120, 60_000);
  });
});

describe("authorization failures never reach a tool", () => {
  it("passes a BrainError's status and code through unchanged", async () => {
    resolveMcpPrincipal.mockRejectedValue(new BrainForbiddenError("This agent has been revoked"));

    const response = await handleBrainMcpRequest(post());
    const body = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "This agent has been revoked", code: "BRAIN_FORBIDDEN" });
    expect(servers).toHaveLength(0);
  });

  it("answers an AuthError with a challenge, so a client knows to re-authenticate", async () => {
    resolveMcpPrincipal.mockRejectedValue(new AuthError("Unauthorized"));

    const response = await handleBrainMcpRequest(post());

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(servers).toHaveLength(0);
  });

  it("does not leak an unexpected failure to the caller", async () => {
    // A driver error can carry a connection string or a query fragment.
    resolveMcpPrincipal.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://brain:hunter2@db:5432")
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleBrainMcpRequest(post());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe(JSON.stringify({ error: "Internal error" }));
    expect(text).not.toContain("hunter2");
    consoleError.mockRestore();
  });

  it("refuses a credential with no brain grant, and builds no server for it", async () => {
    // A valid key is not access. Without a grant there is no brain to scope a tool
    // to, and an empty grant list must never be read as "all brains".
    resolveMcpPrincipal.mockResolvedValue(principal({ grants: [] }));

    const response = await handleBrainMcpRequest(post());
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe("BRAIN_FORBIDDEN");
    expect(createBrainMcpServer).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
  });
});

describe("an authorized request", () => {
  it("builds the server for the resolved principal, not for the token", async () => {
    const caller = principal();
    resolveMcpPrincipal.mockResolvedValue(caller);

    await handleBrainMcpRequest(post());

    expect(createBrainMcpServer).toHaveBeenCalledWith(caller);
    expect(servers[0].connect).toHaveBeenCalledTimes(1);
  });

  it("hands the transport an authInfo built from the grants, not from the request", async () => {
    resolveMcpPrincipal.mockResolvedValue(
      principal({
        grants: [
          {
            brainId: "aaaaaaaa-1111-4111-8111-111111111111",
            brainName: "Personal",
            isDefault: true,
            scopes: ["brain.read"],
          },
          {
            brainId: "bbbbbbbb-2222-4222-8222-222222222222",
            brainName: "Work",
            isDefault: false,
            scopes: ["brain.write"],
          },
        ],
      })
    );

    await handleBrainMcpRequest(post());

    const [, options] = transports[0].handleRequest.mock.calls[0] as [
      Request,
      { authInfo: { token: string; clientId: string; scopes: string[]; extra: Record<string, unknown> } },
    ];
    expect(options.authInfo.token).toBe(TOKEN);
    expect(options.authInfo.clientId).toBe("key-1");
    expect(options.authInfo.scopes).toEqual(["brain.read", "brain.write"]);
    expect(options.authInfo.extra).toEqual({
      userId: "user-1",
      principalType: "agent",
      agentId: "agent-1",
    });
  });

  it("runs stateless: no session id is issued, and every request gets its own pair", async () => {
    // Two app processes behind nginx cannot share a session map, so there must not
    // be one. `sessionIdGenerator: undefined` is what the SDK reads as stateless.
    await handleBrainMcpRequest(post());
    await handleBrainMcpRequest(post());

    expect(transports).toHaveLength(2);
    expect(servers).toHaveLength(2);
    expect(transports[0]).not.toBe(transports[1]);
    expect(transports[0].options).toEqual({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
  });

  it("returns the transport's response, with CORS added and its own headers kept", async () => {
    const response = await handleBrainMcpRequest(
      post({ authorization: `Bearer ${TOKEN}`, origin: "https://claude.ai" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-From-Transport")).toBe("yes");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("passes a transport error off as a 500 and still tears everything down", async () => {
    transportResponse = async () => {
      throw new Error("tool exploded");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleBrainMcpRequest(post());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe(JSON.stringify({ error: "Internal error" }));
    expect(transports[0].close).toHaveBeenCalledTimes(1);
    expect(servers[0].close).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("closes the transport and the server on the happy path too", async () => {
    // Stateless means nothing may be left holding a connection between requests.
    await handleBrainMcpRequest(post());

    expect(transports[0].close).toHaveBeenCalledTimes(1);
    expect(servers[0].close).toHaveBeenCalledTimes(1);
  });

  it("survives a teardown that itself fails", async () => {
    // The response is already buffered by then; a close error must not turn a
    // successful tool call into a 500.
    closeFails = true;

    const response = await handleBrainMcpRequest(post());

    expect(response.status).toBe(200);
    expect(transports[0].close).toHaveBeenCalledTimes(1);
  });
});
