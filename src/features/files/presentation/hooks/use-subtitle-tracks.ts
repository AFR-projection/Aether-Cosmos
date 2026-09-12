"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/shared/api/client";
import type { SubtitleRefusal } from "@files/domain/services/subtitles/eligibility";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";

/**
 * A file's subtitle tracks, kept current while any of them is still being made.
 *
 * Two sources, one hook. An authenticated viewer reads `/api/files/:id/subtitles` and may generate,
 * attach and delete; a public share link reads `/api/shared/:token/subtitles` and may do none of
 * those. Modelling that as a discriminated `source` rather than as flags means the share page
 * cannot accidentally be handed a mutation — there is nothing to call.
 *
 * The polling is the part worth explaining. A finished track arrives as a realtime event, and the
 * viewer subscribes to those; this interval is the fallback for when it does not — a dropped SSE
 * connection, a second device, a tab that was asleep. It only runs while something is actually
 * pending, so an idle video makes no requests at all.
 */

export type SubtitleSource =
  | { kind: "file"; fileId: string; canEdit: boolean }
  | { kind: "share"; token: string };

export type SubtitleTrack = {
  id: string;
  language: string;
  origin: "asr" | "translated" | "uploaded";
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  cueCount: number;
  translatedFromId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  /** Absent on older servers, which continue to deliver one native WebVTT file. */
  deliveryMode?: "whole" | "segmented";
  /** Opaque version used to invalidate cue caches and reject stale editor saves. */
  revision?: string | number | null;
  /** Server-measured length, when supplied. */
  duration?: number | null;
  durationSeconds?: number | null;
};

export type SubtitleCuePage = {
  cues: SubtitleCue[];
  nextCursor: string | null;
  revision?: string | number | null;
};

export const SUBTITLE_WINDOW_BEHIND_MS = 15_000;
export const SUBTITLE_WINDOW_AHEAD_MS = 45_000;
export const SUBTITLE_WINDOW_MS =
  SUBTITLE_WINDOW_BEHIND_MS + SUBTITLE_WINDOW_AHEAD_MS;
const SUBTITLE_PAGE_LIMIT = 500;
const SUBTITLE_CACHE_LIMIT = 6;

/** A bounded interval cache, exported so pagination/eviction behavior can be unit-tested. */
export class SubtitleCueWindowCache {
  readonly #limit: number;
  readonly #entries = new Map<string, SubtitleCue[]>();

  constructor(limit = SUBTITLE_CACHE_LIMIT) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  get(key: string): SubtitleCue[] | undefined {
    const cues = this.#entries.get(key);
    if (!cues) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, cues);
    return cues;
  }

  set(key: string, cues: SubtitleCue[]): void {
    this.#entries.delete(key);
    this.#entries.set(key, cues);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

export function cueWindowKey(track: SubtitleTrack, startMs: number): string {
  return `${track.id}:${String(track.revision ?? "legacy")}:${startMs}`;
}

function cuesPath(
  source: SubtitleSource,
  trackId: string,
  startMs: number,
  endMs: number,
  cursor?: string
): string {
  // The cue-window route lives at `<trackId>/cues`, not on the track route itself: the track
  // route answers whole WebVTT (or 413 for segmented tracks), never JSON.
  const root = `${basePath(source)}/${trackId}/cues`;
  const query = new URLSearchParams({
    startMs: String(startMs),
    endMs: String(endMs),
    limit: String(SUBTITLE_PAGE_LIMIT),
  });
  if (cursor) query.set("cursor", cursor);
  return `${root}?${query.toString()}`;
}

/** Read every cursor page for one bounded playhead interval. */
export async function fetchSubtitleCueWindow(
  source: SubtitleSource,
  track: SubtitleTrack,
  startMs: number,
  endMs: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<SubtitleCue[]> {
  const cues: SubtitleCue[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await fetchImpl(
      cuesPath(source, track.id, startMs, endMs, cursor),
      { credentials: "include", signal }
    );
    if (!response.ok) throw new Error(`Subtitle cue request failed (${response.status})`);
    const body = (await response.json()) as {
      success?: boolean;
      data?: SubtitleCuePage;
      cues?: SubtitleCue[];
      nextCursor?: string | null;
      error?: string;
    };
    const page = body.data ?? body;
    if (body.success === false || !Array.isArray(page.cues)) {
      throw new Error(body.error ?? "Invalid subtitle cue response");
    }
    cues.push(...page.cues);
    const next = page.nextCursor ?? null;
    if (next && seen.has(next)) throw new Error("Subtitle cursor repeated");
    if (next) seen.add(next);
    cursor = next ?? undefined;
  } while (cursor);

  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Why the SERVER cannot make a track, as distinct from why the FILE cannot have one.
 *
 * `"queue"` means the background worker is unreachable — normal on a dev box with
 * `REDIS_DISABLED=true`. Knowing which of the two it is decides which sentence the menu shows, and
 * showing the right one is the difference between "set this up" and "wait a minute".
 */
export type SubtitleUnavailable = "not-configured" | "queue";

type TracksResponse = {
  tracks: SubtitleTrack[];
  canGenerate?: boolean;
  canTranslate?: boolean;
  refusal?: SubtitleRefusal | null;
  unavailable?: SubtitleUnavailable | null;
  remainingSeconds?: number | null;
  provider?: string;
};

/** How often to re-read while work is outstanding. Fast enough to feel live, slow enough to ignore. */
const POLL_MS = 4_000;

function basePath(source: SubtitleSource): string {
  return source.kind === "file"
    ? `/api/files/${source.fileId}/subtitles`
    : `/api/shared/${source.token}/subtitles`;
}

export function useSubtitleTracks(source: SubtitleSource | null) {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [canGenerate, setCanGenerate] = useState(false);
  const [canTranslate, setCanTranslate] = useState(false);
  const [refusal, setRefusal] = useState<SubtitleRefusal | null>(null);
  const [unavailable, setUnavailable] = useState<SubtitleUnavailable | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [provider, setProvider] = useState<string>("");
  const [loading, setLoading] = useState(Boolean(source));
  const [error, setError] = useState<string | null>(null);

  const path = source ? basePath(source) : null;

  const refetch = useCallback(async () => {
    if (!path) return;
    const result = await apiFetch<TracksResponse>(path);
    if (!result.success || !result.data) {
      setError(result.error ?? "load-failed");
      setLoading(false);
      return;
    }
    const data = result.data;
    setTracks(data.tracks);
    setCanGenerate(Boolean(data.canGenerate));
    setCanTranslate(Boolean(data.canTranslate));
    setRefusal(data.refusal ?? null);
    setUnavailable(data.unavailable ?? null);
    setRemainingSeconds(data.remainingSeconds ?? null);
    setProvider(data.provider ?? "");
    setError(null);
    setLoading(false);
  }, [path]);

  useEffect(() => {
    if (!path) return;
    void refetch();
  }, [path, refetch]);

  /**
   * Whether anything is still being made. Drives the poll, and is also what the menu shows a
   * progress line for.
   */
  const pending = useMemo(
    () => tracks.some((track) => track.status === "queued" || track.status === "processing"),
    [tracks]
  );

  useEffect(() => {
    if (!pending || !path) return;
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, path, refetch]);

  const mutable = source?.kind === "file" ? source : null;

  /**
   * Ask for one or more languages.
   *
   * The server works out whether that means a transcription, a translation, or nothing at all — see
   * the POST handler. The caller gets back only whether the request was accepted, because "queued"
   * and "already there" are the same outcome from the menu's point of view.
   */
  const generate = useCallback(
    async (languages: string[]): Promise<{ ok: true } | { ok: false; error?: string; code?: string }> => {
      if (!mutable) return { ok: false, code: "READ_ONLY" };
      const result = await apiFetch<{ queued: boolean; tracks: SubtitleTrack[] }>(
        `/api/files/${mutable.fileId}/subtitles`,
        { method: "POST", body: JSON.stringify({ targets: languages }) }
      );
      if (!result.success || !result.data) return { ok: false, error: result.error, code: result.code };
      setTracks(result.data.tracks);
      return { ok: true };
    },
    [mutable]
  );

  const remove = useCallback(
    async (trackId: string): Promise<boolean> => {
      if (!mutable) return false;
      const result = await apiFetch<{ deleted: boolean }>(
        `/api/files/${mutable.fileId}/subtitles/${trackId}`,
        { method: "DELETE" }
      );
      if (!result.success) return false;
      // Removed locally as well as refetched: the menu is open, and waiting a round trip to see a
      // row disappear reads as the button not having worked.
      setTracks((current) => current.filter((track) => track.id !== trackId));
      return true;
    },
    [mutable]
  );

  /**
   * Attach an `.srt`/`.vtt` the user already has.
   *
   * Multipart, so `apiFetch` must not set a Content-Type — the boundary is the browser's to write.
   */
  const attach = useCallback(
    async (
      file: File,
      language: string
    ): Promise<{ ok: true; cueCount: number } | { ok: false; error?: string; code?: string }> => {
      if (!mutable) return { ok: false, code: "READ_ONLY" };
      const form = new FormData();
      form.append("file", file);
      form.append("language", language);
      const result = await apiFetch<{ trackId: string; cueCount: number }>(
        `/api/files/${mutable.fileId}/subtitles/upload`,
        { method: "POST", body: form }
      );
      if (!result.success || !result.data) return { ok: false, error: result.error, code: result.code };
      await refetch();
      return { ok: true, cueCount: result.data.cueCount };
    },
    [mutable, refetch]
  );

  /** The URL a `<track src>` points at, for either source. */
  const vttUrl = useCallback(
    (trackId: string) => (path ? `${path}/${trackId}` : ""),
    [path]
  );

  return {
    tracks,
    pending,
    canGenerate,
    canTranslate,
    refusal,
    unavailable,
    remainingSeconds,
    provider,
    loading,
    error,
    refetch,
    generate,
    remove,
    attach,
    vttUrl,
    readOnly: mutable === null,
  };
}
