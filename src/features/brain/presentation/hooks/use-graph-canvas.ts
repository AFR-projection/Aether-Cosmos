"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Sky } from "@brain/presentation/canvas/cosmos";
import {
  GraphRenderer,
  fitCamera,
  type Camera,
  type RenderInput,
} from "@brain/presentation/canvas/renderer";
import {
  FALLBACK_THEME,
  readGraphTheme,
  type GraphTheme,
} from "@brain/presentation/canvas/theme";
import { ALPHA_MIN } from "@brain/presentation/canvas/simulation";
import type { DisplaySettings, GraphModel } from "@brain/presentation/canvas/types";
import type { GraphView } from "@brain/presentation/canvas/view";
import type { ResolvedGroups } from "@brain/presentation/canvas/groups";
import type { GraphEngineHandle } from "./use-graph-engine";

/**
 * Canvas lifecycle and the draw loop.
 *
 * The loop only runs while there is something to show for it: while the layout is
 * moving, while a light is travelling along a highlighted edge, and for a short grace
 * window after any interaction. An idle graph does not schedule frames at all, which
 * is what keeps a background tab (or a page with the graph parked below the fold)
 * from burning a core.
 *
 * This hook also owns the clock for that travelling light. The renderer is handed a
 * dash offset and no opinion about time: nothing is highlighted, or the reader asked
 * for reduced motion, and the offset is simply -1 — which the renderer reads as "no
 * packet" and paints a still frame. Motion policy lives in one place, and it is here.
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
/** Travel speed of the light along a highlighted edge, in pixels per second. */
const FLOW_SPEED = 46;
/** Phase wraps here: a session left open all day must not drift into big floats. */
const FLOW_PERIOD = 4096;
/** A frame gap longer than this is a tab that was asleep, not a slow frame. */
const MAX_FRAME_MS = 64;
/** Duration of a camera flight. Within MASTER.md's 300-450ms window for motion. */
const FLIGHT_MS = 380;
/**
 * Ambient motion — the twinkle and the nebula drift — is slow, so it does not need a
 * frame every 16ms. Repainting at ~24Hz instead cuts the cost of an idle-but-alive
 * graph by more than half and is indistinguishable at these speeds.
 */
const AMBIENT_MS = 42;

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
  /** This brain's starfield, built once per brain. Null skips the cosmos layer. */
  sky: Sky | null;
  /** Orbit spacing and ring count while the local graph is orbital, else null. */
  orbit: { gap: number; depth: number } | null;
}): GraphCanvasHandle {
  const { canvas, model, view, groups, display, engine, camera, setCamera } = input;
  const { hover, selected, focal, highlightNodes, highlightEdges, sky, orbit } = input;

  const rendererRef = useRef<GraphRenderer | null>(null);
  const themeRef = useRef<GraphTheme>(FALLBACK_THEME);
  const frameRef = useRef<number | null>(null);
  const idleRef = useRef(0);
  /** True while the OS asks for reduced motion. Read per frame, never rendered. */
  const reducedMotion = useRef(false);
  /** Timestamp of the last painted frame, so the flow runs on seconds not on frames. */
  const lastFrame = useRef(0);
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
    sky,
    orbit,
    /** How many local indexes the timelapse has revealed so far. */
    animLimit: 0,
    /** Dash offset for the travelling light. -1 means "do not draw it at all". */
    flowPhase: -1,
    /** Seconds of ambient time. -1 means "still frame". */
    ambientPhase: -1,
  });
  /** When ambient time started, so the phase is a clock rather than an accumulator. */
  const ambientStart = useRef(0);
  const lastAmbientDraw = useRef(0);
  /**
   * An in-flight camera move. Fit and focus travel instead of teleporting, which is
   * what makes recentring read as going somewhere; `written` is the camera this hook
   * last set, so any pan, zoom or pinch in the meantime is detected as someone else
   * taking the controls and the flight is abandoned rather than fighting the pointer.
   */
  const flight = useRef<{ from: Camera; to: Camera; start: number; written: Camera } | null>(null);
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
      sky: state.sky,
      flowPhase: state.flowPhase,
      orbit: state.orbit,
      ambientPhase: state.ambientPhase,
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

  /**
   * Advances an in-flight camera move by one frame and reports whether one is still
   * running. The camera ref is written directly rather than through `setCamera`: that
   * would call back into `requestDraw` from inside the loop and schedule a second
   * animation frame on top of the one the loop is about to schedule itself.
   */
  const advanceFlight = useCallback(
    (now: number): boolean => {
      const active = flight.current;
      if (!active) return false;
      const current = camera.current;
      const written = active.written;
      if (current.x !== written.x || current.y !== written.y || current.scale !== written.scale) {
        // A pan, a zoom or a pinch happened mid-flight: the pointer wins, always.
        flight.current = null;
        return false;
      }
      const progress = Math.min(1, (now - active.start) / FLIGHT_MS);
      // Expo-out: leaves immediately, arrives without a bump. MASTER.md's easing.
      const eased = progress >= 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const next: Camera = {
        x: active.from.x + (active.to.x - active.from.x) * eased,
        y: active.from.y + (active.to.y - active.from.y) * eased,
        // Zoom interpolates geometrically. Linear scale rushes the first half of a
        // zoom-in and crawls through the second.
        scale: active.from.scale * Math.pow(active.to.scale / active.from.scale, eased),
      };
      active.written = next;
      camera.current = next;
      if (progress >= 1) {
        flight.current = null;
        return false;
      }
      return true;
    },
    [camera]
  );

  const loop = useCallback(
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
      // The light only travels while there is a neighbourhood to travel along, so a
      // graph nobody is pointing at stays a still image.
      const flowing =
        !reducedMotion.current && state.display.cosmos && state.highlightEdges !== null;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const elapsed = lastFrame.current === 0 ? 0 : Math.min(MAX_FRAME_MS, now - lastFrame.current);
      lastFrame.current = now;
      state.flowPhase = flowing
        ? ((state.flowPhase < 0 ? 0 : state.flowPhase) + (elapsed / 1000) * FLOW_SPEED) %
          FLOW_PERIOD
        : -1;
      const flying = advanceFlight(now);
      /**
       * Ambient time only runs when the cosmos layer is on and motion is welcome.
       * With it on the loop never fully idles — that is the deliberate cost of a sky
       * that is alive — so the repaint is throttled and the phase is a wall clock,
       * which keeps the twinkle at the same speed whatever the frame rate.
       */
      const ambient = !reducedMotion.current && state.display.cosmos;
      if (!ambient) {
        state.ambientPhase = -1;
        ambientStart.current = 0;
      } else {
        if (ambientStart.current === 0) ambientStart.current = now;
        state.ambientPhase = (now - ambientStart.current) / 1000;
      }
      const busy = moving || revealing || flowing || flying;
      const grace = idleRef.current < IDLE_GRACE_FRAMES;
      const ambientDue = ambient && now - lastAmbientDraw.current >= AMBIENT_MS;
      if (busy || grace || ambientDue) {
        if (ambientDue) lastAmbientDraw.current = now;
        draw();
      }
      idleRef.current = busy ? 0 : idleRef.current + 1;
      if (busy || ambient || grace) {
        frameRef.current = requestAnimationFrame(loop);
      } else {
        // Nothing scheduled: the next frame is a fresh start, not a long gap.
        lastFrame.current = 0;
      }
    },
    [advanceFlight, draw, engine, setCamera]
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
    state.sky = sky;
    state.orbit = orbit;
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
    sky,
    orbit,
    view,
  ]);

  /**
   * Motion preference. Mirrored into a ref rather than into state: the draw loop
   * reads it every frame and nothing in the React tree depends on it, so a change
   * needs a repaint, not a re-render.
   */
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = query.matches;
    const onChange = () => {
      reducedMotion.current = query.matches;
      requestDraw();
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [requestDraw]);

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

  /**
   * Travels to a camera instead of snapping to it. Distances shorter than a few
   * pixels snap anyway — a "flight" nobody can see is only frames — and reduced
   * motion always snaps.
   */
  const flyTo = useCallback(
    (to: Camera) => {
      const from = camera.current;
      const travel = Math.hypot(to.x - from.x, to.y - from.y) * from.scale;
      const zoomChange = Math.abs(Math.log(to.scale / from.scale));
      if (
        reducedMotion.current ||
        !Number.isFinite(travel) ||
        !Number.isFinite(zoomChange) ||
        (travel < 4 && zoomChange < 0.02)
      ) {
        flight.current = null;
        setCamera(to);
        return;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      flight.current = { from, to, start: now, written: from };
      requestDraw();
    },
    [camera, requestDraw, setCamera]
  );

  const fit = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    flyTo(
      fitCamera(
        engine.positions.current,
        stateRef.current.view.count,
        renderer.width,
        renderer.height
      )
    );
  }, [engine, flyTo]);

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
      flyTo({ x, y, scale: Math.max(camera.current.scale, FOCUS_SCALE) });
    },
    [camera, engine, flyTo]
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
