import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `POST /api/oauth/approve` — the consent step. It is what turns "the user clicked
 * Allow" into a stored authorization code, so whatever it writes is what the token
 * endpoint will later be asked to honour.
 *
 * Every field used to be read as `String(body.x ?? "")` straight off an unparsed
 * body, which produced four separate defects:
 *
 *  - a JSON `null` (or a string, or a number) body threw a TypeError on the
 *    property read and answered 500;
 *  - an object or array argument became the literal `"[object Object]"` and was
 *    stored as if it were a client id or a challenge;
 *  - `state`, `scope` and `code_challenge` were unbounded, so an authenticated
 *    caller chose the size of a row in `oauth_authorization_codes`;
 *  - `code_challenge_method` was stored verbatim while `verifyPkce` only ever
 *    accepts `S256`. A client sending `plain` — the other method RFC 7636 defines,
 *    and the one `/api/oauth/authorize` already refuses — was handed a code that
 *    could never be exchanged, surfacing much later as an opaque `invalid_grant`.
 *
 * The scope clamp is the security boundary that was already here and must stay:
 * the role, not the request, decides whether `admin:*` can be granted.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  csrfOk: true,
  /** null makes `requireAuth` throw, as it does for a signed-out caller. */
  session: null as Row | null,
  clientResult: { ok: true } as Row,
  /** Every `createAuthorizationCode` input, in order. */
  issued: [] as Row[],
  authCalls: 0,
}));

vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  validateCsrf: vi.fn(async () => store.csrfOk),
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    requireAuth: vi.fn(async () => {
      store.authCalls++;
      if (!store.session) throw new actual.AuthError("Unauthorized", 401);
      return store.session;
    }),
  };
});

vi.mock("@/lib/oauth/clients", () => ({
  validateOAuthClientRedirect: vi.fn(async () => store.clientResult),
}));

vi.mock("@/lib/oauth/codes", () => ({
  createAuthorizationCode: vi.fn(async (input: Row) => {
    store.issued.push(input);
    return "oac_test_code";
  }),
}));

const { POST } = await import("@/app/api/oauth/approve/route");

const REDIRECT = "https://client.example/callback";
/** base64url of a SHA-256 digest — 43 characters. */
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function post(body: unknown, init?: { raw?: string }) {
  return new NextRequest("https://app.example/api/oauth/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init?.raw ?? JSON.stringify(body),
  });
}

function validBody(over: Row = {}) {
  return {
    client_id: "client-123",
    redirect_uri: REDIRECT,
    scope: "read upload",
    state: "opaque-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...over,
  };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  store.csrfOk = true;
  store.session = { id: "user-1", role: "user" };
  store.clientResult = { ok: true };
  store.issued = [];
  store.authCalls = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/oauth/approve — gates", () => {
  it("issues a code and redirects back with it", async () => {
    const response = await POST(post(validBody()));
    expect(response.status).toBe(200);
    const body = await json(response);
    const redirect = new URL(String((body.data as Row).redirect_to));
    expect(redirect.searchParams.get("code")).toBe("oac_test_code");
    expect(redirect.searchParams.get("state")).toBe("opaque-state");
    expect(store.issued).toHaveLength(1);
  });

  it("refuses without a valid CSRF token, before touching the session", async () => {
    store.csrfOk = false;
    const response = await POST(post(validBody()));
    expect(response.status).toBe(403);
    expect(store.authCalls).toBe(0);
    expect(store.issued).toEqual([]);
  });

  it("refuses a signed-out caller", async () => {
    store.session = null;
    const response = await POST(post(validBody()));
    expect(response.status).toBe(401);
    expect(store.issued).toEqual([]);
  });

  it("refuses a redirect_uri the client has not registered", async () => {
    store.clientResult = { ok: false, error: "invalid_redirect_uri" };
    const response = await POST(post(validBody()));
    expect(response.status).toBe(400);
    expect(String((await json(response)).error)).toMatch(/redirect uri/i);
    expect(store.issued).toEqual([]);
  });

  it("refuses an unknown client", async () => {
    store.clientResult = { ok: false, error: "invalid_client" };
    const response = await POST(post(validBody()));
    expect(response.status).toBe(400);
    expect(String((await json(response)).error)).toMatch(/invalid oauth client/i);
  });

  it("omits `state` from the redirect when the caller sent none", async () => {
    const response = await POST(post(validBody({ state: undefined })));
    const redirect = new URL(String(((await json(response)).data as Row).redirect_to));
    expect(redirect.searchParams.has("state")).toBe(false);
  });
});

describe("POST /api/oauth/approve — the body is parsed, not coerced", () => {
  it("answers 400 for a JSON null body instead of throwing", async () => {
    const response = await POST(post(null, { raw: "null" }));
    expect(response.status).toBe(400);
    expect(store.issued).toEqual([]);
  });

  it("answers 400 for a body that is not an object", async () => {
    for (const raw of ['"just a string"', "42", "[]", "true"]) {
      const response = await POST(post(undefined, { raw }));
      expect(response.status, raw).toBe(400);
    }
    expect(store.issued).toEqual([]);
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    const response = await POST(post(undefined, { raw: "{ not json" }));
    expect(response.status).toBe(400);
    expect((await json(response)).code).toBe("INVALID_JSON");
  });

  it("no longer stringifies an object into a field", async () => {
    const response = await POST(post(validBody({ client_id: { evil: true } })));
    expect(response.status).toBe(400);
    expect(store.issued).toEqual([]);
  });

  it("refuses a missing client_id or redirect_uri", async () => {
    expect((await POST(post(validBody({ client_id: undefined })))).status).toBe(400);
    expect((await POST(post(validBody({ redirect_uri: undefined })))).status).toBe(400);
    expect((await POST(post(validBody({ client_id: "   " })))).status).toBe(400);
    expect(store.issued).toEqual([]);
  });

  it("bounds every field a caller controls", async () => {
    const cases: Row[] = [
      { client_id: "c".repeat(201) },
      { redirect_uri: `https://client.example/${"p".repeat(2048)}` },
      { scope: "read ".repeat(200) },
      { state: "s".repeat(1025) },
      { code_challenge: "A".repeat(129) },
    ];
    for (const over of cases) {
      const response = await POST(post(validBody(over)));
      expect(response.status, JSON.stringify(Object.keys(over))).toBe(400);
    }
    expect(store.issued).toEqual([]);
  });

  it("accepts a state right at the ceiling", async () => {
    const response = await POST(post(validBody({ state: "s".repeat(1024) })));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/oauth/approve — PKCE", () => {
  it("refuses `plain`, the method this server cannot verify", async () => {
    const response = await POST(post(validBody({ code_challenge_method: "plain" })));
    expect(response.status).toBe(400);
    expect(store.issued).toEqual([]);
  });

  it("refuses any other method name", async () => {
    for (const method of ["S512", "s256", "none", "", "S256 "]) {
      const response = await POST(post(validBody({ code_challenge_method: method })));
      expect(response.status, JSON.stringify(method)).toBe(400);
    }
    expect(store.issued).toEqual([]);
  });

  it("defaults to S256 when the method is omitted", async () => {
    const response = await POST(post(validBody({ code_challenge_method: undefined })));
    expect(response.status).toBe(200);
    expect(store.issued[0].codeChallengeMethod).toBe("S256");
  });

  it("requires a challenge of the right shape", async () => {
    for (const challenge of [
      undefined,
      "",
      "too-short",
      "A".repeat(42),
      `${CHALLENGE.slice(0, 42)}+`, // '+' is base64, not base64url
      `${CHALLENGE.slice(0, 42)}/`,
      `${CHALLENGE.slice(0, 42)}=`,
    ]) {
      const response = await POST(post(validBody({ code_challenge: challenge })));
      expect(response.status, JSON.stringify(challenge)).toBe(400);
    }
    expect(store.issued).toEqual([]);
  });

  it("stores the challenge it was given, unchanged", async () => {
    await POST(post(validBody()));
    expect(store.issued[0].codeChallenge).toBe(CHALLENGE);
  });

  it("never issues a code without a challenge — PKCE is not optional here", async () => {
    const body: Row = { ...validBody() };
    Reflect.deleteProperty(body, "code_challenge");
    expect((await POST(post(body))).status).toBe(400);
    expect(store.issued).toEqual([]);
  });
});

describe("POST /api/oauth/approve — the scope clamp still holds", () => {
  it("keeps the storage scopes a normal user asked for", async () => {
    await POST(post(validBody({ scope: "read upload download" })));
    expect(store.issued[0].scopes).toEqual(["read", "upload", "download"]);
  });

  it("strips admin scopes from a non-master consent", async () => {
    await POST(post(validBody({ scope: "read admin:users supreme upload" })));
    expect(store.issued[0].scopes).toEqual(["read", "upload"]);
  });

  it("grants admin scopes only to a master account", async () => {
    store.session = { id: "user-master", role: "master" };
    await POST(post(validBody({ scope: "admin:users supreme" })));
    expect(store.issued[0].scopes).toEqual(["read", "admin:users", "supreme"]);
  });

  it("falls back to `read` for a scope string of unknown names", async () => {
    await POST(post(validBody({ scope: "wingardium leviosa" })));
    expect(store.issued[0].scopes).toEqual(["read"]);
  });

  it("binds the code to the session user, never to a body field", async () => {
    await POST(post({ ...validBody(), userId: "user-2", user_id: "user-2" }));
    expect(store.issued[0].userId).toBe("user-1");
  });

  it("stores the redirect_uri that was validated", async () => {
    await POST(post(validBody()));
    expect(store.issued[0].redirectUri).toBe(REDIRECT);
    expect(store.issued[0].clientId).toBe("client-123");
  });
});
