import type { ForceSettings } from "./types";

/**
 * Messages between the graph view and the physics worker.
 *
 * Positions travel as transferable ArrayBuffers and are handed back after each
 * frame ("recycle"), so a moving graph allocates nothing per frame and the worker
 * never outruns the renderer: if the main thread has not returned a buffer yet,
 * the worker simply keeps simulating and skips the send.
 */

export type ForceRequest =
  | {
      type: "graph";
      generation: number;
      count: number;
      links: Int32Array;
      /** One 0..1 strength per link, parallel to `links`. Null when unweighted. */
      weights: Float32Array | null;
      /**
       * Hops from the local graph's centre per node index, or null in the global
       * graph. Travels with the graph rather than with the settings because it is a
       * property of *this* subgraph; the ring spacing that uses it is a setting.
       */
      depths: Int32Array | null;
      seed: Float32Array | null;
      settings: ForceSettings;
    }
  | { type: "settings"; settings: ForceSettings }
  | { type: "reheat"; alpha?: number }
  | { type: "pin"; index: number; x: number; y: number }
  | { type: "release"; index: number }
  | { type: "recycle"; buffer: ArrayBuffer }
  | { type: "stop" };

export type ForceResponse = {
  type: "frame";
  generation: number;
  positions: Float32Array;
  alpha: number;
};
