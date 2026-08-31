import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Entry names in the ZIP that `POST /api/download/zip` builds.
 *
 * `files.name` is uploader-controlled and validated for length only, so it can be
 * `../../evil.sh`. Appended verbatim, the archive we hand back is a zip-slip
 * payload: an extractor that trusts entry paths writes outside the directory the
 * recipient chose. In a shared folder the uploader and the person downloading are
 * different people, which is what makes the name untrusted input here.
 *
 * The sibling folder-archive route already sanitized. These tests pin that this
 * one does too, and that duplicates stay distinct rather than overwriting.
 */

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  /** Every entry name handed to archiver, in order. */
  appended: [] as string[],
  finalized: 0,
  aborted: 0,
  bandwidth: [] as number[],
}));

vi.mock("@/shared/infrastructure/db", () => {
  const thenable = (result: () => unknown[]) => {
    const api = {
      from: () => api,
      where: () => api,
      then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(r, j),
    };
    return api;
  };
  return { db: { select: () => thenable(() => store.rows) } };
});

vi.mock("@/shared/infrastructure/db/schema", async (importOriginal) => importOriginal());

vi.mock("@/shared/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/security")>();
  return { ...actual, validateCsrf: vi.fn().mockResolvedValue(true) };
});

vi.mock("@/shared/lib/auth/api-key", () => ({
  requireAuthOrApiKey: vi.fn().mockResolvedValue({ id: "user-1", role: "user" }),
}));

vi.mock("@/shared/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/session")>();
  return { ...actual, getClientIp: vi.fn(() => "127.0.0.1") };
});

vi.mock("@/shared/lib/auth/permissions", () => ({
  getEffectiveUserId: vi.fn(() => "user-1"),
  resolveFileAccess: vi.fn(async (_u: unknown, id: string) => ({
    canView: true,
    file: store.rows.find((r) => r.id === id),
  })),
}));

vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@files/infrastructure/storage/r2", () => ({
  downloadFromR2Stream: vi.fn(async () => {
    const { Readable } = await import("stream");
    return { body: Readable.from([Buffer.from("payload")]) };
  }),
}));

vi.mock("@/shared/lib/billing/bandwidth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/billing/bandwidth")>();
  return {
    ...actual,
    recordBandwidth: vi.fn(async (_u: string, bytes: number) => {
      store.bandwidth.push(bytes);
    }),
  };
});

vi.mock("archiver", () => {
  class ZipArchive {
    private sink: { end: () => void } | null = null;
    on() {
      return this;
    }
    pipe(dest: { end: () => void }) {
      this.sink = dest;
      return dest;
    }
    append(_source: unknown, opts: { name: string }) {
      store.appended.push(opts.name);
      // Drain the source so the mocked R2 stream does not stay pending.
      const src = _source as { resume?: () => void };
      src.resume?.();
      return this;
    }
    async finalize() {
      store.finalized++;
      this.sink?.end();
    }
    abort() {
      store.aborted++;
      this.sink?.end();
    }
  }
  return { ZipArchive, default: { create: () => new ZipArchive() } };
});

const UUIDS = [
  "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a01",
  "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a02",
  "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a03",
];

function fileRow(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    r2Key: `files/${id}`,
    isNote: false,
    encrypted: false,
    sizeBytes: 7,
    ...extra,
  };
}

function post(ids: string[]) {
  return new NextRequest("http://localhost/api/download/zip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

/** Run the route and wait for the streamed archive to finish being built. */
async function run(ids: string[]) {
  const { POST } = await import("@/app/api/download/zip/route");
  const response = await POST(post(ids));
  if (response.body) {
    await new Response(response.body).arrayBuffer();
  }
  return response;
}

beforeEach(() => {
  store.rows = [];
  store.appended = [];
  store.finalized = 0;
  store.aborted = 0;
  store.bandwidth = [];
  vi.clearAllMocks();
});

describe("POST /api/download/zip — entry names", () => {
  it("flattens a traversal name into a single safe segment", async () => {
    store.rows = [fileRow(UUIDS[0], "../../../../etc/cron.d/pwn")];
    const response = await run([UUIDS[0]]);

    expect(response.status).toBe(200);
    expect(store.appended).toEqual([".._.._.._.._etc_cron.d_pwn"]);
    expect(store.appended[0].includes("/")).toBe(false);
    expect(store.appended[0].startsWith("..")).toBe(true); // literal, no separator
  });

  it("flattens a Windows-style traversal name too", async () => {
    store.rows = [fileRow(UUIDS[0], "..\\..\\Startup\\run.bat")];
    await run([UUIDS[0]]);
    expect(store.appended).toEqual([".._.._Startup_run.bat"]);
    expect(store.appended[0].includes("\\")).toBe(false);
  });

  it("does not emit an absolute entry path", async () => {
    store.rows = [fileRow(UUIDS[0], "/root/.ssh/authorized_keys")];
    await run([UUIDS[0]]);
    expect(store.appended[0].startsWith("/")).toBe(false);
  });

  it("strips control characters from the entry name", async () => {
    const nul = String.fromCharCode(0);
    store.rows = [fileRow(UUIDS[0], `note${nul}.txt`)];
    await run([UUIDS[0]]);
    expect(store.appended).toEqual(["note_.txt"]);
  });

  it("keeps an ordinary name exactly as it is", async () => {
    store.rows = [fileRow(UUIDS[0], "Laporan Q3 2026.pdf")];
    await run([UUIDS[0]]);
    expect(store.appended).toEqual(["Laporan Q3 2026.pdf"]);
  });

  it("keeps duplicates distinct instead of overwriting", async () => {
    store.rows = [
      fileRow(UUIDS[0], "invoice.pdf"),
      fileRow(UUIDS[1], "invoice.pdf"),
      fileRow(UUIDS[2], "invoice.pdf"),
    ];
    await run([UUIDS[0], UUIDS[1], UUIDS[2]]);
    expect(store.appended).toEqual(["invoice.pdf", "invoice (1).pdf", "invoice (2).pdf"]);
    expect(new Set(store.appended).size).toBe(3);
  });

  it("collapses two different traversal names onto distinct entries", async () => {
    store.rows = [fileRow(UUIDS[0], "../a.txt"), fileRow(UUIDS[1], "..\\a.txt")];
    await run([UUIDS[0], UUIDS[1]]);
    expect(store.appended).toEqual([".._a.txt", ".._a (1).txt"]);
  });

  it("finalizes the archive once", async () => {
    store.rows = [fileRow(UUIDS[0], "a.txt")];
    await run([UUIDS[0]]);
    expect(store.finalized).toBe(1);
    expect(store.aborted).toBe(0);
  });
});
