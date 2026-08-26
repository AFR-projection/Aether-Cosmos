import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Finalising an upload belongs to the uploader alone.
 *
 * `/upload/presign` creates the pending row for one specific caller, so `complete` and
 * `complete-batch` test ownership by equality — deliberately NOT through the master
 * override. A master (or an impersonating admin session) completing somebody else's
 * half-finished upload would flip a row to `ready` and rewrite that account's storage
 * accounting from outside. These tests pin the 404 and that no UPDATE happens.
 */

const dbCalls = vi.hoisted(() => ({ updates: 0, deletes: 0 }));
const selectQueue = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock("@/lib/db", () => {
  type Q = {
    set: (...a: unknown[]) => Q;
    where: (...a: unknown[]) => Q;
    from: (...a: unknown[]) => Q;
    limit: (...a: unknown[]) => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) => Promise<unknown>;
  };

  function q(result: () => unknown[]): Q {
    const api: Q = {
      set: () => api,
      where: () => api,
      from: () => api,
      limit: async () => result(),
      then: (r, j) => Promise.resolve(result()).then(r, j),
    };
    return api;
  }

  return {
    db: {
      select: () => q(() => selectQueue.rows.shift() ?? []),
      update: () => {
        dbCalls.updates++;
        return q(() => []);
      },
      delete: () => {
        dbCalls.deletes++;
        return q(() => []);
      },
    },
    recalculateUsedBytes: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, validateCsrf: vi.fn(), checkUserApiRateLimit: vi.fn() };
});

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAuth: vi.fn(), getClientIp: vi.fn(() => "127.0.0.1") };
});

vi.mock("@/lib/auth/api-key", () => ({
  requireAuthOrApiKey: vi.fn(),
  requireMasterOrApiKey: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/storage/r2", () => ({
  objectExists: vi.fn().mockResolvedValue(true),
  downloadFromR2Bytes: vi.fn().mockResolvedValue(new Uint8Array(16)),
  completeMultipartUpload: vi.fn().mockResolvedValue(undefined),
  abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/security/file-validation", () => ({
  validateFileMagicBytes: vi.fn(() => ({ valid: true })),
}));
vi.mock("@/lib/security/suspicious-activity", () => ({
  checkSuspiciousActivity: vi.fn().mockResolvedValue({ suspicious: false }),
  logSuspiciousActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/queue", () => ({ enqueueJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/webhooks/dispatch", () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/realtime/events", () => ({ publishToUser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/admin-settings", () => ({
  getAdminSettings: vi.fn().mockResolvedValue({ rateLimitPerMinute: 1000 }),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const MASTER = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID_2 = "55555555-5555-4555-8555-555555555555";

const { validateCsrf, checkUserApiRateLimit } = await import("@/lib/security");
const { requireAuthOrApiKey } = await import("@/lib/auth/api-key");
const completeRoute = await import("@/app/api/upload/complete/route");
const completeBatchRoute = await import("@/app/api/upload/complete-batch/route");

/** A pending row created by `/upload/presign` for OWNER. */
function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    userId: OWNER,
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: 100,
    r2Key: "u/owner/photo.png",
    encrypted: false,
    status: "pending",
    deletedAt: null,
    ...over,
  };
}

function req(body: unknown, path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Signs in as a MASTER account that does not own the pending row. */
function asMaster() {
  vi.mocked(requireAuthOrApiKey).mockResolvedValue({
    id: MASTER,
    effectiveUserId: MASTER,
    role: "master",
    isImpersonating: false,
    sessionId: "s",
  } as never);
}

beforeEach(() => {
  dbCalls.updates = 0;
  dbCalls.deletes = 0;
  selectQueue.rows = [];
  vi.mocked(validateCsrf).mockReset().mockResolvedValue(true);
  vi.mocked(checkUserApiRateLimit).mockReset().mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireAuthOrApiKey)
    .mockReset()
    .mockResolvedValue({
      id: OWNER,
      effectiveUserId: OWNER,
      role: "user",
      isImpersonating: false,
      sessionId: "s",
    } as never);
});

describe("POST /api/upload/complete", () => {
  it("404s a master finalising someone else's pending row, and updates nothing", async () => {
    asMaster();
    selectQueue.rows = [[pendingRow()]];
    const res = await completeRoute.POST(req({ fileId: FILE_ID }, "/api/upload/complete"));
    expect(res.status).toBe(404);
    expect(dbCalls.updates).toBe(0);
  });

  it("lets the uploader finalise their own row", async () => {
    selectQueue.rows = [[pendingRow()]];
    const res = await completeRoute.POST(req({ fileId: FILE_ID }, "/api/upload/complete"));
    expect(res.status).toBe(200);
    expect(dbCalls.updates).toBe(1);
  });

  it("requires CSRF", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await completeRoute.POST(req({ fileId: FILE_ID }, "/api/upload/complete"));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });
});

describe("POST /api/upload/complete-batch", () => {
  it("404s the whole batch when one row belongs to another account", async () => {
    // The first row is the caller's, the second is not: a partial finalise would leave the
    // batch half-committed.
    selectQueue.rows = [[pendingRow(), pendingRow({ id: FILE_ID_2, userId: MASTER })]];
    const res = await completeBatchRoute.POST(
      req({ files: [{ fileId: FILE_ID }, { fileId: FILE_ID_2 }] }, "/api/upload/complete-batch")
    );
    expect(res.status).toBe(404);
    expect(dbCalls.updates).toBe(0);
  });

  it("404s when a requested row does not exist at all", async () => {
    selectQueue.rows = [[]];
    const res = await completeBatchRoute.POST(
      req({ files: [{ fileId: FILE_ID }] }, "/api/upload/complete-batch")
    );
    expect(res.status).toBe(404);
    expect(dbCalls.updates).toBe(0);
  });

  it("requires CSRF before touching anything", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await completeBatchRoute.POST(
      req({ files: [{ fileId: FILE_ID }] }, "/api/upload/complete-batch")
    );
    expect(res.status).toBe(403);
    expect(requireAuthOrApiKey).not.toHaveBeenCalled();
    expect(dbCalls.updates).toBe(0);
  });
});
