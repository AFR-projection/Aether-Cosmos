"use client";

import { useEffect, useRef } from "react";

/**
 * Measure one viewing, report it once.
 *
 * The metrics are the ones from PHASE 17 of the task, and they are separate on purpose: "video
 * lag" as a single number is exactly what made the original problem impossible to argue about.
 *
 *   startupMs      play requested → first `playing`. A slow control plane or a slow first byte.
 *   rebufferCount  `waiting` events AFTER playback started. Mid-film stalls, not startup.
 *   rebufferMs     total time spent in those stalls. With `watchedMs` this gives the ratio,
 *                  which is the only one of the three comparable between a clip and a film.
 *   seekCount      how much scrubbing this viewing did — the workload that used to be most
 *                  expensive, since every seek was a fresh authorization round trip.
 *   refreshCount   presigned URLs re-issued. Should be 0 for anything under two hours.
 *
 * Sent with `keepalive` rather than `sendBeacon`: the endpoint requires a CSRF header and
 * `sendBeacon` cannot set one. Fired on `pagehide` as well as unmount, because closing a tab
 * mid-film is the normal way a viewing ends and React never gets to clean up.
 *
 * Nothing identifying travels: no URL (it is a bearer capability), no token, no user-agent
 * string — only a coarse browser family.
 */

export type PlaybackTelemetrySource =
  "direct_r2" | "legacy_proxy" | "encrypted_blob";

/** Coarse family. Deliberately lossy: enough to spot "only Safari stalls", not a fingerprint. */
function browserFamily(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

type Meta = {
  enabled: boolean;
  fileId: string | null;
  source: PlaybackTelemetrySource;
  urlLatencyMs: number | null;
  refreshCount: number;
  errorCode: string | null;
};

type Counters = {
  playRequestedAt: number | null;
  startupMs: number | null;
  playingSince: number | null;
  watchedMs: number;
  waitingSince: number | null;
  rebufferCount: number;
  rebufferMs: number;
  seekCount: number;
  started: boolean;
};

function freshCounters(): Counters {
  return {
    playRequestedAt: null,
    startupMs: null,
    playingSince: null,
    watchedMs: 0,
    waitingSince: null,
    rebufferCount: 0,
    rebufferMs: 0,
    seekCount: 0,
    started: false,
  };
}

export function usePlaybackTelemetry(input: {
  /**
   * The element being measured, or `null` while none is mounted.
   *
   * The element itself rather than a ref, because a measurement belongs to one element: the
   * player is unmounted while an error message is showing, and a ref would hand this hook a
   * detached element to bind to. Passing the node makes the effect re-run when it is replaced.
   */
  video: HTMLVideoElement | null;
  /** A share page has no telemetry endpoint to post to; see the route's own note. */
  enabled: boolean;
  fileId: string | null;
  source: PlaybackTelemetrySource;
  urlLatencyMs: number | null;
  refreshCount: number;
  errorCode: string | null;
  /** Changing this ends the current measurement and starts a new one. */
  resetKey: string;
}): void {
  const metaRef = useRef<Meta>({
    enabled: input.enabled,
    fileId: input.fileId,
    source: input.source,
    urlLatencyMs: input.urlLatencyMs,
    refreshCount: input.refreshCount,
    errorCode: input.errorCode,
  });

  // Kept current through an effect rather than during render, so the listener effect below does
  // not have to re-attach every time a counter moves.
  useEffect(() => {
    metaRef.current = {
      enabled: input.enabled,
      fileId: input.fileId,
      source: input.source,
      urlLatencyMs: input.urlLatencyMs,
      refreshCount: input.refreshCount,
      errorCode: input.errorCode,
    };
  }, [
    input.enabled,
    input.fileId,
    input.source,
    input.urlLatencyMs,
    input.refreshCount,
    input.errorCode,
  ]);

  const video = input.video;
  const resetKey = input.resetKey;

  useEffect(() => {
    if (!video) return;

    const counters = freshCounters();
    let sent = false;

    const closeWatchWindow = (now: number) => {
      if (counters.playingSince !== null) {
        counters.watchedMs += now - counters.playingSince;
        counters.playingSince = null;
      }
    };

    const onPlay = () => {
      if (counters.playRequestedAt === null)
        counters.playRequestedAt = performance.now();
    };

    const onPlaying = () => {
      const now = performance.now();
      if (counters.startupMs === null && counters.playRequestedAt !== null) {
        counters.startupMs = now - counters.playRequestedAt;
      }
      if (counters.waitingSince !== null) {
        counters.rebufferMs += now - counters.waitingSince;
        counters.waitingSince = null;
      }
      counters.started = true;
      counters.playingSince = now;
    };

    const onWaiting = () => {
      const now = performance.now();
      closeWatchWindow(now);
      // A `waiting` before the first frame is startup, not a rebuffer. Counting it as both
      // would double-charge the one event everybody already notices.
      if (!counters.started) return;
      if (counters.waitingSince === null) {
        counters.waitingSince = now;
        counters.rebufferCount += 1;
      }
    };

    const onPause = () => closeWatchWindow(performance.now());
    const onEnded = () => closeWatchWindow(performance.now());
    const onSeeking = () => {
      counters.seekCount += 1;
    };

    const flush = () => {
      if (sent) return;
      const meta = metaRef.current;
      closeWatchWindow(performance.now());
      // Nothing happened: no play, no error. Reporting it would only dilute the percentiles
      // with previews somebody opened and closed.
      if (!meta.enabled) return;
      if (
        counters.watchedMs === 0 &&
        counters.startupMs === null &&
        !meta.errorCode
      )
        return;
      sent = true;

      const body = JSON.stringify({
        fileId: meta.fileId,
        source: meta.source,
        urlLatencyMs:
          meta.urlLatencyMs === null ? null : Math.round(meta.urlLatencyMs),
        startupMs:
          counters.startupMs === null ? null : Math.round(counters.startupMs),
        watchedMs: Math.round(counters.watchedMs),
        rebufferCount: counters.rebufferCount,
        rebufferMs: Math.round(counters.rebufferMs),
        seekCount: counters.seekCount,
        refreshCount: meta.refreshCount,
        errorCode: meta.errorCode,
        videoWidth: video.videoWidth || null,
        videoHeight: video.videoHeight || null,
        durationSeconds: Number.isFinite(video.duration)
          ? Math.round(video.duration)
          : null,
        platform: browserFamily(),
      });

      // Fire and forget, and never let a telemetry failure reach the user: the picture is the
      // product, this is a measurement of it.
      void (async () => {
        try {
          const csrf = await import("@/shared/api/client").then((m) =>
            m.getCsrfToken(),
          );
          await fetch("/api/playback/telemetry", {
            method: "POST",
            keepalive: true,
            headers: {
              "Content-Type": "application/json",
              "x-csrf-token": csrf,
            },
            body,
          });
        } catch {
          /* ignore */
        }
      })();
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("seeking", onSeeking);
    window.addEventListener("pagehide", flush);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("seeking", onSeeking);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [video, resetKey]);
}
