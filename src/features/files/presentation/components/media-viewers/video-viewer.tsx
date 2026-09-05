"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Captions, Check, Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/feedback/spinner";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import { SUBTITLE_REFUSAL_KEYS } from "@files/domain/services/subtitles/eligibility";
import {
  subtitleLanguageLabel,
  UNDETERMINED_LANGUAGE,
} from "@files/domain/services/subtitles/languages";
import { SubtitleMenu } from "@files/presentation/components/subtitles/subtitle-menu";
import { SubtitleOverlay } from "@files/presentation/components/subtitles/subtitle-overlay";
import { SubtitleUploadDialog } from "@files/presentation/components/subtitles/subtitle-upload-dialog";
import { useSubtitleSelection } from "@files/presentation/hooks/use-subtitle-selection";
import {
  useSubtitleTracks,
  type SubtitleSource,
} from "@files/presentation/hooks/use-subtitle-tracks";
import { isTypingTarget, ViewerMessage } from "./viewer-chrome";

interface VideoViewerProps {
  src: string;
  fileName: string;
  /**
   * Where this player's subtitles come from, or `null` for none at all.
   *
   * A discriminated source rather than a set of flags: `{ kind: "share" }` has no `fileId` and
   * therefore nothing to generate, edit or delete against, so a share page physically cannot be
   * handed a mutation. `null` is for a surface that has not thought about subtitles yet.
   */
  subtitleSource?: SubtitleSource | null;
  /** Open the cue editor for a track. Absent means the editor is not reachable from here. */
  onEditSubtitles?: (trackId: string) => void;
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0
    ? `${h}:${mm}:${String(sec).padStart(2, "0")}`
    : `${mm}:${String(sec).padStart(2, "0")}`;
}

export function VideoViewer({
  src,
  fileName,
  subtitleSource = null,
  onEditSubtitles,
}: VideoViewerProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const subtitles = useSubtitleTracks(subtitleSource);
  const selection = useSubtitleSelection(subtitles.tracks);
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [speed, setSpeed] = useState(1);
  /** Wraps the CC popover; the button has its own ref, and an outside press must clear both. */
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const ccButtonRef = useRef<HTMLButtonElement | null>(null);

  const [playing, setPlaying] = useState(false);  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  /** play() rejects on autoplay policies and on a detached element — an
   *  unhandled rejection there used to surface as a console error and a play
   *  button stuck in the wrong state. */
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  }, []);

  // Playback state is mirrored from the element's own events, so the UI cannot
  // disagree with what the video is actually doing.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onDuration = () => setDuration(v.duration);
    const onBuffer = () => {
      if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onCanPlay = () => {
      setLoading(false);
      setLoadError(false);
    };
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onVolume = () => {
      setVolume(v.volume);
      setMuted(v.muted);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onDuration);
    v.addEventListener("durationchange", onDuration);
    v.addEventListener("progress", onBuffer);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("volumechange", onVolume);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onDuration);
      v.removeEventListener("durationchange", onDuration);
      v.removeEventListener("progress", onBuffer);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("volumechange", onVolume);
    };
  }, [retryKey]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
  }, []);

  // Bare media keys: never steal a keystroke from a field, and never fight a
  // browser shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          v.volume = Math.min(1, v.volume + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          v.volume = Math.max(0, v.volume - 0.1);
          break;
        case "m":
          v.muted = !v.muted;
          break;
        case "f":
          toggleFullscreen();
          break;
        case "c":
          // Every player cycles subtitles on `c`, and it is the only way to change them without
          // taking a hand off the keyboard mid-scene.
          selection.cycle();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, toggleFullscreen, selection]);

  /**
   * Show the chrome, and arrange for it to go away again.
   *
   * Only while playing: a paused video keeps its controls, because somebody who paused is looking
   * for a control. The menu being open also pins them — controls that faded out from under an open
   * popover would take the popover with them.
   */
  const revealControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused && !menuOpen) setShowControls(false);
    }, 2600);
  }, [menuOpen]);

  /**
   * Close the CC menu on a press anywhere else.
   *
   * `pointerdown` on the document rather than a blur handler: the menu holds a search field and
   * range inputs, so focus moves around inside it constantly, and a blur-based close would fight
   * every one of those.
   *
   * The CC button is excluded as well as the popover, and that is not redundant — the popover is no
   * longer a descendant of the button. Without it, `pointerdown` on the button would close the menu
   * and the `click` that follows would immediately reopen it, so the button could never close.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuAnchorRef.current?.contains(target)) return;
      if (ccButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  /** The same, for the playback-speed popover. */
  useEffect(() => {
    if (!speedOpen) return;
    const onDown = () => setSpeedOpen(false);
    // `click`, not `pointerdown`: the menu's own buttons act on click, and closing on pointerdown
    // would unmount them before their handler ran.
    document.addEventListener("click", onDown);
    return () => document.removeEventListener("click", onDown);
  }, [speedOpen]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;
  /** The chrome is up, or the video is not playing, or a menu is open — any of the three. */
  const chromeVisible = showControls || !playing || menuOpen;

  if (loadError) {
    return (
      <ViewerMessage
        icon={Play}
        tone="warning"
        title={t("files.viewer.media.videoFailed")}
        hint={t("files.viewer.media.codecHint")}
        onRetry={() => {
          setLoadError(false);
          setLoading(true);
          setRetryKey((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      // `video-stage` carries the cursor-hiding rule; `data-idle` is what turns it on. The picture
      // should be the only thing on screen once somebody has settled in to watch.
      className="video-stage relative flex h-full flex-col bg-black"
      data-idle={playing && !chromeVisible ? "true" : "false"}
      onMouseMove={revealControls}
      onMouseLeave={() => playing && setShowControls(false)}
      onTouchStart={revealControls}
      // Double-click anywhere on the stage is fullscreen, as it is in every player. The single-click
      // play toggle lives on the `<video>` itself, so the two do not fight over the same target.
      onDoubleClick={toggleFullscreen}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {loading && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        )}
        <video
          key={retryKey}
          ref={videoRef}
          src={src}
          className="max-h-full max-w-full"
          playsInline
          preload="auto"
          aria-label={fileName}
          onClick={togglePlay}
          onError={() => {
            setLoadError(true);
            setLoading(false);
          }}
        >
          {/*
            One `<track>` per ready track, and the overlay decides which is showing. `default` is
            deliberately absent: the browser would then draw its own captions under its own black
            box, which is the rendering `SubtitleOverlay` exists to replace.

            `key` includes the cue count so a track re-fetches after an edit — the element caches
            the parsed file, and a saved correction would otherwise keep playing the old text.
          */}
          {selection.ready.map((track) => (
            <track
              key={`${track.id}-${track.cueCount}`}
              id={track.id}
              kind="subtitles"
              src={subtitles.vttUrl(track.id)}
              srcLang={track.language}
              label={subtitleLanguageLabel(track.language)}
            />
          ))}
        </video>
      </div>

      {subtitleSource && (
        <SubtitleOverlay
          videoRef={videoRef}
          activeTrackId={selection.activeTrackId}
          language={selection.activeTrack?.language ?? null}
          prefs={selection.prefs}
        />
      )}

      {/*
        The paused state gets a real button, not a decoration.

        This used to be a `pointer-events-none` circle floating over the middle of the picture, which
        looked like a control and was not one — the only way to resume was to find the small button in
        the bar. Now it is the button, sized for a thumb, and it is gone the moment playback starts.
      */}
      {!playing && !loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            type="button"
            aria-label={t("files.viewer.media.play")}
            onClick={togglePlay}
            className={cn(
              "flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full",
              "bg-black/45 text-white ring-1 ring-white/20 backdrop-blur-md",
              "transition-[transform,background-color] duration-150 hover:bg-black/60",
              "motion-safe:hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            )}
          >
            <Play className="ml-1 h-8 w-8" fill="currentColor" aria-hidden="true" />
          </button>
        </div>
      )}

      <div
        className={cn(
          // Taller, softer gradient than before: it has to carry two rows of chrome without
          // putting a hard edge across the picture.
          "absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2 pt-14 sm:px-4",
          "transition-opacity duration-200",
          chromeVisible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <input
          type="range"
          // `media-scrub` makes it a hairline until somebody reaches for it — see globals.css.
          className="media-range media-scrub"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          disabled={duration === 0}
          aria-label={t("files.viewer.media.seek")}
          aria-valuetext={t("files.viewer.media.position", {
            current: formatTime(currentTime),
            total: formatTime(duration),
          })}
          style={{
            ["--pct" as string]: `${progress}%`,
            ["--buf" as string]: `${Math.max(bufferPct, progress)}%`,
          }}
          onChange={(e) => {
            const v = videoRef.current;
            if (v) v.currentTime = Number(e.target.value);
          }}
        />

        <div className="flex items-center gap-0.5 sm:gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            aria-label={t(playing ? "files.viewer.media.pause" : "files.viewer.media.play")}
            onClick={togglePlay}
          >
            {playing ? (
              <Pause className="h-5 w-5" fill="currentColor" aria-hidden="true" />
            ) : (
              <Play className="h-5 w-5" fill="currentColor" aria-hidden="true" />
            )}
          </Button>
          {/* The skip pair is the first thing to go on a narrow player: arrow keys do the same job
              and the time readout matters more than either of them. */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden text-white/75 hover:bg-white/10 hover:text-white sm:inline-flex"
            aria-label={t("files.viewer.media.back10")}
            onClick={() => seekBy(-10)}
          >
            <SkipBack className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden text-white/75 hover:bg-white/10 hover:text-white sm:inline-flex"
            aria-label={t("files.viewer.media.forward10")}
            onClick={() => seekBy(10)}
          >
            <SkipForward className="h-4 w-4" aria-hidden="true" />
          </Button>
          {/* `tabular-nums`, so the elapsed time does not shuffle the row every second. */}
          <span className="ml-1.5 select-none text-xs tabular-nums text-white/75">
            {formatTime(currentTime)}
            <span className="mx-1 text-white/35">/</span>
            {formatTime(duration)}
          </span>

          <span className="flex-1" />

          {/*
            Playback speed. Present because it is what people reach for on a lecture or a recording,
            and because a subtitle track being read at 1.5× is a real way this feature gets used.
          */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "min-w-[2.75rem] px-2 text-xs tabular-nums text-white/75 hover:bg-white/10 hover:text-white",
                speed !== 1 && "text-white"
              )}
              aria-label={t("files.viewer.media.speed")}
              aria-haspopup="menu"
              aria-expanded={speedOpen}
              onClick={() => setSpeedOpen((open) => !open)}
            >
              {speed}×
            </Button>
            {speedOpen && (
              <div
                role="menu"
                className="absolute bottom-full right-0 z-30 mb-3 w-24 overflow-hidden rounded-xl border border-white/10 bg-[#111214]/95 py-1 shadow-2xl backdrop-blur-xl motion-safe:animate-fade-in-scale origin-bottom-right"
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    role="menuitemradio"
                    aria-checked={speed === rate}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs tabular-nums transition-colors",
                      speed === rate
                        ? "bg-white/[0.16] text-white"
                        : "text-white/80 hover:bg-white/10 hover:text-white"
                    )}
                    onClick={() => {
                      const video = videoRef.current;
                      if (video) video.playbackRate = rate;
                      setSpeed(rate);
                      setSpeedOpen(false);
                    }}
                  >
                    <Check
                      className={cn("h-3.5 w-3.5", speed === rate ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    {rate}×
                  </button>
                ))}
              </div>
            )}
          </div>

          {subtitleSource && (
            <button
              ref={ccButtonRef}
              type="button"
              /*
                A proper CC control, not a generic icon button.

                Two things it says that the old one did not: the active language, in the label, so a
                closed menu still tells you what you are reading; and the underline bar every player
                uses for "captions are on" — a 2px rule under the glyph rather than a colour change,
                so it survives being colour-blind and being on a bright frame.
              */
              aria-label={t("files.subtitles.cc")}
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              aria-pressed={selection.activeTrackId !== null}
              onClick={() => {
                setSpeedOpen(false);
                setMenuOpen((open) => !open);
              }}
              className={cn(
                "relative flex h-9 items-center gap-1.5 rounded-lg px-2 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
                menuOpen ? "bg-white/[0.16] text-white" : "text-white/75 hover:bg-white/10 hover:text-white",
                selection.activeTrackId !== null && "text-white"
              )}
            >
              <Captions className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
              {selection.activeTrack && (
                <span className="text-[11px] font-semibold uppercase tracking-wide">
                  {selection.activeTrack.language === UNDETERMINED_LANGUAGE
                    ? "…"
                    : selection.activeTrack.language}
                </span>
              )}
              {/* The "on" bar. Inset so it tracks the button's width, label and all. */}
              {selection.activeTrackId !== null && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-1.5 bottom-1 h-0.5 rounded-full bg-white"
                />
              )}
              {/* A dot while work is outstanding, so a closed menu still says something is
                  happening. The `sr-only` text carries the same fact. */}
              {subtitles.pending && (
                <>
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" />
                  <span className="sr-only">{t("files.subtitles.status.queued")}</span>
                </>
              )}
            </button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="text-white/80 hover:bg-white/10 hover:text-white"
            aria-label={t(muted ? "files.viewer.media.unmute" : "files.viewer.media.mute")}
            aria-pressed={muted}
            onClick={() => {
              const v = videoRef.current;
              if (v) v.muted = !v.muted;
            }}
          >
            {muted ? (
              <VolumeX className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
          <input
            type="range"
            className="media-range w-20"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label={t("files.viewer.media.volume")}
            aria-valuetext={t("files.download.percentDone", {
              count: Math.round((muted ? 0 : volume) * 100),
            })}
            style={{ ["--pct" as string]: `${(muted ? 0 : volume) * 100}%` }}
            onChange={(e) => {
              const v = videoRef.current;
              const next = Number(e.target.value);
              if (v) {
                v.volume = next;
                v.muted = next === 0;
              }
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="text-white/80 hover:bg-white/10 hover:text-white"
            aria-label={t(
              fullscreen ? "files.preview.exitFullscreen" : "files.preview.fullscreen"
            )}
            onClick={toggleFullscreen}
          >
            {fullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>

      {/*
        The CC menu, positioned by the player rather than by itself.

        This box is the fix for the menu being clipped: it spans from just below the top edge of the
        stage to just above the control bar, so `max-h-full` on the menu inside it can never exceed
        the space that actually exists. Anchoring inside the control bar (which is what the first
        version did) let a tall menu grow past the top of a short player, where the preview modal’s
        own `overflow-hidden` sliced it off.

        It also sits inside the element that goes fullscreen, so the transition keeps it.
      */}
      {menuOpen && subtitleSource && (
        <div
          ref={menuAnchorRef}
          className="pointer-events-none absolute inset-x-3 bottom-[4.5rem] top-3 z-30 flex flex-col items-end justify-end sm:inset-x-4"
        >
          <SubtitleMenu
            tracks={subtitles.tracks}
            activeTrackId={selection.activeTrackId}
            onSelect={(trackId) => {
              selection.select(trackId);
              setMenuOpen(false);
            }}
            onGenerate={
              subtitles.readOnly
                ? undefined
                : async (language) => {
                    await subtitles.generate([language]);
                  }
            }
            onDelete={
              subtitles.readOnly
                ? undefined
                : async (trackId) => {
                    await subtitles.remove(trackId);
                  }
            }
            onAttach={
              subtitles.readOnly
                ? undefined
                : () => {
                    setMenuOpen(false);
                    setAttachOpen(true);
                  }
            }
            onEdit={
              subtitles.readOnly || !onEditSubtitles
                ? undefined
                : (trackId) => {
                    setMenuOpen(false);
                    onEditSubtitles(trackId);
                  }
            }
            canGenerate={subtitles.canGenerate}
            canTranslate={subtitles.canTranslate}
            refusalKey={
              /*
                One sentence, picked in the order the reader can act on it.

                The file's own problem comes first — no amount of server configuration fixes an
                encrypted file. Then the two server states, which are genuinely different advice:
                "not configured" means somebody has to paste a key, "queue" means the background
                worker is unreachable and there is nothing to do but start it or wait. The first
                version lumped those together, so a perfectly configured instance whose Redis was
                simply down told the user it had never been set up.
              */
              subtitles.refusal
                ? SUBTITLE_REFUSAL_KEYS[subtitles.refusal]
                : subtitles.readOnly
                  ? "files.subtitles.refusal.noPermission"
                  : subtitles.unavailable === "not-configured"
                    ? "files.subtitles.refusal.disabled"
                    : subtitles.unavailable === "queue"
                      ? "files.subtitles.refusal.queue"
                      : !subtitles.canTranslate
                        ? "files.subtitles.refusal.translateUnavailable"
                        : null
            }
            provider={subtitles.provider}
            remainingSeconds={subtitles.remainingSeconds}
            prefs={selection.prefs}
            onPrefsChange={selection.updatePrefs}
            onClose={() => setMenuOpen(false)}
            vttUrl={subtitles.vttUrl}
          />
        </div>
      )}

      {/*
        Rendered inside the player's own container so it survives the fullscreen transition — a
        dialog mounted on `document.body` would be left behind on the page underneath.
      */}
      {attachOpen && !subtitles.readOnly && (
        <SubtitleUploadDialog
          open
          onClose={() => setAttachOpen(false)}
          onAttach={subtitles.attach}
        />
      )}
    </div>
  );
}
