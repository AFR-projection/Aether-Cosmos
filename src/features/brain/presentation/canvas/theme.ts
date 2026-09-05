import type { Tint } from "./cosmos";
import type { EdgeTier } from "./edge-style";

/**
 * Colour for the graph canvas.
 *
 * Deliberately dark in both app themes: the graph is a viewport into space, and both
 * a starfield and a thin grey edge only read against a dark ground. Only the accent
 * is taken from the app tokens, so a highlight in here matches a button out there.
 *
 * This is the one place in the feature that holds raw hex. Components must not — the
 * rule is tokens from app/globals.css — but a canvas has no cascade to read them
 * from, so the values live in a single constant that the whole renderer shares
 * instead of being scattered across draw calls.
 */

export type GraphTheme = {
  /** Outer tone of the deep-field wash, and the fill behind an empty graph. */
  background: string;
  /** Centre of the wash. Lighter, so the canvas has a middle. */
  backgroundCore: string;
  node: string;
  /** One colour per relationship tier, so an edge says where it came from. */
  edgeTiers: Record<EdgeTier, string>;
  edgeActive: string;
  label: string;
  /** Drawn behind labels so they survive a star passing under them. */
  labelHalo: string;
  accent: string;
  star: string;
  /** Corner falloff painted over the finished frame, to frame it like a viewport. */
  vignette: string;
  nebula: readonly Tint[];
};

export const FALLBACK_THEME: GraphTheme = {
  background: "#070b16",
  backgroundCore: "#10162a",
  // Ungrouped nodes. Cooler and a shade brighter than a neutral grey: most nodes in
  // a young brain match no group rule, and a grey disc on a blue ground reads as an
  // absence rather than as a node.
  node: "#a3abc9",
  edgeTiers: {
    // A link the user stored is the strongest claim in the graph, so it carries the
    // accent. Wording similarity is a machine's guess: adjacent, clearly not the
    // same. Shared surroundings are the most numerous and the least specific, so
    // they recede into the background almost entirely.
    explicit: "#818cf8",
    semantic: "#c084fc",
    context: "#5a6b8c",
  },
  edgeActive: "#818cf8",
  label: "rgba(226, 232, 240, 0.94)",
  labelHalo: "rgba(5, 7, 15, 0.85)",
  accent: "#818cf8",
  star: "#e2e8f5",
  vignette: "rgba(3, 5, 12, 0.44)",
  // Night indigo, dream violet, ion cyan — each painted at a few percent alpha.
  nebula: [
    [67, 56, 202],
    [124, 58, 237],
    [34, 211, 238],
  ],
};

/** Reads `--accent` off the live element so highlights match the rest of the app. */
export function readGraphTheme(element: HTMLElement | null): GraphTheme {
  if (!element || typeof window === "undefined") return FALLBACK_THEME;
  const accent = getComputedStyle(element).getPropertyValue("--accent").trim();
  if (!accent) return FALLBACK_THEME;
  return {
    ...FALLBACK_THEME,
    accent,
    edgeActive: accent,
    // Explicit links are the user's own, so they follow the app's accent too.
    edgeTiers: { ...FALLBACK_THEME.edgeTiers, explicit: accent },
  };
}
