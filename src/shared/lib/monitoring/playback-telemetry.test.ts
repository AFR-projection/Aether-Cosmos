import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  playbackTelemetrySnapshot,
  recordPlaybackIssue,
  recordPlaybackSession,
  resetPlaybackTelemetry,
  type PlaybackIssueRecord,
  type PlaybackSessionRecord,
} from "@/shared/lib/monitoring/playback-telemetry";

/**
 * Playback telemetry must answer performance questions without becoming another playback hot
 * path or a store of bearer capabilities. These tests pin the bounded ring, nearest-rank
 * percentiles, time window and the deliberately small, privacy-safe record shape.
 */

const NOW = 1_700_000_000_000;

function issue(overrides: Partial<Omit<PlaybackIssueRecord, "at">> = {}) {
  recordPlaybackIssue({
    surface: "file",
    outcome: "issued",
    reason: null,
    status: 200,
    authMs: 2,
    permissionMs: 3,
    presignMs: 4,
    totalMs: 9,
    sizeBytes: 1_000_000,
    mimeType: "video/mp4",
    ...overrides,
  });
}

function session(overrides: Partial<Omit<PlaybackSessionRecord, "at">> = {}) {
  recordPlaybackSession({
    surface: "file",
    source: "direct_r2",
    fileId: "file-1",
    urlLatencyMs: 12,
    startupMs: 80,
    watchedMs: 10_000,
    rebufferCount: 0,
    rebufferMs: 0,
    seekCount: 0,
    refreshCount: 0,
    errorCode: null,
    videoWidth: 1920,
    videoHeight: 1080,
    durationSeconds: 120,
    platform: "chrome",
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetPlaybackTelemetry();
});

afterEach(() => {
  resetPlaybackTelemetry();
  vi.useRealTimers();
});

describe("playback telemetry rings", () => {
  it("keeps only the newest 200 issues and sessions", () => {
    for (let i = 0; i < 205; i += 1) {
      issue({ totalMs: i });
      session({ fileId: `file-${i}` });
    }

    const snapshot = playbackTelemetrySnapshot();
    expect(snapshot.issuance.total).toBe(200);
    expect(snapshot.playback.sessions).toBe(200);
    expect(snapshot.issuance.totalMs.max).toBe(204);
    expect(snapshot.recentSessions).toHaveLength(25);
    expect(snapshot.recentSessions[0].fileId).toBe("file-204");
    expect(snapshot.recentSessions[24].fileId).toBe("file-180");
  });

  it("drops records outside the requested window", () => {
    issue({ totalMs: 999 });
    session({ fileId: "old" });
    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    issue({ totalMs: 7 });
    session({ fileId: "recent" });

    const snapshot = playbackTelemetrySnapshot(60 * 60 * 1000);
    expect(snapshot.issuance.total).toBe(1);
    expect(snapshot.issuance.totalMs.max).toBe(7);
    expect(snapshot.playback.sessions).toBe(1);
    expect(snapshot.recentSessions.map((record) => record.fileId)).toEqual([
      "recent",
    ]);
  });
});

describe("playbackTelemetrySnapshot", () => {
  it("uses nearest-rank percentiles over actual samples", () => {
    for (let value = 1; value <= 20; value += 1) {
      issue({
        authMs: value,
        permissionMs: value,
        presignMs: value,
        totalMs: value,
      });
    }

    const summary = playbackTelemetrySnapshot().issuance.totalMs;
    expect(summary).toEqual({ count: 20, p50: 10, p95: 19, max: 20 });
  });

  it("returns an honest empty summary instead of zero latency", () => {
    const snapshot = playbackTelemetrySnapshot();
    expect(snapshot.issuance.totalMs).toEqual({
      count: 0,
      p50: null,
      p95: null,
      max: null,
    });
    expect(snapshot.playback.startupMs).toEqual({
      count: 0,
      p50: null,
      p95: null,
      max: null,
    });
    expect(snapshot.playback.rebufferRatio).toBeNull();
  });

  it("aggregates refusal reasons, sources, errors and weighted rebuffer ratio", () => {
    issue({ outcome: "refused", reason: "encrypted", status: 409 });
    issue({ outcome: "error", reason: null, status: 503 });
    session({ watchedMs: 1_000, rebufferMs: 100, errorCode: "media:network" });
    session({ source: "legacy_proxy", watchedMs: 9_000, rebufferMs: 0 });

    const snapshot = playbackTelemetrySnapshot();
    expect(snapshot.issuance.reasons).toEqual({ encrypted: 1, status_503: 1 });
    expect(snapshot.playback.bySource).toEqual({
      direct_r2: 1,
      legacy_proxy: 1,
    });
    expect(snapshot.playback.errorCodes).toEqual({ "media:network": 1 });
    expect(snapshot.playback.totalWatchedMs).toBe(10_000);
    expect(snapshot.playback.rebufferRatio).toBe(0.01);
  });

  it("never exposes a URL, token, cookie, IP address or full user agent field", () => {
    session();
    const [record] = playbackTelemetrySnapshot().recentSessions;
    const keys = Object.keys(record).sort();

    expect(keys).toEqual([
      "at",
      "durationSeconds",
      "errorCode",
      "fileId",
      "platform",
      "rebufferCount",
      "rebufferMs",
      "refreshCount",
      "seekCount",
      "source",
      "startupMs",
      "surface",
      "urlLatencyMs",
      "videoHeight",
      "videoWidth",
      "watchedMs",
    ]);
    expect(JSON.stringify(record)).not.toMatch(
      /presigned|token|cookie|ipAddress|userAgent|https?:\/\//i,
    );
  });
});
