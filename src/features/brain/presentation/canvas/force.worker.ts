import { ForceSimulation } from "./simulation";
import type { ForceRequest } from "./worker-protocol";

/**
 * Physics worker. Nothing but the simulation lives here — the whole point is that
 * a 4000-node layout cools on this thread while the sidebar, the React tree and
 * the scrollbars stay on the other one.
 *
 * The tick loop stops as soon as the layout settles and restarts on any input, so
 * an idle graph costs zero CPU.
 */

/**
 * Locally typed worker scope. The project's tsconfig loads the `dom` lib, where
 * `self` is a Window and postMessage takes a targetOrigin; pulling in the
 * `webworker` lib instead would collide with it across the rest of the app. A
 * module-scoped declaration shadows the global for this file only.
 */
type WorkerScope = {
  onmessage: ((event: MessageEvent<ForceRequest>) => void) | null;
  postMessage(message: unknown, options?: { transfer?: ArrayBuffer[] }): void;
};
declare const self: WorkerScope;

const simulation = new ForceSimulation();
const spare: ArrayBuffer[] = [];
let generation = 0;
let running = false;
/** True when the current positions have not been sent to the renderer yet. */
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** ~60 Hz. A worker has no requestAnimationFrame. */
const TICK_MS = 16;

function bytesNeeded(): number {
  return simulation.count * 2 * Float32Array.BYTES_PER_ELEMENT;
}

function emit(): void {
  if (simulation.count === 0) return;
  const buffer = spare.pop();
  // No buffer back from the renderer yet: keep simulating, drop the frame.
  if (!buffer || buffer.byteLength !== bytesNeeded()) return;
  const positions = new Float32Array(buffer, 0, simulation.count * 2);
  positions.set(simulation.positions);
  dirty = false;
  self.postMessage(
    { type: "frame", generation, positions, alpha: simulation.alpha },
    { transfer: [buffer] }
  );
}

function loop(): void {
  timer = null;
  if (!running) return;
  simulation.tick();
  dirty = true;
  emit();
  if (simulation.settled) {
    running = false;
    return;
  }
  timer = setTimeout(loop, TICK_MS);
}

function wake(): void {
  if (running) return;
  running = true;
  if (timer === null) timer = setTimeout(loop, 0);
}

self.onmessage = (event: MessageEvent<ForceRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "graph": {
      generation = message.generation;
      simulation.setSettings(message.settings);
      simulation.setGraph(message.count, message.links, message.seed, message.weights);
      // Fresh pool: buffers sized for the previous graph are useless now.
      spare.length = 0;
      const size = bytesNeeded();
      if (size > 0) spare.push(new ArrayBuffer(size), new ArrayBuffer(size));
      dirty = true;
      wake();
      break;
    }
    case "settings":
      simulation.setSettings(message.settings);
      simulation.reheat(0.35);
      wake();
      break;
    case "reheat":
      simulation.reheat(message.alpha ?? 0.55);
      wake();
      break;
    case "pin":
      simulation.pin(message.index, message.x, message.y);
      simulation.reheat(0.35);
      wake();
      break;
    case "release":
      simulation.release(message.index);
      simulation.reheat(0.25);
      wake();
      break;
    case "recycle":
      if (message.buffer.byteLength === bytesNeeded()) spare.push(message.buffer);
      // A layout that settled mid-flight still owes the renderer its final
      // positions; `dirty` keeps that to exactly one extra frame instead of
      // ping-ponging buffers forever.
      if (!running && dirty) emit();
      break;
    case "stop":
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      break;
  }
};
