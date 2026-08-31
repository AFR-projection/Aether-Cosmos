"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink, ImageOff, RefreshCw, RotateCw, ZoomIn, ZoomOut,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/feedback/spinner";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import { isTypingTarget, ViewerMessage } from "./viewer-chrome";

interface ImageViewerProps {
  src: string;
  fileName: string;
  mimeType: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const clampZoom = (z: number) => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);

export function ImageViewer({ src, fileName, mimeType }: ImageViewerProps) {
  const t = useT();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  // Remounts the <img> so "Try again" actually refetches instead of showing the
  // browser's cached failure.
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });

  const reset = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }, []);

  // Bare keys, so anything the user is typing into keeps its keystrokes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "+" || e.key === "=") setZoom((z) => clampZoom(z + 0.25));
      else if (e.key === "-") setZoom((z) => clampZoom(z - 0.25));
      else if (e.key === "0") reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reset]);

  // React's onWheel is registered passively, so preventDefault there is ignored
  // and the page scrolls while zooming. This listener opts out explicitly.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z + (e.deltaY > 0 ? -0.1 : 0.1)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Pointer events cover mouse, pen and touch with one path — panning a zoomed
  // image used to be mouse-only.
  function handlePointerDown(e: React.PointerEvent) {
    if (zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }

  if (status === "error") {
    return (
      <ViewerMessage
        icon={ImageOff}
        tone="warning"
        title={t("files.viewer.image.failedTitle")}
        hint={t("files.viewer.image.failedHint")}
        onRetry={() => {
          setStatus("loading");
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border/40 bg-surface/70 px-4 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.image.zoomOut")}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((z) => clampZoom(z - 0.25))}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span
          role="status"
          aria-label={t("files.viewer.image.zoomLevel", { count: Math.round(zoom * 100) })}
          className="min-w-12 text-center font-mono text-xs text-muted-foreground"
        >
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.image.zoomIn")}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((z) => clampZoom(z + 0.25))}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.image.rotate")}
          onClick={() => setRotation((r) => r + 90)}
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.image.reset")}
          onClick={reset}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("files.viewer.image.openFullSize")}
          onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div
        ref={containerRef}
        className={cn(
          "checkerboard relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden",
          zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {status === "loading" && (
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner size="lg" />
          </span>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={attempt}
          src={src}
          alt={fileName}
          draggable={false}
          className={cn(
            "max-h-full max-w-full select-none transition-transform duration-100",
            status === "loading" && "opacity-0"
          )}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
          }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            setStatus("ready");
          }}
          onError={() => setStatus("error")}
        />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/40 bg-surface/70 px-4 py-1.5 text-xs text-muted-foreground">
        <span>
          {naturalSize.w > 0
            ? t("files.viewer.image.dimensions", {
                width: naturalSize.w,
                height: naturalSize.h,
              })
            : t("files.viewer.image.readingDimensions")}
        </span>
        <span className="truncate font-mono">{mimeType}</span>
      </div>
    </div>
  );
}
