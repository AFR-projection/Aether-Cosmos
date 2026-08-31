import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { timestampParam } from "@/shared/api/query-params";

/**
 * Bounds on the two list endpoints' query parameters.
 *
 * `/api/files` took `cursor`, and `/api/search` took `cursor`, `from` and `to`, as
 * bare optional strings and handed each to `new Date(...)`. `new Date("banana")` is
 * an Invalid Date rather than an error, so it reached the driver as a broken
 * parameter: `?cursor=banana` was a 500 with a logged stack for any authenticated
 * caller. `q` and `mimeType` were also unbounded — and both go into the Redis cache
 * key — and `page` was unbounded, so `?page=1e9` asked Postgres for a billion-row
 * OFFSET.
 */

const store = vi.hoisted(() => ({
  queries: 0,
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@/shared/infrastructure/db", () => {
  function chain(): Record<string, unknown> {
    const self: Record<string, unknown> = {};
    for (const step of ["from", "where", "orderBy", "limit", "offset"]) {
      self[step] = () => self;
    }
    self.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      store.queries++;
      return Promise.resolve(store.rows).then(resolve, reject);
    };
    return self;
  }
  return { db: { select: () => chain() } };
});

vi.mock("@/shared/infrastructure/db/schema", async (importOriginal) => importOriginal());

vi.mock("@/shared/lib/auth/api-key", () => ({
  requireAuthOrApiKey: vi.fn(async () => ({ id: "user-1", role: "user" })),
}));

vi.mock("@/shared/lib/auth/permissions", () => ({
  getEffectiveUserId: vi.fn(() => "user-1"),
  resolveFolderAccess: vi.fn(async () => ({ canView: true, canEdit: true })),
  resolveFileAccess: vi.fn(async () => null),
  resolveWritableDestination: vi.fn(async () => null),
  fileDomainOwnerId: vi.fn(() => "user-1"),
  fileRefusal: vi.fn(() => "no"),
  shareRefusal: vi.fn(() => "no"),
}));

vi.mock("@/shared/infrastructure/cache/redis", () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDelPattern: vi.fn(async () => undefined),
}));

const { GET: search } = await import("@/app/api/search/route");
const { GET: list } = await import("@/app/api/files/route");

function searchRequest(query: string) {
  return new NextRequest(`http://localhost/api/search?${query}`);
}

function listRequest(query: string) {
  return new NextRequest(`http://localhost/api/files?${query}`);
}

beforeEach(() => {
  store.queries = 0;
  store.rows = [];
  vi.clearAllMocks();
});

describe("timestampParam", () => {
  it("parses an ISO instant to a Date", () => {
    const parsed = timestampParam.parse("2026-08-26T04:00:00.000Z");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe("2026-08-26T04:00:00.000Z");
  });

  it("rejects the strings that used to become an Invalid Date", () => {
    for (const value of ["banana", "", "   ", "not-a-date", "2026-13-45", "NaN"]) {
      expect(timestampParam.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("bounds the length, because the value lands in a cache key", () => {
    expect(timestampParam.safeParse("2026-08-26T04:00:00.000Z".padEnd(65, " ")).success).toBe(false);
  });
});

describe("GET /api/search — parameter validation", () => {
  it("accepts a valid window and cursor", async () => {
    const response = await search(
      searchRequest("from=2026-01-01T00:00:00Z&to=2026-08-01T00:00:00Z&cursor=2026-08-26T00:00:00Z")
    );
    expect(response.status).toBe(200);
    expect(store.queries).toBe(1);
  });

  it("refuses a garbage cursor instead of running a query with an Invalid Date", async () => {
    const response = await search(searchRequest("cursor=banana"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.queries).toBe(0);
  });

  it("refuses a garbage from/to", async () => {
    expect((await search(searchRequest("from=banana"))).status).toBe(400);
    expect((await search(searchRequest("to=%20%20"))).status).toBe(400);
    expect(store.queries).toBe(0);
  });

  it("bounds the free-text query that becomes a tsquery and a cache key", async () => {
    const response = await search(searchRequest(`q=${"a".repeat(257)}`));
    expect(response.status).toBe(400);
    expect(store.queries).toBe(0);
  });

  it("bounds the mime-type filter", async () => {
    const response = await search(searchRequest(`mimeType=${"a".repeat(256)}`));
    expect(response.status).toBe(400);
    expect(store.queries).toBe(0);
  });

  it("bounds the page offset", async () => {
    const response = await search(searchRequest("q=notes&page=1000000000"));
    expect(response.status).toBe(400);
    expect(store.queries).toBe(0);
  });

  it("refuses a negative size filter", async () => {
    expect((await search(searchRequest("minSize=-1"))).status).toBe(400);
    expect((await search(searchRequest("maxSize=abc"))).status).toBe(400);
    expect(store.queries).toBe(0);
  });

  it("still runs the ranked path for a real query", async () => {
    const response = await search(searchRequest("q=invoice&page=2"));
    expect(response.status).toBe(200);
    expect(store.queries).toBe(1);
  });
});

describe("GET /api/files — cursor validation", () => {
  it("accepts an ISO cursor", async () => {
    const response = await list(listRequest("cursor=2026-08-26T00:00:00.000Z"));
    expect(response.status).toBe(200);
    expect(store.queries).toBe(1);
  });

  it("refuses a garbage cursor on the personal listing", async () => {
    const response = await list(listRequest("cursor=banana"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.queries).toBe(0);
  });

  it("refuses a garbage cursor on the shared-folder listing too", async () => {
    const response = await list(
      listRequest("folderId=6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a01&cursor=banana")
    );
    expect(response.status).toBe(400);
    expect(store.queries).toBe(0);
  });
});
