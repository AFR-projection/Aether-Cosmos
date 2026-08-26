"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/system/spinner";
import { cn } from "@/lib/utils";
import { isTypingTarget, ViewerMessage } from "./viewer-chrome";

interface VideoViewerProps {
  src: string;
  fileName: string;
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

export function VideoViewer({ src, fileName }: VideoViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
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
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, toggleFullscreen]);

  function revealControls() {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowControls(false);
    }, 3000);
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  if (loadError) {
    return (
      <ViewerMessage
        icon={Play}
        tone="warning"
        title="Video cannot be played"
        hint="This browser may not support the file's codec. Downloading and playing it locally usually works."
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
      className="relative flex h-full flex-col bg-black"
      onMouseMove={revealControls}
      onMouseLeave={() => playing && setShowControls(false)}
      onTouchStart={revealControls}
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
        />
      </div>

      {!playing && !loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/20 backdrop-blur-md">
            <Play className="ml-1 h-8 w-8 text-white" fill="white" aria-hidden="true" />
          </span>
        </div>
      )}

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-4 pb-3 pt-10",
          "transition-opacity duration-300",
          showControls ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <input
          type="range"
          className="media-range mb-1"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          disabled={duration === 0}
          aria-label="Seek"
          aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
          style={{
            ["--pct" as string]: `${progress}%`,
            ["--buf" as string]: `${Math.max(bufferPct, progress)}%`,
          }}
          onChange={(e) => {
            const v = videoRef.current;
            if (v) v.currentTime = Number(e.target.value);
          }}
        />

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {playing ? (
              <Pause className="h-4 w-4" fill="white" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" fill="white" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Back 10 seconds"
            onClick={() => seekBy(-10)}
          >
            <SkipBack className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Forward 10 seconds"
            onClick={() => seekBy(10)}
          >
            <SkipForward className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span className="font-mono text-xs text-white/80">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <span className="flex-1" />

          <Button
            variant="ghost"
            size="icon"
            className="text-white/80 hover:bg-white/10 hover:text-white"
            aria-label={muted ? "Unmute" : "Mute"}
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
            aria-label="Volume"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent`}
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
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
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
    </div>
  );
}
