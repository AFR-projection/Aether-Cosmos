"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  FALLBACK_THEME,
  GraphRenderer,
  fitCamera,
  readGraphTheme,
  type Camera,
  type GraphTheme,
  type RenderInput,
} from "@brain/presentation/canvas/renderer";
import { ALPHA_MIN } from "@brain/presentation/canvas/simulation";
import type { DisplaySettings, GraphModel } from "@brain/presentation/canvas/types";
import type { GraphView } from "@brain/presentation/canvas/view";
import type { ResolvedGroups } from "@brain/presentation/canvas/groups";
import type { GraphEngineHandle } from "./use-graph-engine";

/**
 * Canvas lifecycle and the draw loop.
 *
 * The loop only runs while there is something to show for it: while the layout is
 * moving, and for a short grace window after any interaction. An idle graph does
 * not schedule frames at all, which is what keeps a background tab (or a page with
 * the graph parked below the fold) from burning a core.
 *
 * Everything the renderer needs per frame is read from refs, so a hover or a pan
 * never re-renders React — the only React state involved is what the sidebar shows.
 */

/** Frames to keep drawing after the last change, so a late worker frame is caught. */
const IDLE_GRACE_FRAMES = 48;
/** Roughly how many frames a full timelapse sweep should take (~2.5s at 60Hz). */
const ANIM_FRAMES = 150;
/** Minimum zoom "focus this node" settles on, so focusing always reads as a move. */
const FOCUS_SCALE = 1.2;

export type GraphCanvasHandle = {
  requestDraw: () => void;
  hitTest: (screenX: number, screenY: number) => number;
  /** Frames the whole current layout. */
  fit: () => void;
  /**
   * Frames the layout again as soon as it has taken shape. Used when the visible
   * subgraph changes wholesale (a new local-graph centre), where an immediate fit
   * would frame the seed spiral of nodes that have not been placed yet.
   */
  requestFit: () => void;
  /**
   * Puts one model node in the middle of the viewport. No-op when the node is not
   * in the current view, since a hidden node has no position to travel to.
   */
  centerOn: (modelIndex: number) => void;
  /** Restarts the timelapse sweep from the first node. Only visible when animating. */
  restartAnimation: () => void;
};

export function useGraphCanvas(input: {
  /** The mounted canvas element: the renderer is built and resized against it. */
  canvas: HTMLCanvasElement | null;
  model: GraphModel;
  view: GraphView;
  groups: ResolvedGroups;
  display: DisplaySettings;
  engine: GraphEngineHandle;
  camera: { current: Camera };
  setCamera: (next: Camera) => void;
  hover: number;
  selected: number;
  /** Local-graph centre as a model index, or -1. */
  focal: number;
  highlightNodes: Uint8Array | null;
  highlightEdges: Uint8Array | null;
}): GraphCanvasHandle {
  const { canvas, model, view, groups, display, engine, camera, setCamera } = input;
  const { hover, selected, focal, highlightNodes, highlightEdges } = input;

  const rendererRef = useRef<GraphRenderer | null>(null);
  const themeRef = useRef<GraphTheme>(FALLBACK_THEME);
  const frameRef = useRef<number | null>(null);
  const idleRef = useRef(0);
  /** Per-frame state that must not go through React. */
  const stateRef = useRef({
    hover: -1,
    selected: -1,
    focal: -1,
    highlightNodes: null as Uint8Array | null,
    highlightEdges: null as Uint8Array | null,
    model,
    view,
    groups,
    display,
    /** How many local indexes the timelapse has revealed so far. */
    animLimit: 0,
  });
  const wasAnimating = useRef(false);
  const pendingFit = useRef(true);

  const buildInput = useCallback((): RenderInput | null => {
    const state = stateRef.current;
    if (state.view.count === 0) return null;
    return {
      model: state.model,
      view: state.view,
      positions: engine.positions.current,
      groups: state.groups,
      display: state.display,
      camera: camera.current,
      theme: themeRef.current,
      hover: state.hover,
      selected: state.selected,
      focal: state.focal,
      highlightNodes: state.highlightNodes,
      highlightEdges: state.highlightEdges,
      moving: engine.alpha.current > ALPHA_MIN,
      animLimit: state.animLimit,
    };
  }, [camera, engine]);

  const draw = useCallback(() => {
    const renderer = rendererRef.current;
    const frame = buildInput();
    if (!renderer) return;
    if (!frame) {
      renderer.clear(themeRef.current.background);
      return;
    }
    renderer.draw(frame);
  }, [buildInput]);

  const loop = useCallback(
    // Named function expression so the rAF reschedule refers to itself rather than
    // to the binding this useCallback is being assigned to.
    function loop() {
      frameRef.current = null;
      const state = stateRef.current;
      const moving = engine.alpha.current > ALPHA_MIN;
      const count = state.view.count;
      // Wait for the layout to take shape before framing it, so the first fit is not
      // a frame around the seed spiral.
      if (pendingFit.current && count > 0 && engine.alpha.current <= 0.4) {
        pendingFit.current = false;
        const renderer = rendererRef.current;
        if (renderer) {
          setCamera(fitCamera(engine.positions.current, count, renderer.width, renderer.height));
        }
      }
      // The timelapse is a paint-only sweep: it advances a counter and never touches
      // the physics, so a big graph does not pay for the effect twice.
      const revealing = state.display.animate && state.animLimit < count;
      if (revealing) {
        state.animLimit = Math.min(count, state.animLimit + Math.max(1, Math.ceil(count / ANIM_FRAMES)));
      }
      draw();
      idleRef.current = moving || revealing ? 0 : idleRef.current + 1;
      if (moving || revealing || idleRef.current < IDLE_GRACE_FRAMES) {
        frameRef.current = requestAnimationFrame(loop);
      }
    },
    [draw, engine, setCamera]
  );

  const requestDraw = useCallback(() => {
    idleRef.current = 0;
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(loop);
  }, [loop]);

  useEffect(() => {
    if (!canvas) return;
    const renderer = new GraphRenderer(canvas);
    rendererRef.current = renderer;
    themeRef.current = readGraphTheme(canvas.parentElement ?? canvas);
    const applySize = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
      requestDraw();
    };
    applySize();
    // Observing the element (not window) also catches the sidebar collapsing.
    const observer = new ResizeObserver(applySize);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      rendererRef.current = null;
    };
  }, [canvas, requestDraw]);

  // Anything React knows about that the renderer needs: copy it in, then repaint.
  useEffect(() => {
    const state = stateRef.current;
    state.hover = hover;
    state.selected = selected;
    state.focal = focal;
    state.highlightNodes = highlightNodes;
    state.highlightEdges = highlightEdges;
    state.model = model;
    state.view = view;
    state.groups = groups;
    // Turning the timelapse on plays it; turning it off shows the whole graph again.
    if (display.animate && !wasAnimating.current) state.animLimit = 0;
    if (!display.animate) state.animLimit = view.count;
    wasAnimating.current = display.animate;
    state.display = display;
    requestDraw();
  }, [
    display,
    focal,
    groups,
    highlightEdges,
    highlightNodes,
    hover,
    model,
    requestDraw,
    selected,
    view,
  ]);

  // A different graph deserves a fresh camera; a filter change does not.
  useEffect(() => {
    pendingFit.current = true;
  }, [model]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    []
  );

  const hitTest = useCallback(
    (screenX: number, screenY: number) => {
      const renderer = rendererRef.current;
      const frame = buildInput();
      if (!renderer || !frame) return -1;
      return renderer.hitTest(frame, screenX, screenY);
    },
    [buildInput]
  );

  const fit = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    setCamera(
      fitCamera(
        engine.positions.current,
        stateRef.current.view.count,
        renderer.width,
        renderer.height
      )
    );
  }, [engine, setCamera]);

  const requestFit = useCallback(() => {
    pendingFit.current = true;
    requestDraw();
  }, [requestDraw]);

  const centerOn = useCallback(
    (modelIndex: number) => {
      const state = stateRef.current;
      if (modelIndex < 0 || modelIndex >= state.view.localOf.length) return;
      const local = state.view.localOf[modelIndex];
      if (local < 0) return;
      const positions = engine.positions.current;
      const x = positions[local * 2];
      const y = positions[local * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // Framing must not fight this: a pending first fit would snap the camera back.
      pendingFit.current = false;
      setCamera({ x, y, scale: Math.max(camera.current.scale, FOCUS_SCALE) });
    },
    [camera, engine, setCamera]
  );

  const restartAnimation = useCallback(() => {
    stateRef.current.animLimit = 0;
    requestDraw();
  }, [requestDraw]);

  return useMemo(
    () => ({ requestDraw, hitTest, fit, requestFit, centerOn, restartAnimation }),
    [centerOn, fit, hitTest, requestDraw, requestFit, restartAnimation]
  );
}
