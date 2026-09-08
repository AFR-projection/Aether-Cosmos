import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  order: [] as string[],
  accessible: null as {
    canView: boolean;
    file: Record<string, unknown>;
  } | null,
  share: null as Record<string, unknown> | null,
  file: null as Record<string, unknown> | null,
  proxyForced: false,
  rateAllowed: true,
  signFails: false,
  bandwidthRefused: false,
  shareReservation: "reserved" as
    "reserved" | "share-unavailable" | "share-exhausted",
  bandwidthUsed: 0,
  shareCount: 0,
  telemetry: [] as Record<string, unknown>[],
}));

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => {
    state.order.push("auth");
    return { id: "viewer-1", role: "user" };
  }),
  getAccessibleFile: vi.fn(async () => {
    state.order.push("permission");
    return state.accessible;
  }),
}));

const storage = vi.hoisted(() => ({
  getPresignedPlaybackUrl: vi.fn(async () => {
    state.order.push("presign");
    if (state.signFails) throw new Error("signing unavailable");
    return {
      url: "https://private-r2.invalid/object?X-Amz-Signature=secret",
      expiresAt: new Date("2026-09-08T04:00:00.000Z"),
      expiresInSeconds: 7200,
    };
  }),
}));

const billing = vi.hoisted(() => {
  class BandwidthQuotaError extends Error {}
  return {
    BandwidthQuotaError,
    recordBandwidth: vi.fn(async (_userId: string, bytes: number) => {
      state.order.push("bandwidth");
      if (state.bandwidthRefused) throw new BandwidthQuotaError();
      state.bandwidthUsed += bytes;
    }),
  };
});

const access = vi.hoisted(() => ({
  reserveSharePlaybackAccess: vi.fn(
    async (_shareId: string, _ownerId: string, bytes: number) => {
      state.order.push("atomic-reservation");
      if (state.bandwidthRefused) throw new billing.BandwidthQuotaError();
      if (state.shareReservation === "reserved") {
        state.shareCount += 1;
        state.bandwidthUsed += bytes;
      }
      return state.shareReservation;
    },
  ),
}));

vi.mock("@/shared/lib/auth/session", () => ({
  requireAuth: auth.requireAuth,
}));
vi.mock("@/shared/lib/auth/permissions", () => ({
  getAccessibleFile: auth.getAccessibleFile,
}));
vi.mock("@files/infrastructure/storage/r2", () => storage);
vi.mock("@/shared/lib/billing/bandwidth", () => billing);
vi.mock("@shares/application/access", () => ({
  shareExpired: (share: { expiresAt?: Date | null }) =>
    !!share.expiresAt && share.expiresAt < new Date(),
  reserveSharePlaybackAccess: access.reserveSharePlaybackAccess,
}));
vi.mock("@/shared/lib/settings/admin-settings", () => ({
  playbackProxyForced: vi.fn(() => state.proxyForced),
  getAdminSettings: vi.fn(async () => ({
    playbackMode: state.proxyForced ? "legacy_proxy" : "direct_r2",
  })),
}));
vi.mock("@/shared/lib/security", () => ({
  checkRateLimit: vi.fn(async () => {
    state.order.push("rate-limit");
    return { allowed: state.rateAllowed, remaining: 10 };
  }),
}));
vi.mock("@/shared/lib/access-tracking", () => ({
  getClientIpFromRequest: () => "203.0.113.9",
}));
vi.mock("@/shared/lib/security/mime", () => ({
  getSafeMimeType: (mime: string) => mime,
}));
vi.mock("@/shared/lib/monitoring/playback-telemetry", () => ({
  recordPlaybackIssue: vi.fn((record: Record<string, unknown>) => {
    state.telemetry.push(record);
  }),
}));
vi.mock("@/shared/api/response", () => ({
  apiSuccess: (data: unknown, status = 200) =>
    Response.json({ success: true, data }, { status }),
  apiError: (message: string, status = 400, extra?: Record<string, unknown>) =>
    Response.json(
      { success: false, error: message, ...(extra ?? {}) },
      { status },
    ),
  apiRateLimited: (
    message: string,
    retryAfterSeconds: number,
    extra?: Record<string, unknown>,
  ) =>
    Response.json(
      {
        success: false,
        error: message,
        retryAfterSeconds,
        ...(extra ?? {}),
      },
      { status: 429 },
    ),
  handleApiError: () =>
    Response.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    ),
}));

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    select() {
      let table = "unknown";
      const chain = {
        from(value: Record<string, unknown>) {
          table = "token" in value ? "shares" : "files";
          return chain;
        },
        where: () => chain,
        async limit() {
          state.order.push(`query-${table}`);
          const row = table === "shares" ? state.share : state.file;
          return row ? [row] : [];
        },
      };
      return chain;
    },
  },
}));

const privateRoute = await import("@/app/api/files/[id]/playback-url/route");
const sharedRoute = await import("@/app/api/shared/[token]/playback-url/route");

const TOKEN = "sharetoken0000000000000000000000";

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "owner-1",
    name: "movie.mp4",
    mimeType: "video/mp4",
    sizeBytes: 4096,
    r2Key: "users/owner-1/movie.mp4",
    encrypted: false,
    isNote: false,
    status: "ready",
    deletedAt: null,
    restoreBatchId: null,
    version: 3,
    ...overrides,
  };
}

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    fileId: "11111111-1111-4111-8111-111111111111",
    token: TOKEN,
    accessCount: 0,
    maxAccessCount: 2,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.order = [];
  state.accessible = { canView: true, file: file() };
  state.share = share();
  state.file = file();
  state.proxyForced = false;
  state.rateAllowed = true;
  state.signFails = false;
  state.bandwidthRefused = false;
  state.shareReservation = "reserved";
  state.bandwidthUsed = 0;
  state.shareCount = 0;
  state.telemetry = [];
  vi.clearAllMocks();
});

async function privateGet() {
  return privateRoute.GET(new Request("http://localhost"), {
    params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
  });
}

async function sharedGet(token = TOKEN) {
  return sharedRoute.GET(
    new NextRequest(`http://localhost/api/shared/${token}/playback-url`),
    { params: Promise.resolve({ token }) },
  );
}

function expectNoCapabilityLeak(responseBody: string) {
  expect(responseBody).not.toContain("X-Amz-Signature");
  expect(JSON.stringify(state.telemetry)).not.toMatch(
    /private-r2|X-Amz-Signature|sharetoken|cookie/i,
  );
}

// CAP-ORDER-P: moving bandwidth before signing reintroduces an irreversible charge
// when R2 signing fails.
describe("authenticated playback capability", () => {
  it("presigns first, then commits bandwidth, then returns bounded metadata", async () => {
    const response = await privateGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(state.order).toEqual(["auth", "permission", "presign", "bandwidth"]);
    expect(state.bandwidthUsed).toBe(4096);
    expect(Object.keys(body.data).sort()).toEqual(
      [
        "expiresAt",
        "expiresInSeconds",
        "mimeType",
        "sizeBytes",
        "url",
        "version",
      ].sort(),
    );
  });

  it("changes no counter when signing fails", async () => {
    state.signFails = true;

    const response = await privateGet();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(state.order).toEqual(["auth", "permission", "presign"]);
    expect(state.bandwidthUsed).toBe(0);
    expectNoCapabilityLeak(text);
  });

  it("never returns the already-created URL when quota refuses the reservation", async () => {
    state.bandwidthRefused = true;

    const response = await privateGet();
    const text = await response.text();

    expect(response.status).toBe(429);
    expect(state.order).toEqual(["auth", "permission", "presign", "bandwidth"]);
    expect(state.bandwidthUsed).toBe(0);
    expectNoCapabilityLeak(text);
  });

  it("honours rollback before file lookup, signing, or accounting", async () => {
    state.proxyForced = true;

    const response = await privateGet();

    expect(response.status).toBe(409);
    expect(state.order).toEqual(["auth"]);
    expect(storage.getPresignedPlaybackUrl).not.toHaveBeenCalled();
    expect(billing.recordBandwidth).not.toHaveBeenCalled();
  });

  it("refuses unauthorized access before signing or accounting", async () => {
    state.accessible = null;

    const response = await privateGet();

    expect(response.status).toBe(404);
    expect(state.order).toEqual(["auth", "permission"]);
    expect(storage.getPresignedPlaybackUrl).not.toHaveBeenCalled();
    expect(billing.recordBandwidth).not.toHaveBeenCalled();
  });
});

// CAP-ORDER-S: share access and owner bandwidth are one reservation after presigning;
// neither counter may move alone.
describe("shared playback capability", () => {
  it("presigns before atomically reserving share access and owner bandwidth", async () => {
    const response = await sharedGet();

    expect(response.status).toBe(200);
    expect(state.order).toEqual([
      "rate-limit",
      "query-shares",
      "query-files",
      "presign",
      "atomic-reservation",
    ]);
    expect(state.shareCount).toBe(1);
    expect(state.bandwidthUsed).toBe(4096);
    expect(billing.recordBandwidth).not.toHaveBeenCalled();
  });

  it("changes neither counter when signing fails", async () => {
    state.signFails = true;

    const response = await sharedGet();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(state.order).not.toContain("atomic-reservation");
    expect(state.shareCount).toBe(0);
    expect(state.bandwidthUsed).toBe(0);
    expectNoCapabilityLeak(text);
  });

  it("does not consume share access when owner quota refuses", async () => {
    state.bandwidthRefused = true;

    const response = await sharedGet();
    const text = await response.text();

    expect(response.status).toBe(429);
    expect(state.shareCount).toBe(0);
    expect(state.bandwidthUsed).toBe(0);
    expectNoCapabilityLeak(text);
  });

  it("does not consume owner bandwidth when the share is exhausted", async () => {
    state.shareReservation = "share-exhausted";

    const response = await sharedGet();

    expect(response.status).toBe(403);
    expect(state.shareCount).toBe(0);
    expect(state.bandwidthUsed).toBe(0);
  });

  it("rejects an implausible token before rate limiting, queries, or signing", async () => {
    const response = await sharedGet("../../etc/passwd");

    expect(response.status).toBe(404);
    expect(state.order).toEqual([]);
    expect(access.reserveSharePlaybackAccess).not.toHaveBeenCalled();
    expect(storage.getPresignedPlaybackUrl).not.toHaveBeenCalled();
  });

  it("rate-limits before querying or issuing a capability", async () => {
    state.rateAllowed = false;

    const response = await sharedGet();

    expect(response.status).toBe(429);
    expect(state.order).toEqual(["rate-limit"]);
    expect(access.reserveSharePlaybackAccess).not.toHaveBeenCalled();
    expect(storage.getPresignedPlaybackUrl).not.toHaveBeenCalled();
  });

  it("refuses expired and ineligible shares before signing or reserving", async () => {
    state.share = share({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await sharedGet();
    expect(expired.status).toBe(410);

    state.order = [];
    state.share = share();
    state.file = file({ encrypted: true });
    const encrypted = await sharedGet();
    expect(encrypted.status).toBe(409);

    expect(storage.getPresignedPlaybackUrl).not.toHaveBeenCalled();
    expect(access.reserveSharePlaybackAccess).not.toHaveBeenCalled();
  });
});
