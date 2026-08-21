"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { edgesOf, neighboursOf } from "@/lib/brain/graph/model";
import { DEFAULT_CAMERA, panCamera, zoomCamera, type Camera } from "@/lib/brain/graph/renderer";
import type { GraphModel } from "@/lib/brain/graph/types";
import type { GraphView } from "@/lib/brain/graph/view";
import type { GraphEngineHandle } from "./use-graph-engine";

/**
 * Interaction state: hover, selection, camera, drag.
 *
 * The camera and the drag live in refs and never in state — panning at 60 Hz must
 * not re-render the React tree, or the sidebar stutters exactly when the graph is
 * busiest. Hover and selection *are* state, because the detail card and the
 * sidebar have to react to them; they only change when the node under the cursor
 * changes, not on every pointer move.
 *
 * Highlight masks are model-indexed byte arrays rather than Sets: the renderer
 * tests them once per node and edge per frame.
 *
 * Touch is a first-class pointer here, not an afterthought: two fingers pinch-zoom
 * (the canvas sets `touch-none`, so the browser will not do it for us) and a long
 * press stands in for the right button, because a touch device has none.
 */

const DRAG_THRESHOLD = 3;
/** Hold this long on a node to get the context menu without a right button. */
const LONG_PRESS_MS = 500;
/** Guards against dividing by a near-zero pinch distance when fingers touch. */
const PINCH_MIN_DISTANCE = 12;

type PinchState = { distance: number; midX: number; midY: number };

/** Distance and midpoint of the first two live pointers, in canvas coordinates. */
function pinchFrom(pointers: Map<number, { x: number; y: number }>): PinchState | null {
  const iterator = pointers.values();
  const a = iterator.next().value;
  const b = iterator.next().value;
  if (!a || !b) return null;
  return {
    distance: Math.max(PINCH_MIN_DISTANCE, Math.hypot(b.x - a.x, b.y - a.y)),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
  };
}

export type GraphContextMenuState = {
  /** Model node index the menu belongs to. */
  modelIndex: number;
  /** Viewport coordinates — the menu is portalled to the body, not the canvas. */
  x: number;
  y: number;
};

export type GraphInteraction = {
  hover: number;
  selected: number;
  camera: { current: Camera };
  highlightNodes: Uint8Array | null;
  highlightEdges: Uint8Array | null;
  contextMenu: GraphContextMenuState | null;
  closeContextMenu: () => void;
  select: (modelIndex: number) => void;
  clear: () => void;
  setCamera: (next: Camera) => void;
  zoomBy: (factor: number) => void;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerLeave: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onContextMenu: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
    onDoubleClick: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  };
};

export function useGraphInteraction(input: {
  model: GraphModel;
  view: GraphView;
  engine: GraphEngineHandle;
  /**
   * The mounted canvas element, not a ref: this hook attaches a native wheel
   * listener, and the canvas only mounts after the graph has finished loading, so
   * an effect keyed on a ref object would run once against nothing and never again.
   */
  canvas: HTMLCanvasElement | null;
  /** Screen point -> model node index, or -1. Supplied by the canvas. */
  hitTest: (screenX: number, screenY: number) => number;
  /** Tells the canvas that something other than the physics changed. */
  requestDraw: () => void;
  /** Double-click on a node. The composition root decides what "activate" means. */
  onActivate?: (modelIndex: number) => void;
}): GraphInteraction {
  const { model, view, engine, canvas, hitTest, requestDraw, onActivate } = input;

  const [hover, setHover] = useState(-1);
  const [selected, setSelected] = useState(-1);
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null);
  const hoverRef = useRef(-1);
  const camera = useRef<Camera>(DEFAULT_CAMERA);
  const drag = useRef<{
    pointerId: number;
    mode: "node" | "pan";
    modelIndex: number;
    local: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  /** Every pointer currently down, so two fingers can be told apart from one. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<PinchState | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(
    (clientX: number, clientY: number) => {
      if (!canvas) return { x: 0, y: 0, width: 0, height: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        width: rect.width,
        height: rect.height,
      };
    },
    [canvas]
  );

  const setHoverIndex = useCallback(
    (next: number) => {
      if (next === hoverRef.current) return;
      hoverRef.current = next;
      setHover(next);
      requestDraw();
    },
    [requestDraw]
  );

  const select = useCallback(
    (modelIndex: number) => {
      setSelected(modelIndex);
      requestDraw();
    },
    [requestDraw]
  );

  const clear = useCallback(() => {
    setSelected(-1);
    setHoverIndex(-1);
    setContextMenu(null);
    requestDraw();
  }, [requestDraw, setHoverIndex]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const cancelLongPress = useCallback(() => {
    if (longPress.current === null) return;
    clearTimeout(longPress.current);
    longPress.current = null;
  }, []);

  /** Drops the current drag without treating it as a click, and unpins the node. */
  const abandonDrag = useCallback(() => {
    const state = drag.current;
    drag.current = null;
    if (state?.mode === "node" && state.local >= 0) engine.release(state.local);
  }, [engine]);

  // A pending long press must not fire after the graph is gone.
  useEffect(() => cancelLongPress, [cancelLongPress]);

  /**
   * Right-click selects the node under the cursor and opens the menu at the pointer.
   * Selecting first means the detail card and the highlight agree with the menu, so
   * there is never a menu acting on a node the graph is not showing as current.
   */
  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const { x, y } = measure(event.clientX, event.clientY);
      const modelIndex = hitTest(x, y);
      if (modelIndex < 0) {
        setContextMenu(null);
        return;
      }
      setSelected(modelIndex);
      setContextMenu({ modelIndex, x: event.clientX, y: event.clientY });
      requestDraw();
    },
    [hitTest, measure, requestDraw]
  );

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      if (!onActivate) return;
      const { x, y } = measure(event.clientX, event.clientY);
      const modelIndex = hitTest(x, y);
      if (modelIndex < 0) return;
      event.preventDefault();
      setContextMenu(null);
      onActivate(modelIndex);
    },
    [hitTest, measure, onActivate]
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const { x, y } = measure(event.clientX, event.clientY);
      pointers.current.set(event.pointerId, { x, y });
      event.currentTarget.setPointerCapture(event.pointerId);

      // Second finger down: this is a pinch. Whatever the first finger had grabbed
      // is let go, so the gesture zooms instead of flinging a node across the graph.
      if (pointers.current.size === 2) {
        cancelLongPress();
        abandonDrag();
        setContextMenu(null);
        pinch.current = pinchFrom(pointers.current);
        requestDraw();
        return;
      }
      if (pointers.current.size > 2) return;

      const modelIndex = hitTest(x, y);
      const local = modelIndex >= 0 ? view.localOf[modelIndex] ?? -1 : -1;
      drag.current = {
        pointerId: event.pointerId,
        mode: modelIndex >= 0 ? "node" : "pan",
        modelIndex,
        local,
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        moved: false,
      };
      if (local >= 0) {
        // Pin where the node already is, so grabbing it does not teleport it.
        const positions = engine.positions.current;
        if (local * 2 + 1 < positions.length) {
          engine.pin(local, positions[local * 2], positions[local * 2 + 1]);
        }
      }
      // Touch has no right button, so a press held still opens the same menu. The
      // coordinates are copied out: the event object is not valid inside the timer.
      if (event.pointerType === "touch" && modelIndex >= 0) {
        const clientX = event.clientX;
        const clientY = event.clientY;
        longPress.current = setTimeout(() => {
          longPress.current = null;
          abandonDrag();
          setSelected(modelIndex);
          setContextMenu({ modelIndex, x: clientX, y: clientY });
          requestDraw();
        }, LONG_PRESS_MS);
      }
      requestDraw();
    },
    [abandonDrag, cancelLongPress, engine, hitTest, measure, requestDraw, view]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const { x, y, width, height } = measure(event.clientX, event.clientY);
      if (pointers.current.has(event.pointerId)) {
        pointers.current.set(event.pointerId, { x, y });
      }

      if (pinch.current && pointers.current.size >= 2) {
        const next = pinchFrom(pointers.current);
        if (!next) return;
        const previous = pinch.current;
        pinch.current = next;
        // Follow the midpoint, then zoom about it: the point between the fingers
        // stays under them, which is what makes a pinch feel attached to the graph.
        camera.current = panCamera(
          camera.current,
          next.midX - previous.midX,
          next.midY - previous.midY
        );
        camera.current = zoomCamera(
          camera.current,
          next.midX,
          next.midY,
          next.distance / previous.distance,
          width,
          height
        );
        requestDraw();
        return;
      }

      const state = drag.current;
      if (!state) {
        setHoverIndex(hitTest(x, y));
        return;
      }
      const dx = x - state.lastX;
      const dy = y - state.lastY;
      state.lastX = x;
      state.lastY = y;
      if (
        Math.abs(x - state.startX) > DRAG_THRESHOLD ||
        Math.abs(y - state.startY) > DRAG_THRESHOLD
      ) {
        state.moved = true;
        // A press that travels is a drag, not a hold.
        cancelLongPress();
      }
      if (state.mode === "pan") {
        camera.current = panCamera(camera.current, dx, dy);
      } else if (state.local >= 0) {
        const cam = camera.current;
        engine.pin(
          state.local,
          (x - width / 2) / cam.scale + cam.x,
          (y - height / 2) / cam.scale + cam.y
        );
      }
      requestDraw();
    },
    [cancelLongPress, engine, hitTest, measure, requestDraw, setHoverIndex]
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      pointers.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      cancelLongPress();

      if (pinch.current) {
        // Lifting one finger of two re-seeds the gesture from what is left rather
        // than turning the remaining finger into a drag halfway through.
        pinch.current = pointers.current.size >= 2 ? pinchFrom(pointers.current) : null;
        requestDraw();
        return;
      }

      const state = drag.current;
      drag.current = null;
      if (!state) return;
      if (state.mode === "node") {
        if (state.local >= 0) engine.release(state.local);
        // A press that never moved is a click: open the node instead of dragging it.
        if (!state.moved) select(state.modelIndex);
      } else if (!state.moved) {
        // Click on empty space resets the highlight, the way Obsidian does.
        clear();
      }
      requestDraw();
    },
    [cancelLongPress, clear, engine, requestDraw, select]
  );

  const onPointerLeave = useCallback(() => {
    if (!drag.current) setHoverIndex(-1);
  }, [setHoverIndex]);
  // Wheel is registered natively: React's synthetic wheel listener is passive, so
  // preventDefault() there would be ignored and the page would scroll instead.
  useEffect(() => {
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const step = event.deltaMode === 1 ? 0.05 : 0.0015;
      camera.current = zoomCamera(
        camera.current,
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * step),
        rect.width,
        rect.height
      );
      requestDraw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvas, requestDraw]);

  const setCamera = useCallback(
    (next: Camera) => {
      camera.current = next;
      requestDraw();
    },
    [requestDraw]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const width = canvas?.clientWidth ?? 0;
      const height = canvas?.clientHeight ?? 0;
      camera.current = zoomCamera(camera.current, width / 2, height / 2, factor, width, height);
      requestDraw();
    },
    [canvas, requestDraw]
  );

  /**
   * Hover wins over selection, so moving the pointer explores the graph while a
   * selected node keeps its detail card open. Only *visible* neighbours light up.
   */
  const highlight = useMemo(() => {
    const focus = hover >= 0 ? hover : selected;
    if (focus < 0 || focus >= model.nodes.length || view.localOf[focus] < 0) {
      return { nodes: null as Uint8Array | null, edges: null as Uint8Array | null };
    }
    const nodes = new Uint8Array(model.nodes.length);
    const edges = new Uint8Array(model.edges.length);
    nodes[focus] = 1;
    const neighbours = neighboursOf(model, focus);
    const touching = edgesOf(model, focus);
    for (let k = 0; k < neighbours.length; k += 1) {
      const other = neighbours[k];
      const edgeIndex = touching[k];
      // A neighbour reached only through a switched-off relationship tier is not a
      // neighbour on screen: lighting it up would promise an edge that is not drawn.
      if (view.localOf[other] < 0 || !view.edgeVisible[edgeIndex]) continue;
      nodes[other] = 1;
      edges[edgeIndex] = 1;
    }
    return { nodes, edges };
  }, [hover, model, selected, view]);

  return {
    hover,
    selected,
    camera,
    highlightNodes: highlight.nodes,
    highlightEdges: highlight.edges,
    contextMenu,
    closeContextMenu,
    select,
    clear,
    setCamera,
    zoomBy,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave,
      onContextMenu,
      onDoubleClick,
    },
  };
}
