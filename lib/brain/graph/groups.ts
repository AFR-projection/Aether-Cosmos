import { matchesQuery, parseGraphQuery } from "./query";
import type { GraphModel, GroupRule } from "./types";

/**
 * Grouping and colour.
 *
 * A group is a query plus a colour. Every node is painted by the FIRST group it
 * matches (deterministic, and easy to explain in the sidebar); nodes matching
 * nothing keep the neutral node colour. Resolution produces a Uint8Array of
 * group+1 per node, which is what the renderer batches its draw calls on — one
 * fill() per colour instead of one per node.
 */

/** Distinct hues that all stay legible on the dark graph canvas. */
export const GROUP_PALETTE = [
  "#f87171", // red
  "#fbbf24", // amber
  "#4ade80", // green
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#fb923c", // orange
  "#a3e635", // lime
  "#fda4af", // rose
] as const;

/** Groups can be added and removed; these are only the starting point. */
export const DEFAULT_GROUP_RULES: GroupRule[] = [
  { id: "group-person", query: "type:person", color: "#f87171" },
  { id: "group-project", query: "type:project", color: "#fbbf24" },
  { id: "group-organization", query: "type:organization", color: "#4ade80" },
  { id: "group-technology", query: "type:technology", color: "#60a5fa" },
  { id: "group-memory", query: "kind:memory", color: "#a78bfa" },
];

export const MAX_GROUPS = 12;

export function nextGroupColor(existing: readonly GroupRule[]): string {
  const used = new Set(existing.map((rule) => rule.color.toLowerCase()));
  return (
    GROUP_PALETTE.find((color) => !used.has(color)) ??
    GROUP_PALETTE[existing.length % GROUP_PALETTE.length]
  );
}

export function createGroupRule(existing: readonly GroupRule[], query = ""): GroupRule {
  return {
    // Date.now() alone collides when two groups are added in the same tick.
    id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    query,
    color: nextGroupColor(existing),
  };
}

export type ResolvedGroups = {
  /** 0 = ungrouped, otherwise the 1-based index into `rules`. */
  groupOf: Uint8Array;
  /** Node count painted by each rule, same order as `rules`. */
  counts: number[];
  /** Colours indexed the same way as `groupOf`; slot 0 is the neutral colour. */
  colors: string[];
};

export function resolveGroups(
  model: GraphModel,
  rules: readonly GroupRule[],
  visibleDegree: Int32Array,
  neutralColor: string
): ResolvedGroups {
  const groupOf = new Uint8Array(model.nodes.length);
  const counts = rules.map(() => 0);
  const colors = [neutralColor, ...rules.map((rule) => rule.color)];

  // Parsed once per resolve, not once per node.
  const compiled = rules.map((rule) => parseGraphQuery(rule.query));

  for (let i = 0; i < model.nodes.length; i += 1) {
    const node = model.nodes[i];
    const degree = visibleDegree[i] ?? 0;
    for (let r = 0; r < compiled.length; r += 1) {
      // An empty group query would claim every node and make the palette useless.
      if (compiled[r].matchesEverything) continue;
      if (matchesQuery(compiled[r], node, degree)) {
        groupOf[i] = r + 1;
        counts[r] += 1;
        break;
      }
    }
  }

  return { groupOf, counts, colors };
}
