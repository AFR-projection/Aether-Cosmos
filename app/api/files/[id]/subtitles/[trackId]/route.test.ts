import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  track: null as Record<string, unknown> | null,
  size: { cueCount: 0, estimatedBytes: 7 },
  cues: [] as Array<{ idx: number; startMs: number; endMs: number; text: string }>,
  replacement: { ok: true, revision: 2 } as
    | { ok: true; revision: number }
    | { ok: false; reason: "missing" | "revision_conflict" },
}));

const calls = vi.hoisted(() => ({
  listCues: vi.fn(async () => state.cues),
  replace: vi.fn(async () => state.replacement),
}));

vi.mock("@/shared/lib/auth/session", () => ({
  requireAuth: vi.fn(async () => ({ id: "user-1" })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/shared/lib/auth/permissions", () => ({
  getAccessibleFile: vi.fn(async () => ({
    canView: true,
    canEdit: true,
    file: { name: "movie.mp4" },
  })),
  fileRefusal: vi.fn(() => "Forbidden"),
}));
vi.mock("@/shared/lib/security", () => ({ validateCsrf: vi.fn(async () => true) }));
vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@files/infrastructure/subtitles/tracks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@files/infrastructure/subtitles/tracks")>();
  return {
    ...actual,
    getTrackForFile: vi.fn(async () => state.track),
    getWholeVttSize: vi.fn(async () => state.size),
    listCues: calls.listCues,
    replaceCuesAtRevision: calls.replace,
    deleteTrack: vi.fn(async () => undefined),
  };
});

const route = await import("@/app/api/files/[id]/subtitles/[trackId]/route");
const params = Promise.resolve({ id: "file-1", trackId: "track-1" });

function track(overrides: Record<string, unknown> = {}) {
  return {
    id: "track-1",
    language: "en",
    status: "ready",
    progress: 100,
    revision: 4,
    ...overrides,
  };
}

beforeEach(() => {
  state.track = track();
  state.size = { cueCount: 1, estimatedBytes: 100 };
  state.cues = [{ idx: 0, startMs: 0, endMs: 1000, text: "Hello" }];
  state.replacement = { ok: true, revision: 5 };
  vi.clearAllMocks();
});

describe("authenticated subtitle track route", () => {
  it("refuses oversized whole VTT instead of returning a truncated track", async () => {
    state.size = { cueCount: 20_001, estimatedBytes: 1_000_000 };

    const response = await route.GET(
      new NextRequest("http://localhost/api/files/file-1/subtitles/track-1"),
      { params }
    );
    const json = await response.json();

    expect(response.status).toBe(413);
    expect(json.code).toBe("SEGMENTED_SUBTITLE_REQUIRED");
    expect(json.cuesUrl).toContain("/cues");
    expect(calls.listCues).not.toHaveBeenCalled();
  });

  it("publishes the track revision with a complete VTT", async () => {
    const response = await route.GET(
      new NextRequest("http://localhost/api/files/file-1/subtitles/track-1"),
      { params }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-subtitle-revision")).toBe("4");
    expect(await response.text()).toContain("Hello");
  });

  it("requires a positive expected revision for a whole edit", async () => {
    const response = await route.PATCH(
      new NextRequest("http://localhost/api/files/file-1/subtitles/track-1", {
        method: "PATCH",
        body: JSON.stringify({ cues: [] }),
        headers: { "content-type": "application/json" },
      }),
      { params }
    );

    expect(response.status).toBe(400);
    expect(calls.replace).not.toHaveBeenCalled();
  });

  it("accepts arbitrary safe-integer timestamps and returns the new revision", async () => {
    const startMs = 40 * 24 * 60 * 60 * 1000;
    const response = await route.PATCH(
      new NextRequest("http://localhost/api/files/file-1/subtitles/track-1", {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: 4,
          cues: [{ startMs, endMs: startMs + 1000, text: "Late" }],
        }),
        headers: { "content-type": "application/json" },
      }),
      { params }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.revision).toBe(5);
    expect(calls.replace).toHaveBeenCalledWith(
      "track-1",
      4,
      expect.arrayContaining([expect.objectContaining({ startMs })])
    );
  });

  it("returns an explicit optimistic-lock conflict", async () => {
    state.replacement = { ok: false, reason: "revision_conflict" };
    const response = await route.PATCH(
      new NextRequest("http://localhost/api/files/file-1/subtitles/track-1", {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: 3,
          cues: [{ startMs: 0, endMs: 1000, text: "Changed" }],
        }),
        headers: { "content-type": "application/json" },
      }),
      { params }
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.code).toBe("SUBTITLE_REVISION_CONFLICT");
  });
});
