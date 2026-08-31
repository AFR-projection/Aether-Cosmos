"use client";

import { useCallback, useEffect, useRef } from "react";
import { ForceSimulation } from "@brain/presentation/canvas/simulation";
import type { ForceSettings, GraphModel } from "@brain/presentation/canvas/types";
import type { GraphView } from "@brain/presentation/canvas/view";
import type { ForceRequest, ForceResponse } from "@brain/presentation/canvas/worker-protocol";

/**
 * The engine driver: owns the physics, wherever it runs.
 *
 * Positions live in refs, never in state — a moving graph paints 60 times a second
 * and React must not re-render once for any of them, which is what keeps the
 * sidebar responsive while the layout cools. The worker is the fast path; if a
 * browser or a bundler refuses to give us one, the identical ForceSimulation runs
 * on the main thread instead, so the graph degrades in smoothness, never in
 * behaviour.
 *
 * Layout continuity across filter changes is the other job here: positions are
 * flushed into a model-indexed cache before every rebuild and fed back as the seed,
 * so toggling a filter nudges the layout instead of re-exploding it.
 */

export type GraphEngineHandle = {
  /** Positions of the CURRENT view, local index space, [x, y] pairs. */
  positions: { current: Float32Array };
  /** Cooling level of the layout; > ALPHA_MIN means "still moving". */
  alpha: { current: number };
  /** True while physics runs off the main thread. */
  worker: { current: boolean };
  /** Store subscription for the backend flag, so React can read it without a ref peek. */
  subscribeBackend: (listener: () => void) => () => void;
  getBackend: () => boolean;
  reheat: (alpha?: number) => void;
  pin: (local: number, x: number, y: number) => void;
  release: (local: number) => void;
};

export function useGraphEngine(input: {
  model: GraphModel;
  view: GraphView;
  settings: ForceSettings;
}): GraphEngineHandle {
  const { model, view, settings } = input;

  const positions = useRef<Float32Array>(new Float32Array(0));
  const alpha = useRef(0);
  const usingWorker = useRef(false);
  /**
   * Which backend is live is external state as far as React is concerned, so it is
   * published as a store rather than mirrored into component state — a worker that
   * fails to load mid-session still reaches the sidebar, and nothing calls setState
   * from inside an effect to make that happen.
   */
  const backendListeners = useRef(new Set<() => void>());
  const subscribeBackend = useCallback((listener: () => void) => {
    const listeners = backendListeners.current;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const getBackend = useCallback(() => usingWorker.current, []);
  const setBackend = useCallback((worker: boolean) => {
    if (usingWorker.current === worker) return;
    usingWorker.current = worker;
    for (const listener of backendListeners.current) listener();
  }, []);
  const generation = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const localRef = useRef<ForceSimulation | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Model-indexed position cache, so a rebuild can seed from the old layout. */
  const cacheRef = useRef<Float32Array>(new Float32Array(0));
  /** The view `positions` currently belongs to; null before the first graph. */
  const boundView = useRef<GraphView | null>(null);
  const settingsRef = useRef(settings);
  const viewRef = useRef(view);
  // Kept in an effect, not in the render body: the worker install effect below is
  // declared after this one, so it always reads a current view.
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /** Main-thread fallback loop. Stops itself the moment the layout settles. */
  const pump = useCallback(
    // Named so the reschedule below refers to this function, not to the binding.
    function pump() {
      frameRef.current = null;
      const simulation = localRef.current;
      if (!simulation) return;
      simulation.tick();
      // No copy: the renderer reads the simulation's own array.
      positions.current = simulation.positions;
      alpha.current = simulation.alpha;
      if (!simulation.settled) frameRef.current = requestAnimationFrame(pump);
    },
    []
  );

  const wake = useCallback(() => {
    const simulation = localRef.current;
    if (!simulation || simulation.settled || frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(pump);
  }, [pump]);

  /** One entry point for both backends, so the call sites never branch. */
  const post = useCallback(
    (message: ForceRequest, transfer?: ArrayBuffer[]) => {
      const worker = workerRef.current;
      if (worker) {
        if (transfer && transfer.length > 0) worker.postMessage(message, transfer);
        else worker.postMessage(message);
        return;
      }
      const simulation = localRef.current;
      if (!simulation) return;
      switch (message.type) {
        case "graph":
          simulation.setSettings(message.settings);
          simulation.setGraph(message.count, message.links, message.seed, message.weights);
          positions.current = simulation.positions;
          alpha.current = simulation.alpha;
          break;
        case "settings":
          simulation.setSettings(message.settings);
          simulation.reheat(0.35);
          break;
        case "reheat":
          simulation.reheat(message.alpha ?? 0.55);
          break;
        case "pin":
          simulation.pin(message.index, message.x, message.y);
          simulation.reheat(0.35);
          break;
        case "release":
          simulation.release(message.index);
          simulation.reheat(0.25);
          break;
        case "recycle":
          return;
        case "stop":
          if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
          }
          return;
      }
      wake();
    },
    [wake]
  );

  /** Copies the current layout back into the model-indexed cache. */
  const flush = useCallback((previous: GraphView | null) => {
    if (!previous) return;
    const cache = cacheRef.current;
    const source = positions.current;
    const count = Math.min(previous.count, source.length >> 1);
    for (let i = 0; i < count; i += 1) {
      const modelIndex = previous.nodesOf[i];
      if (modelIndex < 0 || modelIndex * 2 + 1 >= cache.length) continue;
      cache[modelIndex * 2] = source[i * 2];
      cache[modelIndex * 2 + 1] = source[i * 2 + 1];
    }
  }, []);

  const sendGraph = useCallback(
    (next: GraphView) => {
      flush(boundView.current);
      boundView.current = next;
      const cache = cacheRef.current;
      const seed = new Float32Array(next.count * 2);
      for (let i = 0; i < next.count; i += 1) {
        const modelIndex = next.nodesOf[i];
        const cached = modelIndex >= 0 && modelIndex * 2 + 1 < cache.length;
        // NaN means "no previous position"; the simulation seeds those on a spiral.
        seed[i * 2] = cached ? cache[modelIndex * 2] : NaN;
        seed[i * 2 + 1] = cached ? cache[modelIndex * 2 + 1] : NaN;
      }
      generation.current += 1;
      positions.current = seed;
      alpha.current = 1;
      post({
        type: "graph",
        generation: generation.current,
        count: next.count,
        // links can be a subarray view; slice so only the live pairs are cloned.
        links: next.links.slice(),
        // Strengths ride along with the links so weak relationships pull less and
        // rest farther out — the physics reads the same weights the renderer draws.
        weights: next.linkWeights.slice(),
        seed,
        settings: settingsRef.current,
      });
    },
    [flush, post]
  );

  // A new model invalidates every cached position: indexes mean something else now.
  useEffect(() => {
    cacheRef.current = new Float32Array(model.nodes.length * 2).fill(NaN);
    boundView.current = null;
  }, [model]);

  useEffect(() => {
    const installLocal = () => {
      workerRef.current = null;
      setBackend(false);
      localRef.current = new ForceSimulation();
      boundView.current = null;
      sendGraph(viewRef.current);
    };

    let created: Worker | null = null;
    try {
      created = new Worker(new URL("@brain/presentation/canvas/force.worker", import.meta.url), {
        type: "module",
      });
    } catch {
      created = null;
    }

    if (!created) {
      installLocal();
      return () => {
        post({ type: "stop" });
        localRef.current = null;
      };
    }

    const worker = created;
    workerRef.current = worker;
    setBackend(true);
    worker.onmessage = (event: MessageEvent<ForceResponse>) => {
      const frame = event.data;
      // Frames for a superseded graph are dropped: their indexes are stale.
      if (frame.type !== "frame" || frame.generation !== generation.current) return;
      const previous = positions.current;
      positions.current = frame.positions;
      alpha.current = frame.alpha;
      if (
        previous.byteLength === frame.positions.byteLength &&
        previous.buffer !== frame.positions.buffer
      ) {
        // Hand the old buffer back so a moving graph allocates nothing per frame.
        const buffer = previous.buffer as ArrayBuffer;
        worker.postMessage({ type: "recycle", buffer }, [buffer]);
      }
    };
    worker.onerror = () => {
      // A worker that fails to load must not take the graph down with it.
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      installLocal();
    };

    return () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.postMessage({ type: "stop" });
      worker.terminate();
      workerRef.current = null;
      setBackend(false);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [post, sendGraph, setBackend]);

  // The visible subgraph changed (filter, group toggle, new snapshot).
  useEffect(() => {
    sendGraph(view);
  }, [view, sendGraph]);

  useEffect(() => {
    settingsRef.current = settings;
    post({ type: "settings", settings });
  }, [settings, post]);

  const reheat = useCallback(
    (next?: number) => post({ type: "reheat", alpha: next }),
    [post]
  );

  const pin = useCallback(
    (local: number, x: number, y: number) => {
      // Mirror the pin locally so the dragged node tracks the cursor on the very
      // next frame instead of waiting for the worker to answer.
      const own = positions.current;
      if (local >= 0 && local * 2 + 1 < own.length) {
        own[local * 2] = x;
        own[local * 2 + 1] = y;
      }
      post({ type: "pin", index: local, x, y });
    },
    [post]
  );

  const release = useCallback((local: number) => post({ type: "release", index: local }), [post]);

  return {
    positions,
    alpha,
    worker: usingWorker,
    subscribeBackend,
    getBackend,
    reheat,
    pin,
    release,
  };
}
