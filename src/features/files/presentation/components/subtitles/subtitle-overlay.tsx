"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import { wrapCueText } from "@files/domain/services/subtitles/cues";
import { isRtlLanguage } from "@files/domain/services/subtitles/languages";
import {
  SUBTITLE_SIZE_SCALE,
  type SubtitlePrefs,
} from "@files/domain/services/subtitles/view-prefs";

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
 */

export type SubtitleOverlayProps = {
  /** The element whose text tracks are read. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /**
   * `id` of the `<track>` to display, or `null` for off.
   *
   * Every other track is set to `disabled` so no second set of cues can arrive, and so the browser
   * stops fetching tracks nobody is watching.
   */
  activeTrackId: string | null;
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

export function SubtitleOverlay({
  videoRef,
  activeTrackId,
  language,
  prefs,
}: SubtitleOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [fontSize, setFontSize] = useState(0);

  /**
   * Follow the active track's cues.
   *
   * Re-runs when the chosen track changes, which is also what switches every other track off. The
   * first read is deferred to an animation frame rather than done in the effect body: setting
   * `mode` is what makes the browser parse the file, so there is nothing to read yet, and a
   * synchronous state write here is what the React Compiler rules forbid anyway.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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
  }, [videoRef, activeTrackId]);

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
