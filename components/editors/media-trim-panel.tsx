"use client";

/**
 * Cut a video or audio file down to a single window, without leaving the preview.
 *
 * The trim is a *stream copy* — the streams are remuxed, never re-encoded — which is why
 * it is fast, why the container cannot change, and why the cut lands on the nearest
 * keyframe before the mark rather than exactly on it. That last part is stated in the UI
 * instead of hidden, because a user who asked for 3.2 s and got 3.0 s deserves to know
 * the reason rather than think the tool is inaccurate.
 *
 * Unlike the image editor this cannot answer synchronously: `PUT /api/files/edit` takes a
 * version snapshot and queues the work, so a successful request means *queued*, and the
 * panel says so rather than pretending the file has already changed.
 *
 * A video also gets "Extract audio", which is a different kind of operation living in the
 * same place: `POST /api/files/extract-audio` re-encodes the soundtrack into a NEW file and
 * never touches this one, so it is offered whether or not a trim is pending.
 */

import { useEffect, useId, useRef, useState } from "react";
import { AudioLines, Check, Loader2, Music, Scissors, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import {
  clampTrimWindow,
  containerExtensionFor,
  formatClock,
  MIN_TRIM_SECONDS,
  trimError,
  type TrimWindow,
} from "@/lib/files/media-edit";
import { notify } from "@/lib/system/notify-store";

interface MediaTrimPanelProps {
  /** Same URL the viewer streams; the panel never fetches the bytes itself. */
  src: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  /**
   * A window narrower than the clip is waiting to be sent. The preview modal needs this
   * to stop a backdrop click from discarding it. Pass a STABLE function.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** A trim, or an audio extraction, was accepted onto the queue. The caller re-reads. */
  onQueued?: () => void;
}

/** Handle granularity. Also the arrow-key step, since the input is a real range. */
const STEP_SECONDS = 0.1;

/**
 * One trim handle: a labelled range plus a "set to the playhead" shortcut.
 *
 * A real `<input type="range">` rather than a custom rail, so the handle is announced as a
 * slider, arrow keys move it by `STEP_SECONDS`, and Home/End reach the ends for free.
 */
function TrimRow({
  label,
  value,
  max,
  disabled,
  onChange,
  onSetFromPlayhead,
}: {
  label: string;
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (seconds: number) => void;
  onSetFromPlayhead: () => void;
}) {
  const id = useId();
  const pct = max > 0 ? (Math.min(value, max) / max) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[11px] font-medium text-muted-foreground">
          {label}
        </label>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] text-foreground">{formatClock(value)}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={onSetFromPlayhead}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
          >
            Set here
          </button>
        </div>
      </div>
      <input
        id={id}
        type="range"
        className="media-range"
        data-surface="light"
        min={0}
        max={Math.max(max, STEP_SECONDS)}
        step={STEP_SECONDS}
        value={Math.min(value, max)}
        disabled={disabled}
        aria-valuetext={`${label} at ${formatClock(value)}`}
        style={{ ["--pct" as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default function MediaTrimPanel({
  src,
  fileId,
  fileName,
  mimeType,
  onDirtyChange,
  onQueued,
}: MediaTrimPanelProps) {
  const isVideo = mimeType.startsWith("video/");
  // The route refuses a container a stream copy cannot write back, so say so up front
  // rather than after the request.
  const container = containerExtensionFor(mimeType);

  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  /** Playback started from "Play selection", so it should stop at the out point. */
  const previewingRef = useRef(false);

  const [duration, setDuration] = useState<number | null>(null);
  const [clip, setClip] = useState<TrimWindow>({ startSeconds: 0, endSeconds: 0 });
  const [playhead, setPlayhead] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** The audio extraction is its own request and its own outcome — see `extractAudio`. */
  const [extracting, setExtracting] = useState(false);
  const [audioQueued, setAudioQueued] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  const dirty =
    !queued &&
    duration !== null &&
    (clip.startSeconds > 0.05 || clip.endSeconds < duration - 0.05);
  const invalid = duration === null ? "Waiting for the clip to load." : trimError(clip, duration);
  const length = Math.max(0, clip.endSeconds - clip.startSeconds);

  /**
   * The dirty callback is reached through a ref so a caller passing an inline arrow cannot
   * make the unmount cleanup fire on every render — which would clear the parent's
   * unsaved-changes guard while the trim was still being set up.
   */
  const dirtyCallbackRef = useRef(onDirtyChange);
  useEffect(() => {
    dirtyCallbackRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => () => dirtyCallbackRef.current?.(false), []);
  useEffect(() => {
    dirtyCallbackRef.current?.(dirty);
  }, [dirty]);

  const setStart = (seconds: number) => {
    setError(null);
    setClip((current) =>
      clampTrimWindow({ startSeconds: seconds, endSeconds: current.endSeconds }, duration)
    );
  };

  const setEnd = (seconds: number) => {
    setError(null);
    setClip((current) =>
      clampTrimWindow({ startSeconds: current.startSeconds, endSeconds: seconds }, duration)
    );
  };

  const playSelection = () => {
    const element = mediaRef.current;
    if (!element) return;
    element.currentTime = clip.startSeconds;
    previewingRef.current = true;
    void element.play().catch(() => {
      previewingRef.current = false;
    });
  };

  const reset = () => {
    setError(null);
    if (duration !== null) setClip({ startSeconds: 0, endSeconds: duration });
  };

  /**
   * Queue the trim.
   *
   * A `200` here means the job is on the queue, not that the file has changed — the worker
   * does the remux. The panel stops offering the button afterwards instead of letting a
   * second identical job overwrite the first one's output.
   */
  const submit = async () => {
    if (duration === null || submitting || queued) return;
    const refusal = trimError(clip, duration);
    if (refusal) {
      setError(refusal);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ queued: boolean }>("/api/files/edit", {
        method: "PUT",
        body: JSON.stringify({
          fileId,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
        }),
      });
      if (!res.success) {
        setError(res.error ?? "The trim couldn't be queued.");
        return;
      }
      setQueued(true);
      notify({
        title: "Trim queued",
        description: `${fileName} is being cut to ${formatClock(length)}. The previous version is kept.`,
        tone: "success",
      });
      onQueued?.();
    } catch {
      setError("The trim couldn't be sent. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Queue the audio extraction.
   *
   * A separate route from the trim because it makes a NEW file rather than rewriting this
   * one — the video is left exactly as it is, so this is offered independently of whether
   * a trim is pending and never touches the unsaved-changes guard. Offered once: a second
   * press would produce a second identical file, not a better one.
   */
  const extractAudio = async () => {
    if (extracting || audioQueued) return;
    setExtracting(true);
    setAudioError(null);
    try {
      const res = await apiFetch<{ queued: boolean }>("/api/files/extract-audio", {
        method: "POST",
        body: JSON.stringify({ fileId }),
      });
      if (!res.success) {
        setAudioError(res.error ?? "The audio couldn't be extracted.");
        return;
      }
      setAudioQueued(true);
      notify({
        title: "Extracting audio",
        description: `The soundtrack of ${fileName} will appear as a new file in this folder.`,
        tone: "success",
      });
      onQueued?.();
    } catch {
      setAudioError("The request couldn't be sent. Check your connection and try again.");
    } finally {
      setExtracting(false);
    }
  };

  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const element = event.currentTarget;
    // A live or badly muxed stream reports `Infinity`; without a length there is nothing
    // to trim against, so the panel says so rather than sending a window it invented.
    const value = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null;
    setDuration(value);
    setLoadFailed(false);
    if (value !== null) setClip({ startSeconds: 0, endSeconds: value });
  };

  const handleTimeUpdate = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const element = event.currentTarget;
    setPlayhead(element.currentTime);
    // Only a selection preview stops at the out point. Scrubbing past it with the native
    // controls is the user asking to hear what is being cut, not a mistake to correct.
    if (previewingRef.current && element.currentTime >= clip.endSeconds) {
      element.pause();
      previewingRef.current = false;
    }
  };

  const startPct = duration ? (clip.startSeconds / duration) * 100 : 0;
  const lengthPct = duration ? (length / duration) * 100 : 0;
  const playheadPct = duration ? (Math.min(playhead, duration) / duration) * 100 : 0;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-viewer-stage p-4">
        {loadFailed ? (
          <p role="alert" className="max-w-xs text-center text-sm text-white/70">
            This file couldn’t be loaded for trimming. Close the editor and try the preview
            again.
          </p>
        ) : isVideo ? (
          <video
            ref={mediaRef}
            src={src}
            controls
            playsInline
            preload="metadata"
            className="max-h-full max-w-full rounded-lg"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onError={() => setLoadFailed(true)}
          />
        ) : (
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-5 text-center">
            <Music className="mx-auto h-8 w-8 text-white/50" />
            <p className="mt-2 truncate text-sm text-white/80" title={fileName}>
              {fileName}
            </p>
            <audio
              ref={mediaRef}
              src={src}
              controls
              preload="metadata"
              className="mt-4 w-full"
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onError={() => setLoadFailed(true)}
            />
          </div>
        )}
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-border/60 bg-card p-4 lg:w-72 lg:border-l lg:border-t-0">
        <section>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Trim
            </h3>
            <span className="font-mono text-[11px] text-foreground">
              {duration === null ? "—" : formatClock(length)}
            </span>
          </div>

          {container === null ? (
            <p className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-2.5 py-2 text-[11px] leading-relaxed text-warning-ink">
              A trim copies the streams into the same kind of container, and this format has
              none to copy into. Convert it first, then trim the copy.
            </p>
          ) : (
            <>
              <div aria-hidden className="relative mt-3 h-1.5 rounded-full bg-border">
                <div
                  className="absolute inset-y-0 rounded-full bg-accent"
                  style={{ left: `${startPct}%`, width: `${lengthPct}%` }}
                />
                <div
                  className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-foreground/70"
                  style={{ left: `${playheadPct}%` }}
                />
              </div>

              <div className="mt-3 space-y-3">
                <TrimRow
                  label="Start"
                  value={clip.startSeconds}
                  max={duration ?? 0}
                  disabled={duration === null || queued}
                  onChange={setStart}
                  onSetFromPlayhead={() => setStart(playhead)}
                />
                <TrimRow
                  label="End"
                  value={clip.endSeconds}
                  max={duration ?? 0}
                  disabled={duration === null || queued}
                  onChange={setEnd}
                  onSetFromPlayhead={() => setEnd(playhead)}
                />
              </div>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  disabled={duration === null}
                  onClick={playSelection}
                >
                  Play selection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!dirty || queued}
                  onClick={reset}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  Reset
                </Button>
              </div>
            </>
          )}
        </section>

        {isVideo ? (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Audio track
            </h3>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2 w-full"
              disabled={extracting || audioQueued}
              onClick={extractAudio}
            >
              {extracting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : audioQueued ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <AudioLines className="h-3.5 w-3.5" />
              )}
              {audioQueued ? "Audio queued" : "Extract audio"}
            </Button>
            {audioError ? (
              <p role="alert" className="mt-2 text-[11px] leading-relaxed text-danger-ink">
                {audioError}
              </p>
            ) : audioQueued ? (
              <p role="status" className="mt-2 text-[11px] leading-relaxed text-success-ink">
                Being extracted in the background. Refresh the folder in a moment to see it.
              </p>
            ) : (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Saves the soundtrack as a new MP3 beside this video and leaves the video
                alone. A video with no audio track produces nothing.
              </p>
            )}
          </section>
        ) : null}

        <section className="mt-auto space-y-2 border-t border-border/60 pt-4">
          <dl className="space-y-1 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Clip length</dt>
              <dd className="font-mono text-muted-foreground">
                {duration === null ? "—" : formatClock(duration)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Keeping</dt>
              <dd className="font-mono text-foreground">
                {formatClock(clip.startSeconds)} → {formatClock(clip.endSeconds)}
              </dd>
            </div>
          </dl>

          {error ? (
            <p role="alert" className="text-[11px] leading-relaxed text-danger-ink">
              {error}
            </p>
          ) : queued ? (
            <p role="status" className="text-[11px] leading-relaxed text-success-ink">
              The cut is running in the background. Reopen the preview in a moment to see the
              result.
            </p>
          ) : dirty && invalid ? (
            <p role="status" className="text-[11px] leading-relaxed text-warning-ink">
              {invalid}
            </p>
          ) : null}

          <Button
            className="w-full"
            disabled={invalid !== null || submitting || queued || container === null}
            onClick={submit}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : queued ? (
              <Check className="h-4 w-4" />
            ) : (
              <Scissors className="h-4 w-4" />
            )}
            {queued ? "Trim queued" : "Trim"}
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The streams are copied rather than re-encoded, so the quality is untouched but
            each mark lands on the nearest keyframe at or before it — the result can be a
            fraction of a second wider than the handles. Shortest clip {MIN_TRIM_SECONDS}s.
            The file is replaced and the previous version kept.
          </p>
        </section>
      </aside>
    </div>
  );
}
