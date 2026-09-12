"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import { activeCueIndex, wrapCueText } from "@files/domain/services/subtitles/cues";
import { isRtlLanguage } from "@files/domain/services/subtitles/languages";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";
import {
  SUBTITLE_SIZE_SCALE,
  type SubtitlePrefs,
} from "@files/domain/services/subtitles/view-prefs";
import {
  cueWindowKey,
  fetchSubtitleCueWindow,
  SUBTITLE_WINDOW_AHEAD_MS,
  SUBTITLE_WINDOW_BEHIND_MS,
  SubtitleCueWindowCache,
  type SubtitleSource,
  type SubtitleTrack,
} from "@files/presentation/hooks/use-subtitle-tracks";

/**
 * The subtitle text, drawn over the picture.
 *
 * The browser can render a `<track>` on its own, and this does not let it — the track is set to
 * `hidden`, which loads and times the cues without displaying them, and the text is drawn here
 * instead. That is a deliberate trade with one reason behind it: `::cue` cannot be positioned or
 * sized consistently across browsers, and where a line sits and how big it is are the two things
 * that decide whether subtitles are comfortable to read. Native rendering also puts the text under
 * a fixed black box that covers more of the shot than it needs to.
 *
 * Everything else follows from drawing it ourselves:
 *
 *  - **The size is a share of the video's height, not a fixed pixel value.** A 42px line is
 *    enormous in a small preview and tiny at full screen. The container is measured, so entering
 *    fullscreen rescales the text with the picture instead of leaving it stranded.
 *  - **The text is re-wrapped for display.** `wrapCueText` balances a long line over two rather
 *    than leaving a full line and a stub, which is what a greedy wrap produces and what reads as a
 *    mistake.
 *  - **`pointer-events: none`.** The overlay sits above the video, and the video's click target is
 *    play/pause. A transparent box that swallowed that would be a bug nobody could describe.
 *
 * **Segmented delivery.** A whole-file track is fed to the browser as a `<track src>` and read from
 * the element's `activeCues`. A *segmented* track — anything past the whole-file cue cap — would
 * make the browser request a body the server refuses with 413, so it is never given a `<track>` at
 * all. Instead the cues for a sliding window around the playhead are fetched here, paged and cached,
 * and the same drawn text is fed by the window's active cue. The whole-file path and this path share
 * exactly one render function, so they cannot drift apart.
 */

export type SubtitleOverlayProps = {
  /** The element whose text tracks are read (whole-file tracks only). */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /**
   * `id` of the `<track>` to display, or `null` for off.
   *
   * Every other track is set to `disabled` so no second set of cues can arrive, and so the browser
   * stops fetching tracks nobody is watching. Ignored for segmented active tracks, which have no
   * `<track>` element to switch.
   */
  activeTrackId: string | null;
  /**
   * The track object for the active track, when known. `deliveryMode: "segmented"` sends the
   * overlay down the fetch-a-window path instead of reading a `<track>`.
   */
  activeTrack?: SubtitleTrack | null;
  /** Where to read cue windows from, when the active track is segmented. */
  subtitleSource?: SubtitleSource | null;
  /** Language of the active track, for `dir` and `lang`. */
  language: string | null;
  prefs: SubtitlePrefs;
};

const BACKDROP_CLASS = {
  none: "",
  // A blur rather than a flat fill: it lifts the text off whatever is behind it without hiding the
  // frame, which a solid bar does.
  soft: "bg-black/45 backdrop-blur-[2px]",
  solid: "bg-black/80",
} as const;

/** The cues in `window` that are on screen at `atMs`, flattened to lines. */
function linesFor(cues: SubtitleCue[], atMs: number): string {
  const index = activeCueIndex(cues, atMs);
  if (index < 0) return "";
  const lines: string[] = [];
  for (let i = index; i < cues.length; i += 1) {
    const cue = cues[i];
    // `activeCueIndex` returns the first cue the time is inside; walk forward while still inside.
    if (atMs < cue.startMs || atMs >= cue.endMs) break;
    if (cue.text.length > 0) lines.push(cue.text);
  }
  return lines.join("\n");
}

export function SubtitleOverlay({
  videoRef,
  activeTrackId,
  activeTrack,
  subtitleSource,
  language,
  prefs,
}: SubtitleOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [fontSize, setFontSize] = useState(0);

  const segmented =
    activeTrack?.deliveryMode === "segmented" && Boolean(subtitleSource);

  /**
   * Segmented cues: the window around the playhead, fetched and paged lazily.
   *
   * One controller per active segmented track; seeking aborts the in-flight fetch so a jump does not
   * show stale cues from before the jump. The cache holds a few windows keyed by (track, revision,
   * startMs), so scrubbing back reuses the earlier fetch instead of re-requesting.
   */
  const cacheRef = useRef<SubtitleCueWindowCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new SubtitleCueWindowCache();

  const windowState = useSegmentedCues(
    segmented ? activeTrack : null,
    subtitleSource ?? null,
    videoRef,
    cacheRef.current
  );

  // The whole-file path reads from the element's parsed `<track>`.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || segmented) {
      if (segmented) return;
      // No segmented track active: the segmented path owns no cues and the whole-file path
      // has none to read, so whatever was on screen is stale the moment either switches.
      const clear = requestAnimationFrame(() => setText(""));
      return () => cancelAnimationFrame(clear);
    }

    const tracks = video.textTracks;
    let active: TextTrack | null = null;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const isActive = activeTrackId !== null && track.id === activeTrackId;
      // `hidden` times the cues without drawing them; `disabled` stops the fetch entirely.
      track.mode = isActive ? "hidden" : "disabled";
      if (isActive) active = track;
    }

    if (!active) {
      const frame = requestAnimationFrame(() => setText(""));
      return () => cancelAnimationFrame(frame);
    }

    const read = () => {
      const cues = active?.activeCues;
      if (!cues || cues.length === 0) {
        setText("");
        return;
      }
      const lines: string[] = [];
      for (let index = 0; index < cues.length; index += 1) {
        const cue = cues[index] as VTTCue;
        if (typeof cue.text === "string" && cue.text.length > 0) lines.push(cue.text);
      }
      setText(lines.join("\n"));
    };

    active.addEventListener("cuechange", read);
    const frame = requestAnimationFrame(read);
    return () => {
      cancelAnimationFrame(frame);
      active?.removeEventListener("cuechange", read);
    };
  }, [videoRef, activeTrackId, segmented]);

  // Feed whichever path is active into `text`.
  useEffect(() => {
    if (!segmented) return;
    setText((previous) => (previous === windowState.text ? previous : windowState.text));
  }, [segmented, windowState.text]);

  /** Scale with the picture, so fullscreen does not leave the text at preview size. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height > 0) setFontSize(height * SUBTITLE_SIZE_SCALE[prefs.size]);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [prefs.size]);

  const wrapped = text.length > 0 ? wrapCueText(text) : "";

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-end"
    >
      {wrapped.length > 0 && (
        <div
          className="flex justify-center px-[6%]"
          style={{ paddingBottom: `${prefs.offset}%` }}
        >
          <p
            lang={language ?? undefined}
            // A line of Arabic that opens with a Latin name confuses `dir="auto"`, so the
            // language's own direction decides rather than the first strong character.
            dir={language && isRtlLanguage(language) ? "rtl" : "ltr"}
            className={cn(
              "max-w-[92%] whitespace-pre-line rounded-lg text-center font-semibold leading-tight text-white",
              // Not a token: this text is drawn over arbitrary video frames, never over a surface,
              // so it has no theme to inherit and needs its own contrast at every brightness.
              "[text-shadow:0_1px_3px_rgba(0,0,0,0.95),0_0_10px_rgba(0,0,0,0.7)]",
              prefs.backdrop !== "none" && "px-[0.6em] py-[0.25em]",
              BACKDROP_CLASS[prefs.backdrop]
            )}
            style={{ fontSize: fontSize > 0 ? `${fontSize}px` : undefined }}
          >
            {wrapped}
          </p>
        </div>
      )}
      {/*
        The cues again, for a screen reader. The visual copy is `aria-hidden` because its line
        breaks are layout: read aloud they turn one sentence into several. This copy is a live
        region with the breaks flattened, so a reader who cannot see the picture still follows the
        dialogue — and it is `sr-only` rather than absent, which is what an `aria-hidden` overlay
        alone would leave.
      */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {text.replace(/\n/g, " ")}
      </p>
    </div>
  );
}

/**
 * Drive an overlay from cue-window fetches around the playhead.
 *
 * Returns the flattened text for the cue currently on screen. The window is `BEHIND … AHEAD` around
 * the playhead where it was built; while the playhead stays inside it, time is served from the
 * fetched cues with no request at all. Once it leaves, a new window is fetched (paged to completion)
 * — from cache if that window was held before — and an in-flight fetch is aborted so a seek never
 * lands stale cues. `atMs` is sampled on `timeupdate` plus `seeked`, which covers a paused seek.
 *
 * The held window lives in a ref, not state: the only reader is the next `pull`, which runs from a
 * listener attached once per track and must see the latest cues, not the ones this closure was
 * created with.
 */
function useSegmentedCues(
  track: SubtitleTrack | null,
  source: SubtitleSource | null,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  cache: SubtitleCueWindowCache
) {
  const [text, setText] = useState("");
  const heldRef = useRef<{ builtAtMs: number; cues: SubtitleCue[] } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    heldRef.current = null;
    setText("");
    if (!track || !source) return;

    const pull = () => {
      const video = videoRef.current;
      if (!video) return;
      const atMs = Math.round(video.currentTime * 1000);
      const held = heldRef.current;
      // An empty window is still held: a stretch of film with no dialogue must not refetch
      // on every tick, and `linesFor` already returns "" for a window with no active cue.
      if (
        held &&
        atMs >= held.builtAtMs - SUBTITLE_WINDOW_BEHIND_MS &&
        atMs <= held.builtAtMs + SUBTITLE_WINDOW_AHEAD_MS
      ) {
        setText(linesFor(held.cues, atMs));
        return;
      }
      controllerRef.current?.abort();
      const next = new AbortController();
      controllerRef.current = next;
      const signal = next.signal;
      const startMs = Math.max(0, atMs - SUBTITLE_WINDOW_BEHIND_MS);
      const endMs = atMs + SUBTITLE_WINDOW_AHEAD_MS;
      const key = cueWindowKey(track, startMs);
      const done = (cues: SubtitleCue[]) => {
        if (signal.aborted) return;
        cache.set(key, cues);
        heldRef.current = { builtAtMs: atMs, cues };
        // The playhead can drift past the boundary that triggered this fetch while it is in
        // flight; drawing at the *current* time keeps a late window correct, and a playhead that
        // left the window entirely simply makes the next `timeupdate` refetch.
        const nowMs = Math.round((videoRef.current?.currentTime ?? atMs) * 1000);
        setText(linesFor(cues, nowMs));
      };
      const cached = cache.get(key);
      if (cached) {
        done(cached);
      } else {
        void fetchSubtitleCueWindow(source, track, startMs, endMs, signal)
          .then(done)
          .catch(() => {
            /* aborted on seek or superseded window; the next `timeupdate` retries. */
          });
      }
    };

    pull();
    const video = videoRef.current;
    video?.addEventListener("timeupdate", pull);
    // A paused seek (e.g. clicking the scrubber without playing) still moves the playhead.
    video?.addEventListener("seeked", pull);
    return () => {
      video?.removeEventListener("timeupdate", pull);
      video?.removeEventListener("seeked", pull);
      controllerRef.current?.abort();
    };
  }, [track, source, cache, videoRef]);

  return { text };
}
