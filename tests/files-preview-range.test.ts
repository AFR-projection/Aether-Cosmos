import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  accessible: null as Record<string, unknown> | null,
  billed: [] as number[],
  ranges: [] as (string | undefined)[],
  storageError: false,
}));

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ id: "viewer-1", role: "user" })),
  getAccessibleFile: vi.fn(async () => state.accessible),
}));

const storage = vi.hoisted(() => ({
  objectExists: vi.fn(async () => true),
  getPresignedDownloadUrl: vi.fn(
    async () => "https://signed.invalid/private?secret=yes",
  ),
  downloadFromR2Stream: vi.fn(async (_key: string, byteRange?: string) => {
    if (state.storageError) throw new Error("missing");
    state.ranges.push(byteRange);
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("bytes"));
          controller.close();
        },
      }),
      contentLength: byteRange ? 100 : 4096,
      statusCode: byteRange ? 206 : 200,
      contentRange: byteRange
        ? `${byteRange.replace("bytes=", "bytes ")}/4096`
        : undefined,
      eTag: '"etag-1"',
      lastModified: new Date("2026-09-01T12:00:00.000Z"),
    };
  }),
}));

vi.mock("@/shared/lib/auth/session", () => ({ requireAuth: auth.requireAuth }));
vi.mock("@/shared/lib/auth/permissions", () => ({
  getAccessibleFile: auth.getAccessibleFile,
}));
vi.mock("@files/infrastructure/storage/r2", () => storage);
vi.mock("@/shared/lib/billing/bandwidth", () => ({
  BandwidthQuotaError: class BandwidthQuotaError extends Error {},
  recordBandwidth: vi.fn(async (_userId: string, bytes: number) => {
    state.billed.push(bytes);
  }),
}));

const route = await import("@/app/api/files/[id]/preview/route");
const params = Promise.resolve({ id: "file-1" });

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    userId: "owner-1",
    name: "movie.mp4",
    mimeType: "video/mp4",
    sizeBytes: 4096,
    r2Key: "users/owner-1/movie.mp4",
    isNote: false,
    ...overrides,
  };
}

function get(headers: Record<string, string> = {}, query = "") {
  return new NextRequest(`http://localhost/api/files/file-1/preview${query}`, {
    headers,
  });
}

beforeEach(() => {
  state.accessible = { canView: true, file: file() };
  state.billed = [];
  state.ranges = [];
  state.storageError = false;
  vi.clearAllMocks();
});

describe("GET /api/files/[id]/preview", () => {
  it("authorizes before opening storage", async () => {
    state.accessible = null;

    const response = await route.GET(get(), { params });

    expect(response.status).toBe(404);
    expect(storage.downloadFromR2Stream).not.toHaveBeenCalled();
    expect(state.billed).toEqual([]);
  });

  it("serves a closed range with complete seek headers and validators", async () => {
    const response = await route.GET(get({ range: "bytes=100-199" }), {
      params,
    });

    expect(response.status).toBe(206);
    expect(state.ranges).toEqual(["bytes=100-199"]);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 100-199/4096");
    expect(response.headers.get("content-length")).toBe("100");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("etag")).toBe('"etag-1"');
    expect(response.headers.get("last-modified")).toBe(
      "Tue, 01 Sep 2026 12:00:00 GMT",
    );
    expect(state.billed).toEqual([]);
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it("charges an initial range once and does not make a HEAD request", async () => {
    const response = await route.GET(get({ range: "bytes=0-1023" }), {
      params,
    });

    expect(response.status).toBe(206);
    expect(state.billed).toEqual([4096]);
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it("treats malformed Range syntax as a billed whole-object request", async () => {
    const response = await route.GET(get({ range: "bytes=wat" }), { params });

    expect(response.status).toBe(200);
    expect(state.ranges).toEqual([undefined]);
    expect(state.billed).toEqual([4096]);
    expect(response.headers.get("content-length")).toBe("4096");
  });

  it("returns 416 before billing or opening R2", async () => {
    const response = await route.GET(get({ range: "bytes=99999-" }), {
      params,
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes */4096");
    expect(state.billed).toEqual([]);
    expect(storage.downloadFromR2Stream).not.toHaveBeenCalled();
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it("learns a missing object from GET rather than a duplicate HEAD", async () => {
    state.storageError = true;

    const response = await route.GET(get({ range: "bytes=0-1" }), { params });

    expect(response.status).toBe(404);
    expect(storage.downloadFromR2Stream).toHaveBeenCalledTimes(1);
    expect(storage.objectExists).not.toHaveBeenCalled();
  });

  it("keeps the legacy JSON consumer and performs its explicit existence check", async () => {
    const response = await route.GET(get({}, "?format=json"), { params });

    expect(response.status).toBe(200);
    expect(storage.objectExists).toHaveBeenCalledTimes(1);
    expect(storage.getPresignedDownloadUrl).toHaveBeenCalledTimes(1);
    expect(state.billed).toEqual([4096]);
  });
});
