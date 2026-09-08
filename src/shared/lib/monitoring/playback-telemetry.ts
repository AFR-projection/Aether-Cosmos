/**
 * Playback observability, in process and on purpose.
 *
 * The audit that led to this file found no playback metrics at all, which is why "video is
 * laggy" could only ever be argued about. What is recorded here is the smallest set that
 * answers the questions people actually ask: how long did authorization take, how long until
 * the picture moved, how often did it stop, and on which file.
 *
 * Deliberately NOT in Postgres. The whole point of the direct-R2 change is to get Aiven out of
 * the playback path, and a write per playback event would walk it straight back in. This is a
 * bounded in-memory ring: it dies with the container, and that is an acceptable trade for a
 * single-node deployment whose question is always "what happened in the last hour". Persisting
 * it is a separate decision with a separate cost.
 *
 * Nothing sensitive is stored. Never add: the presigned URL (it is a bearer capability), the
 * share token (same), the session cookie, an IP address, or anything read out of the file.
 */

/** Ring size. ~200 sessions is a busy evening on this deployment and a few hundred KB. */
const MAX_SAMPLES = 200;

export type PlaybackSurface = "file" | "share";
export type PlaybackSource = "direct_r2" | "legacy_proxy" | "encrypted_blob";

/** Server-side timings for one playback-URL issuance. */
export type PlaybackIssueRecord = {
  at: number;
  surface: PlaybackSurface;
  outcome: "issued" | "refused" | "error";
  /** Refusal reason or error class. Never a message containing user input. */
  reason: string | null;
  status: number;
  authMs: number;
  permissionMs: number;
  presignMs: number;
  totalMs: number;
  sizeBytes: number | null;
  mimeType: string | null;
};

/** What the player reports once, when it is done. */
export type PlaybackSessionRecord = {
  at: number;
  surface: PlaybackSurface;
  source: PlaybackSource;
  fileId: string | null;
  /** Control plane: request sent → playback URL in hand. */
  urlLatencyMs: number | null;
  /** Play requested → first `playing` event. Null when playback never started. */
  startupMs: number | null;
  watchedMs: number;
  rebufferCount: number;
  rebufferMs: number;
  seekCount: number;
  refreshCount: number;
  errorCode: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  durationSeconds: number | null;
  /** Coarse family only ("chrome", "safari", …). Never the full user-agent string. */
  platform: string | null;
};

const issues: PlaybackIssueRecord[] = [];
const sessions: PlaybackSessionRecord[] = [];

function push<T>(ring: T[], value: T): void {
  ring.push(value);
  if (ring.length > MAX_SAMPLES) ring.splice(0, ring.length - MAX_SAMPLES);
}

export function recordPlaybackIssue(
  record: Omit<PlaybackIssueRecord, "at">,
): void {
  push(issues, { ...record, at: Date.now() });
}

export function recordPlaybackSession(
  record: Omit<PlaybackSessionRecord, "at">,
): void {
  push(sessions, { ...record, at: Date.now() });
}

/**
 * Percentile over a small sample, nearest-rank.
 *
 * Nearest-rank rather than interpolated because these samples are latencies of real requests
 * and a p95 that is a number nobody experienced is harder to reason about than one that is.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function summarize(values: number[]) {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  };
}

export type PlaybackTelemetrySnapshot = ReturnType<
  typeof playbackTelemetrySnapshot
>;

/**
 * Everything the admin surface needs, already aggregated.
 *
 * The metric definitions are fixed here rather than left to whoever reads the numbers, because
 * "video lag" as a single figure is what made the original problem un-diagnosable. Startup and
 * rebuffer are different failures with different causes, and the rebuffer RATIO is the only one
 * of the three that is comparable between a 30-second clip and a two-hour film.
 */
export function playbackTelemetrySnapshot(windowMs = 60 * 60 * 1000) {
  const since = Date.now() - windowMs;
  const recentIssues = issues.filter((i) => i.at >= since);
  const recentSessions = sessions.filter((s) => s.at >= since);

  const issued = recentIssues.filter((i) => i.outcome === "issued");
  const watched = recentSessions.filter((s) => s.watchedMs > 0);
  const totalWatchedMs = watched.reduce((sum, s) => sum + s.watchedMs, 0);
  const totalRebufferMs = watched.reduce((sum, s) => sum + s.rebufferMs, 0);

  const reasons: Record<string, number> = {};
  for (const record of recentIssues) {
    if (record.outcome === "issued") continue;
    const key = record.reason ?? `status_${record.status}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }

  const errorCodes: Record<string, number> = {};
  for (const record of recentSessions) {
    if (!record.errorCode) continue;
    errorCodes[record.errorCode] = (errorCodes[record.errorCode] ?? 0) + 1;
  }

  const bySource: Record<string, number> = {};
  for (const record of recentSessions) {
    bySource[record.source] = (bySource[record.source] ?? 0) + 1;
  }

  return {
    windowMs,
    issuance: {
      total: recentIssues.length,
      issued: issued.length,
      refused: recentIssues.filter((i) => i.outcome === "refused").length,
      errors: recentIssues.filter((i) => i.outcome === "error").length,
      reasons,
      /** End to end inside the route: auth + permission + presign. */
      totalMs: summarize(issued.map((i) => i.totalMs)),
      authMs: summarize(issued.map((i) => i.authMs)),
      permissionMs: summarize(issued.map((i) => i.permissionMs)),
      presignMs: summarize(issued.map((i) => i.presignMs)),
    },
    playback: {
      sessions: recentSessions.length,
      bySource,
      /** Frontend request → URL in hand. The control plane as the browser sees it. */
      urlLatencyMs: summarize(
        recentSessions
          .map((s) => s.urlLatencyMs)
          .filter((v): v is number => v !== null),
      ),
      /** Play requested → first `playing`. */
      startupMs: summarize(
        recentSessions
          .map((s) => s.startupMs)
          .filter((v): v is number => v !== null),
      ),
      rebufferCount: summarize(recentSessions.map((s) => s.rebufferCount)),
      rebufferMs: summarize(recentSessions.map((s) => s.rebufferMs)),
      /**
       * Rebuffer ratio, aggregated over watch time rather than averaged over sessions: one
       * badly stalling two-hour film matters more than ten clean ten-second clips, and a
       * per-session mean would say the opposite.
       */
      rebufferRatio:
        totalWatchedMs > 0 ? totalRebufferMs / totalWatchedMs : null,
      totalWatchedMs,
      seekCount: summarize(recentSessions.map((s) => s.seekCount)),
      refreshCount: summarize(recentSessions.map((s) => s.refreshCount)),
      errorCodes,
    },
    recentSessions: recentSessions.slice(-25).reverse(),
  };
}

/** Test seam, and the reset an operator gets after changing something. */
export function resetPlaybackTelemetry(): void {
  issues.length = 0;
  sessions.length = 0;
}
