import { describe, it, expect, beforeEach, vi } from "vitest";
import { MAX_REQUEST_BODY_BYTES } from "@/shared/api/read-body";

/**
 * Bounds on the two OAuth endpoints that need no credential at all.
 *
 * `POST /api/oauth/token` and `POST /api/oauth/register` both read their body with
 * an unbounded `request.json()` / `request.text()` through `parseOAuthBody`, so any
 * anonymous caller could turn one request into an arbitrarily large allocation in
 * the shared Node process. `register` additionally stored `client_name`,
 * `redirect_uris`, `grant_types` and `response_types` into jsonb columns with no
 * length, count or vocabulary check, had no rate limit, and echoed the internal
 * error message from its 500 branch.
 */

const store = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  rateAllowed: true,
  rateKeys: [] as string[],
  insertThrows: null as Error | null,
}));

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (store.insertThrows) throw store.insertThrows;
        store.inserted.push(values);
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  },
}));

vi.mock("@/shared/infrastructure/db/schema", async (importOriginal) => importOriginal());

vi.mock("@/shared/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/security")>();
  return {
    ...actual,
    checkRateLimit: vi.fn(async (key: string) => {
      store.rateKeys.push(key);
      return { allowed: store.rateAllowed, remaining: 0 };
    }),
  };
});

const { POST: register } = await import("@/app/api/oauth/register/route");
const { parseOAuthBody } = await import("@/shared/lib/auth/oauth/http");

function registerRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = {
  client_name: "Test Client",
  redirect_uris: ["https://example.com/callback"],
};

beforeEach(() => {
  store.inserted = [];
  store.rateAllowed = true;
  store.rateKeys = [];
  store.insertThrows = null;
  vi.clearAllMocks();
});

describe("parseOAuthBody — body ceiling", () => {
  it("parses a JSON body", async () => {
    const parsed = await parseOAuthBody(registerRequest({ grant_type: "refresh_token", n: 5 }));
    // Only string values survive, as before.
    expect(parsed).toEqual({ grant_type: "refresh_token" });
  });

  it("parses a form-encoded body", async () => {
    const parsed = await parseOAuthBody(
      new Request("http://localhost/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=abc",
      })
    );
    expect(parsed).toEqual({ grant_type: "authorization_code", code: "abc" });
  });

  it("refuses a body past the ceiling instead of buffering it", async () => {
    const huge = JSON.stringify({ code: "x".repeat(MAX_REQUEST_BODY_BYTES + 1024) });
    await expect(parseOAuthBody(registerRequest(huge))).rejects.toMatchObject({
      name: "BodyTooLargeError",
      maxBytes: MAX_REQUEST_BODY_BYTES,
    });
  });

  it("refuses on a declared length past the ceiling without reading the body", async () => {
    const request = new Request("http://localhost/api/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: "grant_type=refresh_token",
    });
    await expect(parseOAuthBody(request)).rejects.toMatchObject({ name: "BodyTooLargeError" });
    expect(request.bodyUsed).toBe(false);
  });

  it("treats an empty body as no fields rather than throwing", async () => {
    const request = new Request("http://localhost/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    await expect(parseOAuthBody(request)).resolves.toEqual({});
  });

  it("treats a JSON array or null as no fields", async () => {
    await expect(parseOAuthBody(registerRequest("[1,2,3]"))).resolves.toEqual({});
    await expect(parseOAuthBody(registerRequest("null"))).resolves.toEqual({});
  });
});

describe("POST /api/oauth/register — stored metadata", () => {
  it("registers a well-formed client", async () => {
    const response = await register(registerRequest(VALID));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.client_id).toBeTruthy();
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]).toMatchObject({
      clientName: "Test Client",
      redirectUris: ["https://example.com/callback"],
      tokenEndpointAuthMethod: "none",
    });
  });

  it("bounds the client name", async () => {
    const response = await register(registerRequest({ ...VALID, client_name: "n".repeat(201) }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client_metadata" });
    expect(store.inserted).toEqual([]);
  });

  it("bounds how many redirect URIs one client may register", async () => {
    const response = await register(
      registerRequest({
        redirect_uris: Array.from({ length: 11 }, (_, i) => `https://example.com/cb${i}`),
      })
    );
    expect(response.status).toBe(400);
    expect(store.inserted).toEqual([]);
  });

  it("bounds the length of a single redirect URI", async () => {
    const response = await register(
      registerRequest({ redirect_uris: [`https://example.com/${"a".repeat(2100)}`] })
    );
    expect(response.status).toBe(400);
    expect(store.inserted).toEqual([]);
  });

  it("refuses a grant type the token endpoint does not implement", async () => {
    const response = await register(registerRequest({ ...VALID, grant_types: ["password"] }));
    expect(response.status).toBe(400);
    expect(store.inserted).toEqual([]);
  });

  it("refuses an unknown response type and auth method", async () => {
    expect(
      (await register(registerRequest({ ...VALID, response_types: ["token"] }))).status
    ).toBe(400);
    expect(
      (await register(registerRequest({ ...VALID, token_endpoint_auth_method: "magic" }))).status
    ).toBe(400);
    expect(store.inserted).toEqual([]);
  });

  it("still requires at least one redirect URI", async () => {
    const response = await register(registerRequest({ client_name: "No URIs" }));
    expect(response.status).toBe(400);
    expect(store.inserted).toEqual([]);
  });

  it("still refuses a redirect URI the policy blocks", async () => {
    for (const uri of ["javascript:alert(1)", "http://evil.example.com/cb", "data:text/html,x"]) {
      const response = await register(registerRequest({ redirect_uris: [uri] }));
      expect(response.status, uri).toBe(400);
    }
    expect(store.inserted).toEqual([]);
  });

  it("refuses a non-array redirect_uris instead of storing it", async () => {
    const response = await register(
      registerRequest({ redirect_uris: "https://example.com/callback" })
    );
    expect(response.status).toBe(400);
    expect(store.inserted).toEqual([]);
  });
});

describe("POST /api/oauth/register — abuse ceilings", () => {
  it("rate-limits per IP", async () => {
    store.rateAllowed = false;
    const response = await register(registerRequest(VALID));

    expect(response.status).toBe(429);
    expect(store.inserted).toEqual([]);
    // The limit is keyed on the caller's IP, not global.
    expect(store.rateKeys[0]).toMatch(/^oauth-register:/);
  });

  it("counts the limit before parsing the body", async () => {
    store.rateAllowed = false;
    const response = await register(registerRequest("{ not json"));
    expect(response.status).toBe(429);
  });

  it("refuses an over-sized body with a 413", async () => {
    const response = await register(
      registerRequest(JSON.stringify({ client_name: "x".repeat(MAX_REQUEST_BODY_BYTES) }))
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    expect(store.inserted).toEqual([]);
  });

  it("answers 400, not 500, for a body that is not JSON", async () => {
    const response = await register(registerRequest("{ not json"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("never echoes the internal error message on a 500", async () => {
    store.insertThrows = new Error(
      'duplicate key value violates unique constraint "oauth_clients_client_id_key"'
    );
    const response = await register(registerRequest(VALID));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json).toEqual({ error: "server_error", error_description: "Registration failed" });
    expect(JSON.stringify(json)).not.toMatch(/constraint|oauth_clients/);
  });
});
