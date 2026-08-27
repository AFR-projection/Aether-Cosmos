import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { EXTRACT_AUDIO_SOURCE_MAX_BYTES } from "@/lib/files/edit-limits";

/**
 * `POST /api/files/extract-audio` — pulling a video's soundtrack into a NEW file.
 *
 * Everything here is a refusal the route has to make *before* the job is queued, because
 * the work happens in the worker and nothing after this request can answer the caller.
 * The job creates a file, so unlike an in-place edit it also has to decide two things the
 * worker must not guess: whose account the new file belongs to (the video's owner, not
 * whoever pressed the button) and which folder it may be written into.
 */

const FILE_ID = "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a01";
const OTHER_FOLDER = "3c2b1a09-8f7e-4d6c-9b5a-4d3c2b1a0987";

const store = vi.hoisted(() => ({
  file: null as Record<string, unknown> | null,
  canEdit: true,
  csrfOk: true,
  objectPresent: true,
  /** `null` stands for an account row that no longer exists. */
  owner: null as { quotaBytes: number; usedBytes: number; reservedBytes: number } | null,
  destination: { ok: true, folderId: null } as Record<string, unknown>,
  /** Whether Redis is reachable, which is what makes `queued: true` true. */
  queueUp: true,
  jobs: [] as { type: string; data: Record<string, unknown> }[],
  activity: [] as { action: string; metadata: unknown }[],
  objectChecks: 0,
}));

vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, validateCsrf: vi.fn(async () => store.csrfOk) };
});

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
    store.file ? { canView: true, canEdit: store.canEdit, file: store.file } : null
  ),
  fileRefusal: vi.fn(() => "You don't have permission to edit this file"),
  fileDomainOwnerId: vi.fn(async () => null),
  resolveWritableDestination: vi.fn(async () => store.destination),
}));

vi.mock("@/lib/storage/r2", () => ({
  objectExists: vi.fn(async () => {
    store.objectChecks++;
    return store.objectPresent;
  }),
}));

vi.mock("@/lib/queue", () => ({
  getQueue: vi.fn(() => (store.queueUp ? ({} as unknown) : null)),
  enqueueJob: vi.fn(async (type: string, data: Record<string, unknown>) => {
    if (!store.queueUp) return false;
    store.jobs.push({ type, data });
    return true;
  }),
}));

vi.mock("@/lib/auth/audit", () => ({
  logActivity: vi.fn(async (_user: unknown, action: string, options?: { metadata?: unknown }) => {
    store.activity.push({ action, metadata: options?.metadata });
  }),
}));

vi.mock("@/lib/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (store.owner ? [store.owner] : []),
  };
  return { db: { select: () => selectChain } };
});

vi.mock("@/lib/db/schema", async (importOriginal) => importOriginal());

function seedVideo(overrides: Record<string, unknown> = {}) {
  store.file = {
    id: FILE_ID,
    userId: "owner-1",
    folderId: OTHER_FOLDER,
    name: "clip.mp4",
    mimeType: "video/mp4",
    r2Key: `files/${FILE_ID}`,
    sizeBytes: 5_000_000,
    version: 1,
    encrypted: false,
    checksumSha256: null,
    ...overrides,
  };
}

async function extract(body: unknown = { fileId: FILE_ID }) {
  const { POST } = await import("@/app/api/files/extract-audio/route");
  return POST(
    new NextRequest("http://localhost/api/files/extract-audio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  store.file = null;
  store.canEdit = true;
  store.csrfOk = true;
  store.objectPresent = true;
  store.owner = { quotaBytes: 10_000_000_000, usedBytes: 1_000, reservedBytes: 0 };
  store.destination = { ok: true, folderId: null };
  store.queueUp = true;
  store.jobs = [];
  store.activity = [];
  store.objectChecks = 0;
});

describe("POST /api/files/extract-audio — the happy path", () => {
  it("queues one job carrying everything the worker must not guess", async () => {
    seedVideo();
    store.destination = { ok: true, folderId: OTHER_FOLDER };

    const response = await extract();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { queued: true } });

    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toEqual({
      type: "extract_audio",
      data: {
        fileId: FILE_ID,
        r2Key: `files/${FILE_ID}`,
        mimeType: "video/mp4",
        // The OWNER, not the caller: a shared video's audio belongs in the same account
        // as the video, or it counts against the wrong quota.
        userId: "owner-1",
        folderId: OTHER_FOLDER,
        name: "clip.mp4",
      },
    });
  });

  it("sends the job to the folder the caller may actually write to", async () => {
    seedVideo({ folderId: OTHER_FOLDER });
    // A read-only shared folder resolves to somewhere the caller can write — root here.
    store.destination = { ok: true, folderId: null };

    await extract();
    expect(store.jobs[0].data.folderId).toBeNull();
  });

  it("records the extraction against the video", async () => {
    seedVideo();
    await extract();
    expect(store.activity).toEqual([
      { action: "edit", metadata: { action: "extract_audio" } },
    ]);
  });

  it("queues even when the account row has vanished, rather than 500ing", async () => {
    seedVideo();
    store.owner = null;
    const response = await extract();
    expect(response.status).toBe(200);
    expect(store.jobs).toHaveLength(1);
  });

  it("takes a container with no trim muxer, since ffmpeg demuxes by content", async () => {
    seedVideo({ mimeType: "video/x-flv", name: "stream.flv" });
    const response = await extract();
    expect(response.status).toBe(200);
    expect(store.jobs[0].data.mimeType).toBe("video/x-flv");
  });
});

describe("POST /api/files/extract-audio — refusals", () => {
  it("refuses a request with no CSRF token", async () => {
    seedVideo();
    store.csrfOk = false;
    const response = await extract();
    expect(response.status).toBe(403);
    expect(store.jobs).toHaveLength(0);
  });

  it("answers 404 for a file the caller cannot see at all", async () => {
    store.file = null;
    const response = await extract();
    expect(response.status).toBe(404);
    expect(store.jobs).toHaveLength(0);
  });

  it("says why rather than 404ing when the caller can see it but not write", async () => {
    seedVideo();
    store.canEdit = false;
    const response = await extract();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/permission/i);
    expect(store.jobs).toHaveLength(0);
  });

  it("refuses anything that is not a video, before touching storage", async () => {
    for (const mimeType of ["audio/mpeg", "image/png", "application/pdf"]) {
      store.jobs = [];
      store.objectChecks = 0;
      seedVideo({ mimeType });
      const response = await extract();
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("EXTRACT_AUDIO_MIME_REFUSED");
      expect(store.objectChecks).toBe(0);
      expect(store.jobs).toHaveLength(0);
    }
  });

  it("refuses an end-to-end encrypted video, which is ciphertext to ffmpeg", async () => {
    seedVideo({ encrypted: true });
    const response = await extract();
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("EXTRACT_AUDIO_ENCRYPTED_REFUSED");
    expect(store.jobs).toHaveLength(0);
  });

  it("refuses a row whose object is not in storage", async () => {
    seedVideo();
    store.objectPresent = false;
    const response = await extract();
    expect(response.status).toBe(404);
    expect(store.jobs).toHaveLength(0);
  });

  it("refuses a note's key without asking storage about it", async () => {
    seedVideo({ r2Key: "notes/abc" });
    const response = await extract();
    expect(response.status).toBe(404);
    expect(store.objectChecks).toBe(0);
    expect(store.jobs).toHaveLength(0);
  });

  it("refuses a video past the size a worker will pull down", async () => {
    seedVideo({ sizeBytes: EXTRACT_AUDIO_SOURCE_MAX_BYTES + 1 });
    const response = await extract();
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("EXTRACT_AUDIO_SOURCE_TOO_LARGE");
    expect(store.jobs).toHaveLength(0);
  });

  it("accepts one exactly at the ceiling", async () => {
    seedVideo({ sizeBytes: EXTRACT_AUDIO_SOURCE_MAX_BYTES });
    expect((await extract()).status).toBe(200);
  });

  it("reads the size as a number when the bigint column arrives as a string", async () => {
    seedVideo({ sizeBytes: String(EXTRACT_AUDIO_SOURCE_MAX_BYTES + 1) });
    const response = await extract();
    expect(response.status).toBe(413);
    expect(store.jobs).toHaveLength(0);
  });

  it("passes a destination refusal straight through", async () => {
    seedVideo();
    store.destination = { ok: false, status: 403, message: "That folder is read-only for you" };
    const response = await extract();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("That folder is read-only for you");
    expect(store.jobs).toHaveLength(0);
  });

  it("refuses an account with no headroom left", async () => {
    seedVideo();
    store.owner = { quotaBytes: 1_000, usedBytes: 900, reservedBytes: 100 };
    const response = await extract();
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("QUOTA_EXCEEDED");
    expect(store.jobs).toHaveLength(0);
  });

  it("counts bytes reserved by an upload in flight against the headroom", async () => {
    seedVideo();
    store.owner = { quotaBytes: 1_000, usedBytes: 100, reservedBytes: 950 };
    expect((await extract()).status).toBe(413);
  });

  it("queues when there is any headroom at all, and lets the worker do the exact sum", async () => {
    seedVideo();
    store.owner = { quotaBytes: 1_000, usedBytes: 900, reservedBytes: 99 };
    expect((await extract()).status).toBe(200);
  });

  it("refuses when there is no queue to accept the job", async () => {
    seedVideo();
    store.queueUp = false;
    const response = await extract();
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("EXTRACT_AUDIO_QUEUE_UNAVAILABLE");
    expect(store.jobs).toHaveLength(0);
  });

  it("refuses a body that names no file", async () => {
    seedVideo();
    expect((await extract({})).status).toBe(400);
    expect((await extract({ fileId: "not-a-uuid" })).status).toBe(400);
    expect(store.jobs).toHaveLength(0);
  });
});
