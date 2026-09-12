"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_SUBTITLE_PREFS,
  loadSubtitlePrefs,
  saveSubtitlePrefs,
  type SubtitlePrefs,
} from "@files/domain/services/subtitles/view-prefs";
import { type SubtitleTrack } from "./use-subtitle-tracks";

/**
 * Which subtitle track is showing, and remembering that between videos.
 *
 * The interesting part is that "nothing chosen yet" and "deliberately off" are different states,
 * and collapsing them is the bug this hook exists to avoid. A remembered language should turn
 * itself on when the next video happens to have that track — that is what makes the feature feel
 * like a setting rather than a chore — but pressing Off has to stay off, and an explicit choice has
 * to survive the track list being refetched a second later by the poll.
 *
 * So the selection is tri-state: `"auto"` resolves against the stored preference every render, and
 * an explicit `{ trackId }` overrides it. Derived rather than synced into state, so there is no
 * effect racing the fetch — and nothing for the React Compiler rules to object to.
 *
 * Preferences are read once with a lazy initialiser: `localStorage` is not available during SSR,
 * and reading it in an effect would flash the default first.
 */

type Selection = "auto" | { trackId: string | null };

export function useSubtitleSelection(tracks: SubtitleTrack[]) {
  const [prefs, setPrefs] = useState<SubtitlePrefs>(() =>
    typeof window === "undefined" ? DEFAULT_SUBTITLE_PREFS : loadSubtitlePrefs()
  );
  const [selection, setSelection] = useState<Selection>("auto");

  const ready = useMemo(
    () => tracks.filter((track) => track.status === "ready" && track.cueCount > 0),
    [tracks]
  );

  /**
   * The track to show.
   *
   * In `auto`, the stored language decides — and only if a *ready* track exists for it. A
   * remembered language never starts new work: that costs money, and spending it because of a
   * preference is exactly the surprise this feature must not spring.
   */
  const activeTrackId = useMemo(() => {
    if (selection !== "auto") {
      // An explicit choice, checked against what still exists: a track deleted from the menu
      // must not leave the overlay pointing at it.
      const chosen = selection.trackId;
      return chosen && ready.some((track) => track.id === chosen) ? chosen : null;
    }
    if (!prefs.enabled || !prefs.language) return null;
    // Prefer a translation over a transcript in the same language: if both exist, the translated
    // one is the one somebody asked for.
    const match =
      ready.find((track) => track.language === prefs.language && track.origin === "translated") ??
      ready.find((track) => track.language === prefs.language);
    return match?.id ?? null;
  }, [selection, ready, prefs.enabled, prefs.language]);

  const activeTrack = ready.find((track) => track.id === activeTrackId) ?? null;

  /** Choose a track, or `null` for off. Both are remembered for the next video. */
  const select = useCallback(
    (trackId: string | null) => {
      setSelection({ trackId });
      const chosen = trackId ? tracks.find((track) => track.id === trackId) : null;
      const next: Partial<SubtitlePrefs> = chosen
        ? { enabled: true, language: chosen.language }
        : { enabled: false };
      saveSubtitlePrefs(next);
      setPrefs((current) => ({
        ...current,
        ...next,
        // `saveSubtitlePrefs` clears the stored language when disabling, so the in-memory copy has
        // to agree — otherwise this session would keep auto-selecting after an explicit Off.
        ...(next.enabled === false ? { language: null } : {}),
      }));
    },
    [tracks]
  );

  const updatePrefs = useCallback((next: Partial<SubtitlePrefs>) => {
    saveSubtitlePrefs(next);
    setPrefs((current) => ({ ...current, ...next }));
  }, []);

  /**
   * Step through Off → first track → next → Off, for the `c` key.
   *
   * A single key that cycles is what every other player does, and it is the only way to change
   * subtitles without taking a hand off the keyboard mid-scene.
   */
  const cycle = useCallback(() => {
    if (ready.length === 0) return;
    const at = ready.findIndex((track) => track.id === activeTrackId);
    const next = at + 1 >= ready.length ? null : ready[at + 1].id;
    select(next);
  }, [ready, activeTrackId, select]);

  return { prefs, updatePrefs, activeTrackId, activeTrack, ready, select, cycle };
}
