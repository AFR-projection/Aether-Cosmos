"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Scissors, Trash2, Undo2, ArrowDownUp, Play } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/feedback/spinner";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";
import { activeCueIndex, normalizeCues, shiftCues } from "@files/domain/services/subtitles/cues";
import { formatVttTimestamp, parseVtt, type SubtitleCue } from "@files/domain/services/subtitles/vtt";

/**
 * Correcting a subtitle track by hand.
 *
 * Machine subtitles are close and not right: a name misheard, a line that starts a beat late, two
 * utterances the recogniser ran together. Every one of those is a ten-second fix and none of them is
 * possible without an editor, which is why this exists rather than being left as "regenerate and
 * hope".
 *
 * It carries its own small video for the same reason the trim panel does: timing cannot be judged
 * from numbers. The playhead highlights the line currently on screen and clicking a line seeks to
 * it, so the loop is watch → hear the mistake → fix the line in front of you.
 *
 * Two decisions worth stating:
 *
 *  - **The track is saved whole, not line by line.** Splitting and merging change how many lines
 *    there are, so a per-line diff would have to reconcile two sets of indices. Sending the list
 *    makes what is on screen and what is stored the same object.
 *  - **The server normalises what it receives.** A line typed longer than its slot is given the
 *    time it needs, exactly as a generated one is (`normalizeCues` runs on both sides). The panel
 *    shows the result rather than pretending the raw numbers survived.
 */

export type SubtitleEditorPanelProps = {
  /** Same URL the viewer streams. The panel never fetches the video's bytes itself. */
  src: string;
  fileId: string;
  trackId: string;
  /** Where to read the current cues from, and where to save them. */
  vttUrl: string;
  /** A draft differs from what the server holds. Pass a STABLE function. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The track was saved; the caller re-reads so the player picks up the new text. */
  onSaved?: () => void;
};

type Draft = { startMs: number; endMs: number; text: string };

const CELL = "w-full rounded-md border border-border bg-surface px-1.5 py-1 text-xs tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40";

/** `"00:01:23.456"` → ms, for the two time cells. `null` when it is not a timestamp yet. */
function readClock(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]?\d):([0-5]?\d)(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, h, m, s, frac] = match;
  return (
    Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1_000 + (frac ? Number(frac.padEnd(3, "0")) : 0)
  );
}

export default function SubtitleEditorPanel({
  src,
  fileId,
  trackId,
  vttUrl,
  onDirtyChange,
  onSaved,
}: SubtitleEditorPanelProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cues, setCues] = useState<Draft[]>([]);
  /** The last saved state, for Undo and for deciding whether anything changed. */
  const [baseline, setBaseline] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [shiftSeconds, setShiftSeconds] = useState("0");

  const dirty = JSON.stringify(cues) !== JSON.stringify(baseline);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  /** Read the track through the same WebVTT the player uses, so there is one source of truth. */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(vttUrl, { credentials: "include" });
        if (!response.ok) throw new Error(String(response.status));
        const parsed = parseVtt(await response.text()).map(
          ({ startMs, endMs, text }): Draft => ({ startMs, endMs, text })
        );
        if (cancelled) return;
        setCues(parsed);
        setBaseline(parsed);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError(t("files.viewer.load.generic"));
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // `t` is deliberately out: a load that failed before the reader switched language still reads
    // in the language on screen, and re-running the fetch on a language change would be absurd.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vttUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setPlayheadMs(Math.round(video.currentTime * 1000));
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, []);

  const active = activeCueIndex(
    cues.map((cue, idx) => ({ idx, ...cue })),
    playheadMs
  );

  const patch = useCallback((index: number, next: Partial<Draft>) => {
    setCues((current) =>
      current.map((cue, position) => (position === index ? { ...cue, ...next } : cue))
    );
  }, []);

  const seekTo = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    void video.play().catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    // Normalised locally first so the list the user sees is the list that was sent — the server
    // applies the same pass, and showing them disagree would look like a failed save.
    const normalised = normalizeCues(cues.map((cue, idx) => ({ idx, ...cue })));
    const payload = normalised.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
    const result = await apiFetch<{ cueCount: number }>(
      `/api/files/${fileId}/subtitles/${trackId}`,
      { method: "PATCH", body: JSON.stringify({ cues: payload }) }
    );
    setSaving(false);
    if (!result.success) {
      setError(
        result.code === "SUBTITLE_BUSY"
          ? t("files.subtitles.editor.conflict")
          : (result.error ?? t("common.somethingWentWrong"))
      );
      return;
    }
    setCues(payload);
    setBaseline(payload);
    setSavedAt(Date.now());
    notify({ title: t("files.subtitles.toast.saved"), tone: "success" });
    onSaved?.();
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex shrink-0 items-center justify-center border-b border-border/40 bg-black p-2">
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          preload="metadata"
          className="max-h-48 w-auto rounded"
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {t("files.subtitles.editor.lines", { count: cues.length })}
        </p>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">{t("files.subtitles.editor.shift")}</span>
          <input
            type="number"
            step="0.1"
            value={shiftSeconds}
            onChange={(event) => setShiftSeconds(event.target.value)}
            aria-label={t("files.subtitles.editor.shiftHint")}
            title={t("files.subtitles.editor.shiftHint")}
            className={cn(CELL, "w-16")}
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const delta = Number(shiftSeconds) * 1000;
            if (!Number.isFinite(delta) || delta === 0) return;
            setCues((current) =>
              shiftCues(current.map((cue, idx) => ({ idx, ...cue })), delta).map(
                ({ startMs, endMs, text }) => ({ startMs, endMs, text })
              )
            );
          }}
        >
          {t("files.subtitles.editor.shiftApply")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setCues(baseline)} disabled={!dirty}>
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t("files.subtitles.editor.undo")}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? (
            <Spinner size="sm" />
          ) : savedAt > 0 && !dirty ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : null}
          {saving
            ? t("files.subtitles.editor.saving")
            : savedAt > 0 && !dirty
              ? t("files.subtitles.editor.saved")
              : t("files.subtitles.editor.save")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="shrink-0 border-b border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger-ink">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {cues.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("files.subtitles.editor.empty")}
          </p>
        )}
        {cues.map((cue, index) => (
          <div
            key={index}
            className={cn(
              "mb-1.5 flex items-start gap-2 rounded-lg border p-2 transition-colors",
              index === active ? "border-accent/40 bg-accent/5" : "border-border/40 bg-surface"
            )}
          >
            <div className="flex w-24 shrink-0 flex-col gap-1">
              <input
                defaultValue={formatVttTimestamp(cue.startMs)}
                aria-label={t("files.subtitles.editor.start")}
                className={CELL}
                onBlur={(event) => {
                  const ms = readClock(event.target.value);
                  if (ms === null) event.target.value = formatVttTimestamp(cue.startMs);
                  else patch(index, { startMs: ms });
                }}
              />
              <input
                defaultValue={formatVttTimestamp(cue.endMs)}
                aria-label={t("files.subtitles.editor.end")}
                className={CELL}
                onBlur={(event) => {
                  const ms = readClock(event.target.value);
                  if (ms === null) event.target.value = formatVttTimestamp(cue.endMs);
                  else patch(index, { endMs: ms });
                }}
              />
            </div>

            <textarea
              value={cue.text}
              onChange={(event) => patch(index, { text: event.target.value })}
              rows={2}
              aria-label={t("files.subtitles.editor.text")}
              className="min-h-0 flex-1 resize-y rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40"
            />

            <div className="flex shrink-0 flex-col gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("files.subtitles.editor.jump")}
                onClick={() => seekTo(cue.startMs)}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("files.subtitles.editor.split")}
                onClick={() => {
                  // Split at the midpoint of the cue's window, which is where a recogniser that
                  // ran two utterances together usually put the join.
                  const middle = Math.round((cue.startMs + cue.endMs) / 2);
                  setCues((current) => [
                    ...current.slice(0, index),
                    { startMs: cue.startMs, endMs: middle, text: cue.text },
                    { startMs: middle, endMs: cue.endMs, text: "" },
                    ...current.slice(index + 1),
                  ]);
                }}
              >
                <Scissors className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("files.subtitles.editor.add")}
                onClick={() =>
                  setCues((current) => [
                    ...current.slice(0, index + 1),
                    { startMs: cue.endMs, endMs: cue.endMs + 1_500, text: "" },
                    ...current.slice(index + 1),
                  ])
                }
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-danger-ink"
                aria-label={t("files.subtitles.editor.remove")}
                onClick={() => setCues((current) => current.filter((_, at) => at !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
