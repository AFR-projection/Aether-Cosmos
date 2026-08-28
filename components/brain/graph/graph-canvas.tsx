"use client";

import { Expand, ExternalLink, Frame, Shrink, ZoomIn, ZoomOut } from "lucide-react";
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from "react";
import { Button } from "@/components/ui/button";
import { FALLBACK_THEME } from "@/lib/brain/graph/renderer";

/**
 * The canvas surface and its viewport controls.
 *
 * One <canvas> for the whole graph — thousands of nodes as DOM elements is exactly
 * what the spec rules out. The element is focusable and answers arrow keys, +/- and
 * 0, so the viewport is reachable without a pointer; `role="application"` tells a
 * screen reader that those keys belong to the widget. The node list in the sidebar
 * and the detail card are the accessible path to the data itself.
 */

const KEY_PAN = 60;

export function GraphCanvas({
  canvasRef,
  handlers,
  onPan,
  onZoomIn,
  onZoomOut,
  onFit,
  hoverLabel,
  onPopOut,
  onToggleFullscreen,
  fullscreen = false,
}: {
  /** Callback ref, so the owner learns the moment the canvas mounts. */
  canvasRef: Ref<HTMLCanvasElement>;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerLeave: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onContextMenu: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
    onDoubleClick: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  };
  onPan: (dxScreen: number, dyScreen: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  hoverLabel: string | null;
  /** Opens the graph in its own window. Omitted when already in that window. */
  onPopOut?: () => void;
  onToggleFullscreen?: () => void;
  fullscreen?: boolean;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    switch (event.key) {
      case "ArrowLeft":
        onPan(KEY_PAN, 0);
        break;
      case "ArrowRight":
        onPan(-KEY_PAN, 0);
        break;
      case "ArrowUp":
        onPan(0, KEY_PAN);
        break;
      case "ArrowDown":
        onPan(0, -KEY_PAN);
        break;
      case "+":
      case "=":
        onZoomIn();
        break;
      case "-":
      case "_":
        onZoomOut();
        break;
      case "0":
        onFit();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    /* The ground colour is the renderer's, not a token: the graph is painted dark
       in both themes (see FALLBACK_THEME) so grey edges stay readable. Taking it
       from the same constant keeps the wrapper and the canvas from drifting apart
       during the frame before the first paint. */
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: FALLBACK_THEME.background }}
    >
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Knowledge graph. Drag to pan, scroll or pinch to zoom, arrow keys to move, plus and minus to zoom, zero to fit. Double-click a node to centre the local graph on it; right-click or long-press for its actions."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerUp}
        onPointerLeave={handlers.onPointerLeave}
        onContextMenu={handlers.onContextMenu}
        onDoubleClick={handlers.onDoubleClick}
        className="h-full w-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      />

      {hoverLabel ? (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[60%] truncate rounded-lg border border-border/50 bg-surface/90 px-2 py-1 text-[11px] text-foreground shadow-sm backdrop-blur">
          {hoverLabel}
        </div>
      ) : null}

      <div className="absolute right-3 top-3 flex flex-col gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="Zoom in"
          onClick={onZoomIn}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={onZoomOut}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          aria-label="Fit graph to view"
          onClick={onFit}
        >
          <Frame className="h-4 w-4" aria-hidden="true" />
        </Button>
        {onToggleFullscreen ? (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? (
              <Shrink className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Expand className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        ) : null}
        {onPopOut ? (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label="Open graph in a separate window"
            onClick={onPopOut}
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
