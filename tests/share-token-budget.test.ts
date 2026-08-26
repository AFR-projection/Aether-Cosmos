import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The share-link access budget, at the route level.
 *
 * `maxAccessCount` used to be spent by the metadata endpoint (`GET /api/shared/[token]`)
 * and merely *read* by the endpoint that streams the bytes. A caller who skipped the
 * metadata call and went straight to `/preview` never moved the counter, so a
 * "one download" link was an unlimited download link.
 *
 * What is pinned here is where the unit is spent:
 *   - a note's body IS served by the metadata endpoint, so that endpoint claims;
 *   - a file's bytes leave through `/preview`, so `/preview` claims and the metadata
 *     endpoint only reports;
 *   - a spent link stops `/preview` BEFORE the object is fetched from R2 — a 403
 *     issued after the stream is open is not a limit.
 *
 * And the second way around the budget, which the fix above left open: `/preview`
 * exempted any `Range` request that did not start at byte 0 so a resumed transfer
 * would not be charged twice, then ignored the range and served the whole object
 * with a `200`. `Range: bytes=1-` was therefore a free, repeatable, complete
 * download. Now the range is honoured (`206` + `Content-Range`) and the exemption
 * only applies to a transfer there is evidence of — a unit spent on this link inside
 * `SHARE_RESUME_WINDOW_MS`.
 *
 * Public egress is also the owner's egress: every other byte-serving route meters it
 * against `bandwidthQuotaBytes`, and this one did not.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  share: null as Record<string, unknown> | null,
  file: null as Record<string, unknown> | null,
  content: null as Record<string, unknown> | null,
  user: null as Record<string, unknown> | null,
  /** Whether `claimShareAccess` should report a unit as available. */
  claimSucceeds: true,
  claims: [] as string[],
  updates: [] as { table: string; values: Record<string, unknown> }[],
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  /** Ranges handed to R2, in order. `undefined` means "whole object". */
  ranges: [] as (string | undefined)[],
  rateAllowed: true,
  rateKeys: [] as string[],
}));

/** Which table a drizzle query object refers to, by a column only it has. */
function tableOf(table: unknown): string {
  const t = table as Record<string, unknown>;
  if (!t) return "unknown";
  if ("token" in t && "accessCount" in t) return "shares";
  if ("bandwidthQuotaBytes" in t) return "users";
  if ("r2Key" in t) return "files";
  if ("contentJson" in t) return "fileContents";
  if ("action" in t && "resourceType" in t) return "activityLogs";
  return "unknown";
}

vi.mock("@/lib/db", () => {
  function rowsFor(table: string): Row[] {
    if (table === "shares") return store.share ? [store.share] : [];
    if (table === "files") return store.file ? [store.file] : [];
    if (table === "fileContents") return store.content ? [store.content] : [];
    if (table === "users") return store.user ? [store.user] : [];
    return [];
  }

  function selectChain() {
    let table = "unknown";
    const api: Record<string, unknown> = {
      from(t: unknown) {
        table = tableOf(t);
        return api;
      },
      where: () => api,
      orderBy: () => api,
      limit: async () => rowsFor(table),
      then: (r: (v: Row[]) => unknown, j?: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table)).then(r, j),
    };
    return api;
  }

  function writeChain(kind: "update" | "insert", table: string) {
    let values: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      set(v: Record<string, unknown>) {
        values = v;
        (kind === "update" ? store.updates : store.inserts).push({ table, values });
        return api;
      },
      values(v: Record<string, unknown>) {
        values = v;
        store.inserts.push({ table, values });
        return api;
      },
      where: () => api,
      returning: async () => [{ id: "row" }],
      then: (r: (v: Row[]) => unknown, j?: (e: unknown) => unknown) =>
        Promise.resolve([{ id: "row" }]).then(r, j),
    };
    return api;
  }

  return {
    db: {
      select: () => selectChain(),
      update: (t: unknown) => writeChain("update", tableOf(t)),
      insert: (t: unknown) => writeChain("insert", tableOf(t)),
    },
  };
});

// The atomic claim itself is unit-tested in `lib/shares/access.test.ts`. Here it is a
// spy, so a test can say "this link is spent" without simulating SQL — but the two
// read-only predicates stay real, because the routes' 410/403 wording depends on them.
vi.mock("@/lib/shares/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shares/access")>();
  return {
    ...actual,
    claimShareAccess: vi.fn(async (shareId: string) => {
      store.claims.push(shareId);
      if (!store.claimSucceeds) return null;
      const share = store.share!;
      share.accessCount = (share.accessCount as number) + 1;
      share.lastAccessedAt = new Date();
      return share as never;
    }),
  };
});

vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2Stream: vi.fn(async (_key: string, byteRange?: string) => {
    store.ranges.push(byteRange);
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("bytes"));
          controller.close();
        },
      }),
      contentLength: 5,
      // R2 answers 206 only when it was actually asked for a range.
      statusCode: byteRange ? 206 : 200,
      contentRange: byteRange ? `${byteRange.replace("bytes=", "bytes ")}/4096` : undefined,
    };
  }),
}));

vi.mock("@/lib/access-tracking", () => ({
  getClientIpFromRequest: () => "203.0.113.9",
  parseUserAgent: () => ({ device: "desktop", browser: "test", os: "test" }),
  getIpLocation: async () => null,
}));

vi.mock("@/lib/realtime/events", () => ({ publishToUser: vi.fn(async () => {}) }));
vi.mock("@/lib/activity/activity-scope-server", () => ({
  getOrCreateActivityScope: vi.fn(async () => ({ id: "scope-1" })),
}));
vi.mock("@/lib/search/tiptap-text", () => ({ tiptapToPlainText: () => "plain" }));
vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return {
    ...actual,
    checkRateLimit: vi.fn(async (key: string) => {
      store.rateKeys.push(key);
      return { allowed: store.rateAllowed, remaining: 59 };
    }),
  };
});

const { claimShareAccess, SHARE_RESUME_WINDOW_MS } = await import("@/lib/shares/access");
const { downloadFromR2Stream } = await import("@/lib/storage/r2");
const infoRoute = await import("@/app/api/shared/[token]/route");
const previewRoute = await import("@/app/api/shared/[token]/preview/route");

const TOKEN = "sharetoken0000000000000000000000";
const params = Promise.resolve({ token: TOKEN });

function shareRow(over: Record<string, unknown> = {}) {
  return {
    id: "share-1",
    token: TOKEN,
    fileId: "file-1",
    sharedBy: "owner-1",
    permission: "view",
    accessCount: 0,
    maxAccessCount: 1,
    expiresAt: null,
    lastAccessedAt: null,
    ...over,
  };
}

function fileRow(over: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    userId: "owner-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 5,
    r2Key: "u/owner-1/report.pdf",
    isNote: false,
    deletedAt: null,
    status: "ready",
    ...over,
  };
}

/** The owner whose bandwidth quota a public download spends. */
function userRow(over: Record<string, unknown> = {}) {
  return {
    id: "owner-1",
    bandwidthQuotaBytes: 1_000_000,
    bandwidthUsedBytes: 0,
    bandwidthPeriodStart: new Date(),
    ...over,
  };
}

/** Bytes billed to the owner across this test, in order. */
function billedBytes(): number[] {
  return store.updates
    .filter((u) => u.table === "users")
    .map((u) => u.values.bandwidthUsedBytes as number);
}

function get(headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/shared/${TOKEN}/preview`, { headers });
}

function put(body: unknown) {
  return new NextRequest(`http://localhost/api/shared/${TOKEN}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  store.share = shareRow();
  store.file = fileRow();
  store.content = { contentJson: { type: "doc" } };
  store.user = userRow();
  store.claimSucceeds = true;
  store.claims = [];
  store.updates = [];
  store.inserts = [];
  store.ranges = [];
  store.rateAllowed = true;
  store.rateKeys = [];
  vi.mocked(claimShareAccess).mockClear();
  vi.mocked(downloadFromR2Stream).mockClear();
});

describe("GET /api/shared/[token]/preview — the bytes path spends the unit", () => {
  it("claims one unit before streaming", async () => {
    const res = await previewRoute.GET(get(), { params });
    expect(res.status).toBe(200);
    expect(store.claims).toEqual(["share-1"]);
    expect(downloadFromR2Stream).toHaveBeenCalledTimes(1);
  });

  it("refuses a spent link and never touches storage", async () => {
    store.claimSucceeds = false;
    const res = await previewRoute.GET(get(), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false });
    expect(downloadFromR2Stream).not.toHaveBeenCalled();
  });

  it("bounds a caller who skips the metadata endpoint entirely", async () => {
    // The regression: two direct hits on /preview with maxAccessCount = 1.
    store.share = shareRow({ maxAccessCount: 1, accessCount: 0 });
    const first = await previewRoute.GET(get(), { params });
    expect(first.status).toBe(200);

    store.claimSucceeds = false; // the row is now at its ceiling
    const second = await previewRoute.GET(get(), { params });
    expect(second.status).toBe(403);
    expect(store.claims).toHaveLength(2);
  });

  it("charges a Range from a caller who has not paid for anything yet", async () => {
    // The regression: `Range: bytes=1-` skipped the claim unconditionally and the
    // range was then dropped, so the response was the whole object, for free, as
    // many times as asked.
    store.share = shareRow({ maxAccessCount: 1, accessCount: 0, lastAccessedAt: null });
    store.file = fileRow({ sizeBytes: 4096 });

    const res = await previewRoute.GET(get({ range: "bytes=1-" }), { params });

    expect(res.status).toBe(206);
    expect(store.claims).toEqual(["share-1"]);
  });

  it("refuses that Range once the link is spent, instead of serving it free", async () => {
    store.share = shareRow({ maxAccessCount: 1, accessCount: 1, lastAccessedAt: null });
    store.file = fileRow({ sizeBytes: 4096 });
    store.claimSucceeds = false;

    const res = await previewRoute.GET(get({ range: "bytes=1-" }), { params });

    expect(res.status).toBe(403);
    expect(downloadFromR2Stream).not.toHaveBeenCalled();
  });

  it("does not charge a resumed transfer again", async () => {
    // A real resume: a unit was spent on this link a moment ago.
    store.share = shareRow({
      maxAccessCount: 1,
      accessCount: 1,
      lastAccessedAt: new Date(Date.now() - 5_000),
    });
    store.file = fileRow({ sizeBytes: 4096 });

    const res = await previewRoute.GET(get({ range: "bytes=1024-" }), { params });

    expect(res.status).toBe(206);
    expect(store.claims).toEqual([]);
  });

  it("charges again once the resume window has passed", async () => {
    store.share = shareRow({
      maxAccessCount: 1,
      accessCount: 1,
      lastAccessedAt: new Date(Date.now() - (SHARE_RESUME_WINDOW_MS + 1000)),
    });
    store.file = fileRow({ sizeBytes: 4096 });
    store.claimSucceeds = false;

    const res = await previewRoute.GET(get({ range: "bytes=1024-" }), { params });

    expect(res.status).toBe(403);
  });

  it("actually serves the range it was given", async () => {
    store.share = shareRow({ maxAccessCount: null });
    store.file = fileRow({ sizeBytes: 4096 });

    const res = await previewRoute.GET(get({ range: "bytes=100-199" }), { params });

    expect(res.status).toBe(206);
    expect(store.ranges).toEqual(["bytes=100-199"]);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/4096");
    expect(res.headers.get("content-length")).toBe("100");
  });

  it("treats an unsatisfiable range as a whole-object request and charges it", async () => {
    store.share = shareRow({ maxAccessCount: null });
    store.file = fileRow({ sizeBytes: 4096 });

    const res = await previewRoute.GET(get({ range: "bytes=99999-" }), { params });

    expect(res.status).toBe(200);
    expect(store.ranges).toEqual([undefined]);
    expect(store.claims).toEqual(["share-1"]);
  });

  it("charges a Range that starts at the beginning — that is a fresh access", async () => {
    store.file = fileRow({ sizeBytes: 4096 });
    const res = await previewRoute.GET(get({ range: "bytes=0-1023" }), { params });
    expect(res.status).toBe(206);
    expect(store.claims).toEqual(["share-1"]);
  });

  it("still refuses an expired link before spending anything", async () => {
    store.share = shareRow({ expiresAt: new Date(Date.now() - 1000) });
    const res = await previewRoute.GET(get(), { params });
    expect(res.status).toBe(410);
    expect(store.claims).toEqual([]);
    expect(downloadFromR2Stream).not.toHaveBeenCalled();
  });

  it("404s an unknown token without claiming", async () => {
    store.share = null;
    const res = await previewRoute.GET(get(), { params });
    expect(res.status).toBe(404);
    expect(store.claims).toEqual([]);
  });

  it("404s a trashed or unready file without claiming", async () => {
    store.file = null;
    const res = await previewRoute.GET(get(), { params });
    expect(res.status).toBe(404);
    expect(store.claims).toEqual([]);
  });

  it("serves the file as an attachment or inline but never as active content", async () => {
    store.file = fileRow({ name: "page.html", mimeType: "text/html" });
    const res = await previewRoute.GET(get(), { params });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });
});

describe("GET /api/shared/[token]/preview — public egress is metered", () => {
  it("bills the owner for the whole object on a full request", async () => {
    store.file = fileRow({ sizeBytes: 4096 });
    const res = await previewRoute.GET(get(), { params });

    expect(res.status).toBe(200);
    expect(billedBytes()).toEqual([4096]);
  });

  it("bills only the bytes a range carries", async () => {
    store.share = shareRow({ maxAccessCount: null });
    store.file = fileRow({ sizeBytes: 4096 });
    const res = await previewRoute.GET(get({ range: "bytes=0-99" }), { params });

    expect(res.status).toBe(206);
    expect(billedBytes()).toEqual([100]);
  });

  it("stops the download when the owner is over quota, before opening the stream", async () => {
    store.file = fileRow({ sizeBytes: 4096 });
    store.user = userRow({ bandwidthQuotaBytes: 1000, bandwidthUsedBytes: 999 });

    const res = await previewRoute.GET(get(), { params });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: "BANDWIDTH_QUOTA_EXCEEDED" });
    expect(downloadFromR2Stream).not.toHaveBeenCalled();
  });

  it("treats a zero quota as unlimited, as everywhere else", async () => {
    store.file = fileRow({ sizeBytes: 4096 });
    store.user = userRow({ bandwidthQuotaBytes: 0 });

    const res = await previewRoute.GET(get(), { params });
    expect(res.status).toBe(200);
    expect(billedBytes()).toEqual([]);
  });
});

describe("the token in the path is bounded before it is used", () => {
  const oversized = "a".repeat(4096);
  const longParams = Promise.resolve({ token: oversized });

  it("404s an implausible token on /preview without querying or rate-limiting", async () => {
    const res = await previewRoute.GET(get(), { params: longParams });

    expect(res.status).toBe(404);
    expect(store.rateKeys).toEqual([]);
    expect(downloadFromR2Stream).not.toHaveBeenCalled();
  });

  it("404s it on the metadata endpoint too", async () => {
    const res = await infoRoute.GET(get(), { params: longParams });
    expect(res.status).toBe(404);
    expect(store.rateKeys).toEqual([]);
  });

  it("never builds a rate-limit key out of an unbounded token on PUT", async () => {
    const res = await infoRoute.PUT(put({ content: { type: "doc" } }), { params: longParams });

    expect(res.status).toBe(404);
    // The old handler keyed `share_edit:${token}` before looking at anything.
    expect(store.rateKeys).toEqual([]);
    expect(store.updates).toHaveLength(0);
  });

  it("rejects a token with characters no generated token contains", async () => {
    const res = await previewRoute.GET(get(), {
      params: Promise.resolve({ token: "../../etc/passwd" }),
    });
    expect(res.status).toBe(404);
    expect(store.rateKeys).toEqual([]);
  });
});

describe("the anonymous endpoints are rate-limited", () => {
  it("limits /preview per caller", async () => {
    store.rateAllowed = false;
    const res = await previewRoute.GET(get(), { params });

    expect(res.status).toBe(429);
    expect(store.rateKeys[0]).toMatch(/^share_preview:/);
    expect(store.claims).toEqual([]);
    expect(downloadFromR2Stream).not.toHaveBeenCalled();
  });

  it("limits the metadata endpoint per caller", async () => {
    store.rateAllowed = false;
    const res = await infoRoute.GET(get(), { params });

    expect(res.status).toBe(429);
    expect(store.rateKeys[0]).toMatch(/^share_view:/);
    expect(store.claims).toEqual([]);
  });

  it("limits note edits per caller as well as per token", async () => {
    store.rateAllowed = false;
    store.share = shareRow({ permission: "edit", maxAccessCount: null });
    store.file = fileRow({ isNote: true, r2Key: null });

    const res = await infoRoute.PUT(put({ content: { type: "doc" } }), { params });

    expect(res.status).toBe(429);
    expect(store.rateKeys[0]).toMatch(/^share_edit_ip:/);
    expect(store.updates).toHaveLength(0);
  });
});

describe("GET /api/shared/[token] — the metadata path", () => {
  it("does not spend a unit for a regular file: /preview will", async () => {
    const res = await infoRoute.GET(get(), { params });
    expect(res.status).toBe(200);
    expect(store.claims).toEqual([]);
    // The visit is still recorded, but only as a timestamp.
    const shareUpdates = store.updates.filter((u) => u.table === "shares");
    expect(shareUpdates).toHaveLength(1);
    expect(Object.keys(shareUpdates[0].values)).toEqual(["lastAccessedAt"]);
  });

  it("reports the counter without letting a spent file link through", async () => {
    store.share = shareRow({ accessCount: 1, maxAccessCount: 1 });
    const res = await infoRoute.GET(get(), { params });
    expect(res.status).toBe(403);
    expect(store.claims).toEqual([]);
    expect(store.updates.filter((u) => u.table === "shares")).toHaveLength(0);
  });

  it("spends a unit for a note, because this endpoint is the note's content path", async () => {
    store.file = fileRow({ isNote: true, mimeType: "text/plain", r2Key: null });
    const res = await infoRoute.GET(get(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(store.claims).toEqual(["share-1"]);
    expect(json.data.note).toEqual({ content: { type: "doc" } });
    expect(json.data.accessCount).toBe(1);
    // No second write: the claim already moved the timestamp.
    expect(store.updates.filter((u) => u.table === "shares")).toHaveLength(0);
  });

  it("refuses a spent note link and returns no content", async () => {
    store.file = fileRow({ isNote: true, r2Key: null });
    store.claimSucceeds = false;
    const res = await infoRoute.GET(get(), { params });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.data).toBeUndefined();
  });

  it("refuses an expired link with 410", async () => {
    store.share = shareRow({ expiresAt: new Date(Date.now() - 1) });
    const res = await infoRoute.GET(get(), { params });
    expect(res.status).toBe(410);
    expect(store.claims).toEqual([]);
  });
});

describe("PUT /api/shared/[token] — the shared-note editor", () => {
  const doc = { content: { type: "doc", content: [] } };

  it("saves an edit on an edit-permission note", async () => {
    store.share = shareRow({ permission: "edit", maxAccessCount: null });
    store.file = fileRow({ isNote: true, r2Key: null });
    const res = await infoRoute.PUT(put(doc), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { saved: true } });
  });

  it("does not spend a unit on a save — autosave must not burn a view-limited link", async () => {
    store.share = shareRow({ permission: "edit", maxAccessCount: 5 });
    store.file = fileRow({ isNote: true, r2Key: null });
    await infoRoute.PUT(put(doc), { params });
    expect(store.claims).toEqual([]);
    expect(store.updates.filter((u) => u.table === "shares")).toHaveLength(0);
  });

  it("rejects a body over the 2 MiB ceiling with 413 and writes nothing", async () => {
    store.share = shareRow({ permission: "edit", maxAccessCount: null });
    store.file = fileRow({ isNote: true, r2Key: null });
    const huge = JSON.stringify({ content: { type: "doc", text: "x".repeat(3 * 1024 * 1024) } });

    const res = await infoRoute.PUT(put(huge), { params });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(store.updates).toHaveLength(0);
    expect(store.inserts).toHaveLength(0);
  });

  it("rejects a malformed body with 400 INVALID_JSON", async () => {
    store.share = shareRow({ permission: "edit", maxAccessCount: null });
    const res = await infoRoute.PUT(put("{not json"), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_JSON" });
  });

  it("refuses a view-only link", async () => {
    store.file = fileRow({ isNote: true, r2Key: null });
    const res = await infoRoute.PUT(put(doc), { params });
    expect(res.status).toBe(403);
    expect(store.updates).toHaveLength(0);
  });

  it("refuses an expired link even with edit permission", async () => {
    store.share = shareRow({ permission: "edit", expiresAt: new Date(Date.now() - 1) });
    store.file = fileRow({ isNote: true, r2Key: null });
    const res = await infoRoute.PUT(put(doc), { params });
    expect(res.status).toBe(410);
    expect(store.updates).toHaveLength(0);
  });

  it("refuses a spent link even with edit permission", async () => {
    store.share = shareRow({ permission: "edit", accessCount: 3, maxAccessCount: 3 });
    store.file = fileRow({ isNote: true, r2Key: null });
    const res = await infoRoute.PUT(put(doc), { params });
    expect(res.status).toBe(403);
    expect(store.updates).toHaveLength(0);
  });

  it("refuses to write a body onto a non-note file", async () => {
    store.share = shareRow({ permission: "edit", maxAccessCount: null });
    const res = await infoRoute.PUT(put(doc), { params });
    expect(res.status).toBe(400);
    expect(store.updates).toHaveLength(0);
  });
});
