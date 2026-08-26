import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

/**
 * Single-use semantics for OAuth authorization codes and refresh tokens.
 *
 * Both were SELECT-then-UPDATE: read the row while it was still unused, then
 * mark it used in a second statement. Two token requests racing on the same
 * stolen code (or refresh token) therefore both passed the check and both got a
 * live access token — RFC 6749 §10.4 / RFC 6819 §4.4.1.
 *
 * The fake `db` below models a Postgres conditional UPDATE honestly: the
 * `usedAt IS NULL` / `revokedAt IS NULL` predicate is evaluated at WRITE time
 * against shared state, and the writer that loses gets zero rows back. That is
 * what makes these tests fail against the old select-then-update shape — two
 * SELECTs would both observe an unclaimed row and both callers would proceed.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  /** Rows the conditional UPDATE may claim. */
  rows: [] as Row[],
  /** Column the UPDATE's `IS NULL` predicate is on. */
  claimColumn: "usedAt",
  /** Rows written by INSERT (issued tokens). */
  inserted: [] as Row[],
  /** SELECT count — a claim must not need a preceding read. */
  selects: 0,
}));

vi.mock("@/lib/db", () => {
  function selectChain() {
    const api = {
      from: () => api,
      where: () => api,
      orderBy: () => api,
      leftJoin: () => api,
      limit: async () => {
        store.selects++;
        return [];
      },
    };
    return api;
  }

  return {
    db: {
      select: () => selectChain(),
      insert: () => ({
        values: async (values: Row) => {
          store.inserted.push(values);
        },
      }),
      update: () => {
        const api = {
          set: () => api,
          where: () => api,
          // Claim-at-write-time: whoever runs first takes the row.
          returning: async () => {
            const target = store.rows.find((row) => row[store.claimColumn] === null);
            if (!target) return [];
            target[store.claimColumn] = new Date();
            return [target];
          },
        };
        return api;
      },
    },
  };
});

const { consumeAuthorizationCode } = await import("@/lib/oauth/codes");
const { refreshAccessToken } = await import("@/lib/oauth/tokens");

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function reset(claimColumn: string) {
  store.rows = [];
  store.inserted = [];
  store.selects = 0;
  store.claimColumn = claimColumn;
}

describe("consumeAuthorizationCode", () => {
  const verifier = randomBytes(32).toString("base64url");
  const input = {
    code: "oac_test",
    clientId: "client-1",
    redirectUri: "https://app.example.com/cb",
    codeVerifier: verifier,
  };

  beforeEach(() => {
    reset("usedAt");
    store.rows.push({
      id: "code-1",
      codeHash: "irrelevant — the predicate lives in the mocked WHERE",
      clientId: input.clientId,
      userId: "user-1",
      redirectUri: input.redirectUri,
      scope: "read",
      codeChallenge: s256(verifier),
      codeChallengeMethod: "S256",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it("redeems a valid code once", async () => {
    const row = await consumeAuthorizationCode(input);
    expect(row?.id).toBe("code-1");
    expect(store.rows[0].usedAt).toBeInstanceOf(Date);
  });

  it("returns null on a second, sequential redemption", async () => {
    expect(await consumeAuthorizationCode(input)).not.toBeNull();
    expect(await consumeAuthorizationCode(input)).toBeNull();
  });

  it("lets only ONE of two concurrent redemptions win", async () => {
    const results = await Promise.all([
      consumeAuthorizationCode(input),
      consumeAuthorizationCode(input),
      consumeAuthorizationCode(input),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("claims the row without a preceding SELECT", async () => {
    await consumeAuthorizationCode(input);
    expect(store.selects).toBe(0);
  });

  it("burns the code even when PKCE fails, and reports failure", async () => {
    const row = await consumeAuthorizationCode({ ...input, codeVerifier: "wrong-verifier" });
    expect(row).toBeNull();
    // Invalidated, not left available for another attempt (RFC 6819 §4.4.1).
    expect(store.rows[0].usedAt).toBeInstanceOf(Date);
    expect(await consumeAuthorizationCode(input)).toBeNull();
  });
});

describe("refreshAccessToken", () => {
  const input = { refreshToken: "ort_test", clientId: "client-1" };

  beforeEach(() => {
    reset("revokedAt");
    store.rows.push({
      id: "token-1",
      tokenHash: "hash",
      refreshTokenHash: "hash",
      clientId: input.clientId,
      userId: "user-1",
      scope: "read write",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 600_000),
    });
  });

  it("rotates once and carries the original scope forward", async () => {
    const issued = await refreshAccessToken(input);
    expect(issued?.access_token).toMatch(/^oat_/);
    expect(issued?.refresh_token).toMatch(/^ort_/);
    expect(issued?.scope).toBe("read write");
    expect(store.rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it("refuses to rotate the same refresh token twice", async () => {
    expect(await refreshAccessToken(input)).not.toBeNull();
    expect(await refreshAccessToken(input)).toBeNull();
  });

  it("lets only ONE of two concurrent rotations win", async () => {
    const results = await Promise.all([
      refreshAccessToken(input),
      refreshAccessToken(input),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    // Exactly one new token row was written — no duplicate live grant.
    expect(store.inserted).toHaveLength(1);
  });

  it("revokes the old row without a preceding SELECT", async () => {
    await refreshAccessToken(input);
    expect(store.selects).toBe(0);
  });
});
