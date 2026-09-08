"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetchWithStatus } from "@/shared/api/client";
import type { TranslationKey } from "@/shared/lib/i18n";
import {
  isPlaybackUrlStale,
  refreshDelayMs,
} from "@/shared/lib/media/playback-policy";
import {
  classifyRefusal,
  issuanceFailureAction,
} from "@files/domain/services/playback-recovery";
import type { PlaybackErrorCode } from "@files/domain/services/playback-recovery";
export type { PlaybackErrorCode };

/**
 * Where a video's bytes come from, decided once per viewing.
 *
 * The whole architecture change lives behind this hook. It performs ONE authenticated request —
 * the control plane — and what comes back is a presigned R2 URL that the browser then uses for
 * every range request and every seek without the app in the middle. Before this, each of those
 * range requests paid a session lookup, a permission query and a bandwidth row update.
 *
 * It also owns the two things that make a bearer URL usable for a two-hour film:
 *
 *   - a refresh timer that re-issues before the signature dies, so playback does not stop
 *     mid-scene when the expiry passes;
 *   - a `visibilitychange` check, because `setTimeout` is throttled in a background tab and the
 *     deadline can pass unnoticed while somebody has the video playing in another window.
 *
 * And one safety property: if the new path fails with a server error or a transport error, it
 * falls back to the legacy proxy URL. A 403/404/415 is NOT a fallback case — the proxy would
 * refuse identically, so falling back would only turn one honest refusal into a broken player.
 */

export type PlaybackTarget =
  { kind: "file"; fileId: string } | { kind: "share"; token: string };

export type PlaybackDelivery = "direct_r2" | "legacy_proxy";

/**
 * One sentence and one piece of advice per refusal.
 *
 * Here rather than in the viewer because the codes are defined here, and the pairing is the
 * whole point of PHASE 18: "video gagal diputar" for all ten of these is what makes a share
 * link that ran out of views indistinguishable from a codec the browser cannot decode.
 */
export const PLAYBACK_ERROR_KEYS: Record<
  PlaybackErrorCode,
  { title: TranslationKey; hint: TranslationKey }
> = {
  unauthorized: {
    title: "files.playback.error.unauthorized",
    hint: "files.playback.hint.unauthorized",
  },
  "not-found": {
    title: "files.playback.error.notFound",
    hint: "files.playback.hint.notFound",
  },
  "not-ready": {
    title: "files.playback.error.notReady",
    hint: "files.playback.hint.notReady",
  },
  unsupported: {
    title: "files.playback.error.unsupported",
    hint: "files.playback.hint.unsupported",
  },
  quota: {
    title: "files.playback.error.quota",
    hint: "files.playback.hint.quota",
  },
  "rate-limited": {
    title: "files.playback.error.rateLimited",
    hint: "files.playback.hint.rateLimited",
  },
  "share-expired": {
    title: "files.playback.error.shareExpired",
    hint: "files.playback.hint.shareExpired",
  },
  "share-exhausted": {
    title: "files.playback.error.shareExhausted",
    hint: "files.playback.hint.shareExhausted",
  },
  server: {
    title: "files.playback.error.server",
    hint: "files.playback.hint.server",
  },
  network: {
    title: "files.playback.error.network",
    hint: "files.playback.hint.network",
  },
};

type PlaybackResponse = {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
  mimeType: string;
  sizeBytes: number;
  version: number;
};

export type PlaybackSourceState = {
  /** The URL to hand the media element, or null while it is being decided. */
  url: string | null;
  expiresAtMs: number | null;
  delivery: PlaybackDelivery;
  loading: boolean;
  /** Set only when there is no usable URL at all; a fallback is not an error. */
  errorCode: PlaybackErrorCode | null;
  /** Control-plane latency of the first successful issuance, for telemetry. */
  urlLatencyMs: number | null;
  refreshCount: number;
  /** Re-issue now. Safe to call from a media `error` handler; a no-op for the proxy path. */
  refresh: () => void;
};

function endpointFor(target: PlaybackTarget): string {
  return target.kind === "file"
    ? `/api/files/${target.fileId}/playback-url`
    : `/api/shared/${target.token}/playback-url`;
}

function targetKey(target: PlaybackTarget): string {
  return target.kind === "file"
    ? `file:${target.fileId}`
    : `share:${target.token}`;
}

/**
 * A failed re-issue is retried a few times before the player is told anything is wrong. The
 * count of how many — and whether a refusal is worth the legacy proxy at all — is decided in
 * `@files/domain/services/playback-recovery`, where it is tested on its own.
 */
const REFRESH_RETRY_MS = 15_000;

type Internal = {
  url: string | null;
  expiresAtMs: number | null;
  delivery: PlaybackDelivery;
  loading: boolean;
  errorCode: PlaybackErrorCode | null;
  urlLatencyMs: number | null;
  refreshCount: number;
};

export function usePlaybackSource(input: {
  target: PlaybackTarget | null;
  /** The proxy URL: the fallback on a server error, and the source when direct playback is off. */
  fallbackUrl: string | null;
  /**
   * Skip the control plane entirely. True for an encrypted file (whose bytes are ciphertext and
   * are decrypted in the browser) and when the operator has pinned `playbackMode` to the proxy.
   */
  bypass?: boolean;
}): PlaybackSourceState {
  const { target, fallbackUrl, bypass = false } = input;
  const enabled = !bypass && target !== null;
  const endpoint = target ? endpointFor(target) : null;
  const key = target ? targetKey(target) : null;

  const [state, setState] = useState<Internal>({
    url: null,
    expiresAtMs: null,
    delivery: "direct_r2",
    loading: true,
    errorCode: null,
    urlLatencyMs: null,
    refreshCount: 0,
  });

  const issueRef = useRef<((isRefresh: boolean) => void) | null>(null);
  const refresh = useCallback(() => issueRef.current?.(true), []);

  useEffect(() => {
    if (!enabled || !endpoint) {
      issueRef.current = null;
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentExpiry: number | null = null;
    let failedRefreshes = 0;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = (expiresAtMs: number | null) => {
      clearTimer();
      const delay = refreshDelayMs({ expiresAtMs, nowMs: Date.now() });
      if (delay === null) return;
      timer = setTimeout(() => void issue(true), delay);
    };

    const issue = async (isRefresh: boolean) => {
      const startedAt = performance.now();
      let status = 0;
      let code: string | undefined;
      let data: PlaybackResponse | undefined;

      try {
        const response = await apiFetchWithStatus<PlaybackResponse>(endpoint);
        status = response.status;
        code = response.body.code;
        data = response.body.success ? response.body.data : undefined;
      } catch {
        // Transport failure, or a body that was not JSON at all (an nginx error page).
        status = 0;
      }
      if (cancelled) return;

      if (data?.url) {
        const issued = data;
        const parsed = Date.parse(issued.expiresAt);
        const expiresAtMs = Number.isFinite(parsed) ? parsed : null;
        const latencyMs = performance.now() - startedAt;
        currentExpiry = expiresAtMs;
        failedRefreshes = 0;
        setState((prev) => ({
          url: issued.url,
          expiresAtMs,
          delivery: "direct_r2",
          loading: false,
          errorCode: null,
          // The FIRST issuance is the startup cost worth reporting; a mid-film re-issue is a
          // different event and would otherwise pollute the p95 that matters.
          urlLatencyMs: isRefresh ? prev.urlLatencyMs : latencyMs,
          refreshCount: isRefresh ? prev.refreshCount + 1 : prev.refreshCount,
        }));
        schedule(expiresAtMs);
        return;
      }

      const errorCode = classifyRefusal(status, code);
      const action = issuanceFailureAction({
        refusalCode: code ?? null,
        isRefresh,
        // Counts this failure too; the budget check in the module compares against that.
        attempts: isRefresh ? failedRefreshes + 1 : failedRefreshes,
        errorCode,
        hasFallbackUrl: Boolean(fallbackUrl),
      });

      /**
       * The operator pinned playback back onto the proxy.
       *
       * Not an error and not a retry: the answer is the same until somebody changes the setting,
       * so the timer stays cleared and nothing is said to the reader. This is the rollback path
       * from PHASE 23 — it works on a tab that was already open when the switch was flipped.
       */
      if (action === "proxy") {
        clearTimer();
        currentExpiry = null;
        setState((prev) => ({
          ...prev,
          url: fallbackUrl,
          expiresAtMs: null,
          delivery: "legacy_proxy",
          loading: false,
          errorCode: null,
        }));
        return;
      }

      // A failed RE-issue must not tear down a URL that still works: the refresh margin means
      // there is time left, so retry quietly and let the media element keep playing.
      if (action === "retry") {
        failedRefreshes += 1;
        clearTimer();
        timer = setTimeout(() => void issue(true), REFRESH_RETRY_MS);
        return;
      }

      if (action === "fallback") {
        // The new path broke; the old one is slower but works. Nothing is said to the reader,
        // because from their side the video simply plays.
        clearTimer();
        currentExpiry = null;
        setState((prev) => ({
          ...prev,
          url: fallbackUrl,
          expiresAtMs: null,
          delivery: "legacy_proxy",
          loading: false,
          errorCode: null,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        url: null,
        expiresAtMs: null,
        loading: false,
        errorCode,
      }));
      clearTimer();
    };

    /**
     * `setTimeout` is throttled in a background tab, so a two-hour deadline can pass while the
     * video plays in another window. Coming back into view is the moment to check.
     */
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (isPlaybackUrlStale({ expiresAtMs: currentExpiry, nowMs: Date.now() }))
        void issue(true);
    };

    issueRef.current = (isRefresh: boolean) => void issue(isRefresh);
    document.addEventListener("visibilitychange", onVisibility);
    void issue(false);

    return () => {
      cancelled = true;
      clearTimer();
      issueRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `key` is in the list so switching to a different file re-issues; `endpoint` is derived
    // from it and both are listed because the linter cannot see that.
  }, [enabled, endpoint, key, fallbackUrl]);

  if (!enabled) {
    return {
      url: fallbackUrl,
      expiresAtMs: null,
      delivery: "legacy_proxy",
      loading: false,
      errorCode: null,
      urlLatencyMs: null,
      refreshCount: 0,
      refresh,
    };
  }

  return { ...state, refresh };
}
