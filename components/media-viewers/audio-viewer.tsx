"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Music, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/system/spinner";
import { isTypingTarget, ViewerMessage } from "./viewer-chrome";

interface AudioViewerProps {
  src: string;
  fileName: string;
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Audio playback. Deliberately without a waveform: the previous one was
 * `Math.sin()` — an animation that looked like data about the track while
 * describing nothing. Position is shown by the scrubber and the timecodes,
 * which are real.
 */
export function AudioViewer({ src, fileName }: AudioViewerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setPlaying(false));
    else a.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(a.duration)) return;
    a.currentTime = Math.min(Math.max(0, a.currentTime + delta), a.duration);
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrentTime(a.currentTime);
    const onDuration = () => setDuration(a.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onCanPlay = () => {
      setLoading(false);
      setLoadError(false);
    };
    const onWaiting = () => setLoading(true);
    const onVolume = () => {
      setVolume(a.volume);
      setMuted(a.muted);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onDuration);
    a.addEventListener("durationchange", onDuration);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("canplay", onCanPlay);
    a.addEventListener("waiting", onWaiting);
    a.addEventListener("volumechange", onVolume);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onDuration);
      a.removeEventListener("durationchange", onDuration);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("canplay", onCanPlay);
      a.removeEventListener("waiting", onWaiting);
      a.removeEventListener("volumechange", onVolume);
    };
  }, [retryKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!audioRef.current || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekBy(-5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekBy(5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (loadError) {
    return (
      <ViewerMessage
        icon={Music}
        tone="warning"
        title="Audio cannot be played"
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
    <div className="flex h-full items-center justify-center bg-surface p-6">
      <audio
        key={retryKey}
        ref={audioRef}
        src={src}
        preload="auto"
        onError={() => {
          setLoadError(true);
          setLoading(false);
        }}
      />

      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-background/40 p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            {loading ? <Spinner size="sm" /> : <Music className="h-5 w-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={fileName}>
              {fileName}
            </p>
            <p className="text-xs text-muted-foreground" role="status">
              {loading ? "Loading audio…" : playing ? "Playing" : "Paused"}
            </p>
          </div>
        </div>

        <div className="mt-5">
          <input
            type="range"
            className="media-range"
            data-surface="light"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            disabled={duration === 0}
            aria-label="Seek"
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            style={{ ["--pct" as string]: `${progress}%` }}
            onChange={(e) => {
              const a = audioRef.current;
              if (a) a.currentTime = Number(e.target.value);
            }}
          />
          <div className="flex justify-between font-mono text-xs text-muted-foreground">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back 10 seconds"
            onClick={() => seekBy(-10)}
          >
            <SkipBack className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            className="h-14 w-14 rounded-full"
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {playing ? (
              <Pause className="h-6 w-6" aria-hidden="true" />
            ) : (
              <Play className="ml-0.5 h-6 w-6" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Forward 10 seconds"
            onClick={() => seekBy(10)}
          >
            <SkipForward className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="mt-5 flex items-center justify-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            onClick={() => {
              const a = audioRef.current;
              if (a) a.muted = !a.muted;
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
            className="media-range w-24"
            data-surface="light"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent`}
            style={{ ["--pct" as string]: `${(muted ? 0 : volume) * 100}%` }}
            onChange={(e) => {
              const a = audioRef.current;
              const next = Number(e.target.value);
              if (a) {
                a.volume = next;
                a.muted = next === 0;
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
