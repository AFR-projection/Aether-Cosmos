import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "stream";
import JSZip from "jszip";

/**
 * Ceilings on the two "look inside an archive" endpoints.
 *
 * Both used to pull the WHOLE object into one Buffer with no limit, and extract
 * then decompressed one entry with `entry.async()` — also with no limit. Any
 * signed-in user could turn a request into a multi-GB allocation in the shared
 * Node process, and a few-MB decompression bomb did the same on extract. That is
 * an availability failure for everyone, not just the caller, so the refusals have
 * to happen before the memory is spent: 413, not an OOM kill.
 */

const store = vi.hoisted(() => ({
  file: null as Record<string, unknown> | null,
  body: null as unknown,
  r2Calls: 0,
  bandwidth: [] as number[],
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    requireAuth: vi.fn().mockResolvedValue({ id: "user-1", role: "user" }),
    getClientIp: vi.fn(() => "127.0.0.1"),
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  getAccessibleFile: vi.fn(async () =>
    store.file ? { canView: true, file: store.file } : null
  ),
  resolveFileAccess: vi.fn(async () =>
    store.file ? { canView: true, file: store.file } : null
  ),
}));

vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2Stream: vi.fn(async () => {
    store.r2Calls++;
    return { body: store.body };
  }),
}));

vi.mock("@/lib/billing/bandwidth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/bandwidth")>();
  return {
    ...actual,
    recordBandwidth: vi.fn(async (_u: string, bytes: number) => {
      store.bandwidth.push(bytes);
    }),
  };
});

const FILE_ID = "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a01";

/** Comfortably past ARCHIVE_INSPECT_MAX_BYTES, as a row's recorded size. */
const ARCHIVE_OVER_LIMIT = 512 * 1024 * 1024;

function seed(entries: Record<string, Uint8Array | string>, sizeBytes?: number) {
  return (async () => {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(entries)) zip.file(name, data);
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    store.file = {
      id: FILE_ID,
      userId: "user-1",
      name: "bundle.zip",
      r2Key: `files/${FILE_ID}`,
      sizeBytes: sizeBytes ?? buffer.length,
    };
    store.body = Readable.from([buffer]);
    return buffer;
  })();
}

async function extract(path: string) {
  const { GET } = await import("@/app/api/files/[id]/archive/extract/route");
  const url = `http://localhost/api/files/${FILE_ID}/archive/extract?path=${encodeURIComponent(path)}`;
  return GET(new NextRequest(url), { params: Promise.resolve({ id: FILE_ID }) });
}

async function listing() {
  const { GET } = await import("@/app/api/files/[id]/archive/listing/route");
  const url = `http://localhost/api/files/${FILE_ID}/archive/listing`;
  return GET(new NextRequest(url), { params: Promise.resolve({ id: FILE_ID }) });
}

beforeEach(() => {
  store.file = null;
  store.body = null;
  store.r2Calls = 0;
  store.bandwidth = [];
  vi.clearAllMocks();
});

describe("GET archive/extract", () => {
  it("returns a normal entry", async () => {
    await seed({ "docs/readme.txt": "hello" });
    const response = await extract("docs/readme.txt");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(store.bandwidth).toEqual([5]);
  });

  it("refuses an over-sized archive before touching R2", async () => {
    await seed({ "a.txt": "x" }, 512 * 1024 * 1024);
    const response = await extract("a.txt");
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
    // The point of the pre-check: the bytes are never requested at all.
    expect(store.r2Calls).toBe(0);
    expect(store.bandwidth).toEqual([]);
  });

  it("refuses a decompression bomb instead of inflating it", async () => {
    // ~68 MiB of zeroes deflates to a few dozen KB. Unbounded, this is the whole
    // attack: a small upload becomes tens of MB resident per concurrent request,
    // and the entry can be requested repeatedly.
    await seed({ "bomb.bin": new Uint8Array(68 * 1024 * 1024) });
    const response = await extract("bomb.bin");

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "ARCHIVE_ENTRY_TOO_LARGE",
    });
    // Nothing is billed for a refusal, and no body is produced.
    expect(store.bandwidth).toEqual([]);
  }, 60_000);

  it("still 404s a missing entry", async () => {
    await seed({ "a.txt": "x" });
    const response = await extract("nope.txt");
    expect(response.status).toBe(404);
  });

  it("requires the path parameter", async () => {
    await seed({ "a.txt": "x" });
    const { GET } = await import("@/app/api/files/[id]/archive/extract/route");
    const response = await GET(
      new NextRequest(`http://localhost/api/files/${FILE_ID}/archive/extract`),
      { params: Promise.resolve({ id: FILE_ID }) }
    );
    expect(response.status).toBe(400);
    expect(store.r2Calls).toBe(0);
  });

  it("404s when the caller cannot view the file", async () => {
    store.file = null;
    const response = await extract("a.txt");
    expect(response.status).toBe(404);
    expect(store.r2Calls).toBe(0);
  });
});

describe("GET archive/listing", () => {
  it("lists entries with a summary", async () => {
    await seed({ "docs/": "", "docs/a.txt": "hello", "b.bin": new Uint8Array(16) });
    const response = await listing();

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { entries: { path: string; dir: boolean }[]; summary: { totalFiles: number } };
    };
    const paths = payload.data.entries.map((e) => e.path);
    expect(paths).toContain("docs/a.txt");
    expect(paths).toContain("b.bin");
    expect(payload.data.summary.totalFiles).toBeGreaterThanOrEqual(2);
    // Directories sort ahead of files.
    expect(payload.data.entries[0].dir).toBe(true);
  });

  it("refuses an over-sized archive before touching R2", async () => {
    await seed({ "a.txt": "x" }, ARCHIVE_OVER_LIMIT);
    const response = await listing();

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "ARCHIVE_TOO_LARGE" });
    expect(store.r2Calls).toBe(0);
  });

  it("404s when the caller cannot view the file", async () => {
    store.file = null;
    const response = await listing();
    expect(response.status).toBe(404);
    expect(store.r2Calls).toBe(0);
  });
});
