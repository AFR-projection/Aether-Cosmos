import { matchesQuery, type CompiledQuery } from "./query";
import type { DisplaySettings, GraphEdgeRelation, GraphModel } from "./types";

/**
 * Filtering: model -> the subgraph currently on screen.
 *
 * The simulation only ever sees the visible subgraph, in its own dense 0..n-1
 * index space, so hiding half a graph makes the physics twice as cheap instead of
 * merely painting fewer circles. `localOf` maps model index -> local index (-1 when
 * hidden) and `nodesOf` maps back.
 */

export type GraphView = {
  /** Local index for each model node, or -1 when the node is filtered out. */
  localOf: Int32Array;
  /** Model node index for each local index. Length is `count`. */
  nodesOf: Int32Array;
  count: number;
  /** Model edge indexes that survived, in model order. */
  edgeIndexes: Int32Array;
  /**
   * 1 for every model edge that is on screen, indexed by model edge index. The
   * dense `edgeIndexes` list is what the renderer walks; this is what anything
   * holding a *model* edge index (hover highlighting, the detail card) needs in
   * order to agree with the canvas about which relationships exist right now.
   */
  edgeVisible: Uint8Array;
  /** Flat [sourceLocal, targetLocal] pairs, one per visible edge. */
  links: Int32Array;
  /** Weight per visible edge, parallel to `edgeIndexes`. Feeds the physics. */
  linkWeights: Float32Array;
  /** Degree counted over visible edges only, indexed by model node index. */
  visibleDegree: Int32Array;
  /** Summed visible edge weight per model node. Drives hub sizing. */
  visibleStrength: Float32Array;
  hiddenCount: number;
};

export const EMPTY_VIEW: GraphView = {
  localOf: new Int32Array(0),
  nodesOf: new Int32Array(0),
  count: 0,
  edgeIndexes: new Int32Array(0),
  edgeVisible: new Uint8Array(0),
  links: new Int32Array(0),
  linkWeights: new Float32Array(0),
  visibleDegree: new Int32Array(0),
  visibleStrength: new Float32Array(0),
  hiddenCount: 0,
};

/**
 * Options shared by both builders. `hidden` holds node ids the user removed by
 * hand from the context menu: it is applied with the kind toggles, before the
 * query, so a hidden node stops contributing degree exactly as an unchecked kind
 * does — otherwise its neighbours would keep counting a link to something that is
 * not on screen.
 */
export type ViewOptions = {
  query: CompiledQuery;
  display: DisplaySettings;
  hidden?: ReadonlySet<string>;
};

function tierVisible(display: DisplaySettings, relation: GraphEdgeRelation): boolean {
  switch (relation) {
    case "explicit":
      return display.showExplicitEdges;
    case "semantic":
      return display.showSemanticEdges;
    // Shared tags, shared entities and shared project are one control: they are all
    // "these two sit in the same context", and splitting one idea across three
    // checkboxes would not tell the user anything the single one does not.
    default:
      return display.showContextEdges;
  }
}

/**
 * Per-edge tier mask, or null when every tier is on — which is the default, so the
 * common path allocates nothing. A tier that is off is filtered at the *edge*: the
 * nodes stay, and a memory whose only relationship was switched off shows as an
 * orphan, which is what that filter actually means.
 */
function edgeTierMask(model: GraphModel, display: DisplaySettings): Uint8Array | null {
  if (display.showExplicitEdges && display.showSemanticEdges && display.showContextEdges) {
    return null;
  }
  const mask = new Uint8Array(model.edges.length);
  for (let e = 0; e < model.edges.length; e += 1) {
    mask[e] = tierVisible(display, model.edges[e].relation) ? 1 : 0;
  }
  return mask;
}

export function buildGraphView(model: GraphModel, options: ViewOptions): GraphView {
  const total = model.nodes.length;
  if (total === 0) return EMPTY_VIEW;

  const { query, display, hidden } = options;
  const anyHidden = hidden !== undefined && hidden.size > 0;
  const tierMask = edgeTierMask(model, display);

  // Pass 1 — kind toggles. Cheap, and it fixes the degree the query sees.
  const allowed = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const node = model.nodes[i];
    if (anyHidden && hidden.has(node.id)) continue;
    allowed[i] =
      (node.kind === "entity" ? display.showEntities : display.showMemories) ? 1 : 0;
  }

  const degreeAfterKind = new Int32Array(total);
  for (let e = 0; e < model.edges.length; e += 1) {
    if (tierMask !== null && !tierMask[e]) continue;
    const edge = model.edges[e];
    if (allowed[edge.source] && allowed[edge.target]) {
      degreeAfterKind[edge.source] += 1;
      degreeAfterKind[edge.target] += 1;
    }
  }

  // Pass 2 — the text query, evaluated against the degree from pass 1 so that
  // `is:orphan` means "nothing visible links here" rather than "no row in the DB".
  const visible = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    visible[i] = allowed[i] && matchesQuery(query, model.nodes[i], degreeAfterKind[i]) ? 1 : 0;
  }

  // Pass 3 — final edges and the degree that drives node size and orphan hiding.
  const visibleDegree = new Int32Array(total);
  const visibleStrength = new Float32Array(total);
  let edgeCount = 0;
  for (let e = 0; e < model.edges.length; e += 1) {
    if (tierMask !== null && !tierMask[e]) continue;
    const edge = model.edges[e];
    if (!visible[edge.source] || !visible[edge.target]) continue;
    const weight = model.edgeWeight[e];
    visibleDegree[edge.source] += 1;
    visibleDegree[edge.target] += 1;
    visibleStrength[edge.source] += weight;
    visibleStrength[edge.target] += weight;
    edgeCount += 1;
  }

  if (!display.showOrphans) {
    // Removing degree-0 nodes cannot remove an edge, so no further pass is needed.
    for (let i = 0; i < total; i += 1) {
      if (visible[i] && visibleDegree[i] === 0) visible[i] = 0;
    }
  }

  const localOf = new Int32Array(total).fill(-1);
  let count = 0;
  for (let i = 0; i < total; i += 1) if (visible[i]) localOf[i] = count++;

  const nodesOf = new Int32Array(count);
  for (let i = 0; i < total; i += 1) {
    const local = localOf[i];
    if (local >= 0) nodesOf[local] = i;
  }

  const edgeIndexes = new Int32Array(edgeCount);
  const edgeVisible = new Uint8Array(model.edges.length);
  const links = new Int32Array(edgeCount * 2);
  const linkWeights = new Float32Array(edgeCount);
  let slot = 0;
  for (let e = 0; e < model.edges.length; e += 1) {
    if (tierMask !== null && !tierMask[e]) continue;
    const edge = model.edges[e];
    const source = localOf[edge.source];
    const target = localOf[edge.target];
    if (source < 0 || target < 0) continue;
    edgeIndexes[slot] = e;
    edgeVisible[e] = 1;
    links[slot * 2] = source;
    links[slot * 2 + 1] = target;
    linkWeights[slot] = model.edgeWeight[e];
    slot += 1;
  }

  return {
    localOf,
    nodesOf,
    count,
    // Orphan hiding can shrink the edge set below the pass-3 count only when an
    // endpoint disappeared, which cannot happen; `slot === edgeCount` holds.
    edgeIndexes: slot === edgeCount ? edgeIndexes : edgeIndexes.subarray(0, slot),
    edgeVisible,
    links: slot === edgeCount ? links : links.subarray(0, slot * 2),
    linkWeights: slot === edgeCount ? linkWeights : linkWeights.subarray(0, slot),
    visibleDegree,
    visibleStrength,
    hiddenCount: total - count,
  };
}

/**
 * BFS from a focal node up to `depth` hops. Returns a GraphView restricted to
 * the focal node and all nodes reachable within the depth, obeying the same kind,
 * hidden, edge-tier and query filters as the global view.
 *
 * The focal node is exempt from the text query — a local graph that vanished
 * because its centre does not match the filter box would be a bug, not a filter —
 * but not from an explicit hide, which is a deliberate act on that node.
 */
export function buildLocalView(
  model: GraphModel,
  focalModelIndex: number,
  depth: number,
  options: ViewOptions
): GraphView {
  if (focalModelIndex < 0 || focalModelIndex >= model.nodes.length) return EMPTY_VIEW;

  const { query, display, hidden } = options;
  const anyHidden = hidden !== undefined && hidden.size > 0;
  if (anyHidden && hidden.has(model.nodes[focalModelIndex].id)) return EMPTY_VIEW;
  const tierMask = edgeTierMask(model, display);

  const visited = new Uint8Array(model.nodes.length);
  visited[focalModelIndex] = 1;
  let frontier = [focalModelIndex];
  for (let d = 0; d < depth && frontier.length > 0; d += 1) {
    const next: number[] = [];
    for (const node of frontier) {
      const start = model.offsets[node];
      const end = model.offsets[node + 1] ?? model.neighbours.length;
      for (let k = start; k < end; k += 1) {
        // A switched-off tier is not a path either: the local graph walks exactly
        // the relationships the canvas is drawing, so depth 1 always means "what I
        // can see one hop away" rather than "what a hidden edge would have reached".
        if (tierMask !== null && !tierMask[model.neighbourEdges[k]]) continue;
        const nb = model.neighbours[k];
        if (visited[nb]) continue;
        visited[nb] = 1;
        // A hidden node is a wall, not a stepping stone: hops are not counted
        // through something the user removed from the graph.
        if (anyHidden && hidden.has(model.nodes[nb].id)) continue;
        next.push(nb);
      }
    }
    frontier = next;
  }

  const allowed = new Uint8Array(model.nodes.length);
  for (let i = 0; i < model.nodes.length; i += 1) {
    if (!visited[i]) continue;
    const node = model.nodes[i];
    if (anyHidden && hidden.has(node.id)) continue;
    allowed[i] = (node.kind === "entity" ? display.showEntities : display.showMemories) ? 1 : 0;
  }

  const degreeAfterKind = new Int32Array(model.nodes.length);
  for (let e = 0; e < model.edges.length; e += 1) {
    if (tierMask !== null && !tierMask[e]) continue;
    const edge = model.edges[e];
    if (allowed[edge.source] && allowed[edge.target]) {
      degreeAfterKind[edge.source] += 1;
      degreeAfterKind[edge.target] += 1;
    }
  }

  const visible = new Uint8Array(model.nodes.length);
  for (let i = 0; i < model.nodes.length; i += 1) {
    if (!allowed[i]) continue;
    if (i === focalModelIndex) { visible[i] = 1; continue; }
    visible[i] = matchesQuery(query, model.nodes[i], degreeAfterKind[i]) ? 1 : 0;
  }

  const visibleDegree = new Int32Array(model.nodes.length);
  const visibleStrength = new Float32Array(model.nodes.length);
  let edgeCount = 0;
  for (let e = 0; e < model.edges.length; e += 1) {
    if (tierMask !== null && !tierMask[e]) continue;
    const edge = model.edges[e];
    if (!visible[edge.source] || !visible[edge.target]) continue;
    const weight = model.edgeWeight[e];
    visibleDegree[edge.source] += 1;
    visibleDegree[edge.target] += 1;
    visibleStrength[edge.source] += weight;
    visibleStrength[edge.target] += weight;
    edgeCount += 1;
  }

  if (!display.showOrphans) {
    for (let i = 0; i < model.nodes.length; i += 1) {
      if (visible[i] && visibleDegree[i] === 0 && i !== focalModelIndex) visible[i] = 0;
    }
  }

  const localOf = new Int32Array(model.nodes.length).fill(-1);
  let count = 0;
  let inScope = 0;
  for (let i = 0; i < model.nodes.length; i += 1) {
    if (visited[i]) inScope += 1;
    if (visible[i]) localOf[i] = count++;
  }

  const nodesOf = new Int32Array(count);
  for (let i = 0; i < model.nodes.length; i += 1) {
    const local = localOf[i];
    if (local >= 0) nodesOf[local] = i;
  }

  const edgeIndexes = new Int32Array(edgeCount);
  const edgeVisible = new Uint8Array(model.edges.length);
  const links = new Int32Array(edgeCount * 2);
  const linkWeights = new Float32Array(edgeCount);
  let slot = 0;
  for (let e = 0; e < model.edges.length; e += 1) {
    if (tierMask !== null && !tierMask[e]) continue;
    const edge = model.edges[e];
    const source = localOf[edge.source];
    const target = localOf[edge.target];
    if (source < 0 || target < 0) continue;
    edgeIndexes[slot] = e;
    edgeVisible[e] = 1;
    links[slot * 2] = source;
    links[slot * 2 + 1] = target;
    linkWeights[slot] = model.edgeWeight[e];
    slot += 1;
  }

  return {
    localOf,
    nodesOf,
    count,
    edgeIndexes: slot === edgeCount ? edgeIndexes : edgeIndexes.subarray(0, slot),
    edgeVisible,
    links: slot === edgeCount ? links : links.subarray(0, slot * 2),
    linkWeights: slot === edgeCount ? linkWeights : linkWeights.subarray(0, slot),
    visibleDegree,
    visibleStrength,
    // Counted against the BFS scope, not the whole brain: in local mode the
    // thousands of nodes outside the depth were never candidates, so calling them
    // "hidden by filters" would turn a useful number into noise.
    hiddenCount: inScope - count,
  };
}
