"use client";

/**
 * What the viewer remembers about subtitles between videos.
 *
 * The stored *language* is the load-bearing one. "Turn subtitles on and they appear" only feels
 * automatic the second time if the choice outlives the file being closed — so opening another
 * video with a ready track in that language turns it on without being asked. It never starts a new
 * transcription on its own: that costs money, and spending it because of a remembered preference is
 * exactly the surprise this feature must not produce.
 *
 * Turning subtitles off forgets the language too. Keeping it would mean "off" lasted until the next
 * video and no further, which is not what off means.
 *
 * Stored under `subtitles:*` beside `files:*`, and read through the same SSR-safe helpers as
 * `../view-prefs.ts`. Every value is re-validated on the way out: these keys are user-writable, and
 * an offset from a hand-edited entry reaches the CSS that positions the overlay.
 */

import { isSubtitleLanguage } from "./languages";

const SIZE_KEY = "subtitles:size";
const BACKDROP_KEY = "subtitles:backdrop";
const OFFSET_KEY = "subtitles:offset";
const LANGUAGE_KEY = "subtitles:language";
const ENABLED_KEY = "subtitles:enabled";

const SIZES = ["sm", "md", "lg", "xl"] as const;
export type SubtitleTextSize = (typeof SIZES)[number];

const BACKDROPS = ["none", "soft", "solid"] as const;
export type SubtitleBackdrop = (typeof BACKDROPS)[number];

/** Percent of the video's height. Past this the text starts covering the picture's centre. */
export const SUBTITLE_OFFSET_MAX = 40;

export type SubtitlePrefs = {
  size: SubtitleTextSize;
  backdrop: SubtitleBackdrop;
  /** Distance from the bottom edge, as a percentage of the video's height. */
  offset: number;
  /** Language to turn on when a video has a ready track in it. `null` means none chosen. */
  language: string | null;
  enabled: boolean;
};

export const DEFAULT_SUBTITLE_PREFS: SubtitlePrefs = {
  size: "md",
  // A soft backdrop is the default because subtitles are read over moving pictures: white text on
  // a bright frame is unreadable, and a solid bar covers more of the shot than it needs to.
  backdrop: "soft",
  offset: 8,
  language: null,
  enabled: false,
};

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage full / blocked — ignore */
  }
}

/** An offset forced back inside the picture, with a floor and a fallback. */
export function clampSubtitleOffset(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SUBTITLE_PREFS.offset;
  return Math.min(SUBTITLE_OFFSET_MAX, Math.max(0, Math.round(value)));
}

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

export function loadSubtitlePrefs(): SubtitlePrefs {
  const language = read(LANGUAGE_KEY);
  const offset = read(OFFSET_KEY);
  return {
    size: oneOf(read(SIZE_KEY), SIZES, DEFAULT_SUBTITLE_PREFS.size),
    backdrop: oneOf(read(BACKDROP_KEY), BACKDROPS, DEFAULT_SUBTITLE_PREFS.backdrop),
    offset: offset === null ? DEFAULT_SUBTITLE_PREFS.offset : clampSubtitleOffset(Number(offset)),
    // A tag this build does not carry is discarded rather than passed to `<track srclang>`.
    language: language && isSubtitleLanguage(language) ? language : null,
    enabled: read(ENABLED_KEY) === "1",
  };
}

/**
 * Store whichever preferences were given, leaving the rest alone.
 *
 * Turning subtitles off clears the remembered language in the same write, so the two can never
 * disagree — an `enabled: false` with a language still stored would turn itself back on.
 */
export function saveSubtitlePrefs(prefs: Partial<SubtitlePrefs>): void {
  if (prefs.size) write(SIZE_KEY, prefs.size);
  if (prefs.backdrop) write(BACKDROP_KEY, prefs.backdrop);
  if (prefs.offset !== undefined) write(OFFSET_KEY, String(clampSubtitleOffset(prefs.offset)));
  if (prefs.language !== undefined) write(LANGUAGE_KEY, prefs.language ?? "");
  if (prefs.enabled !== undefined) {
    write(ENABLED_KEY, prefs.enabled ? "1" : "0");
    if (!prefs.enabled) write(LANGUAGE_KEY, "");
  }
}

/** The overlay's font size for each choice, as a share of the video's height. */
export const SUBTITLE_SIZE_SCALE: Record<SubtitleTextSize, number> = {
  sm: 0.032,
  md: 0.042,
  lg: 0.055,
  xl: 0.07,
};
