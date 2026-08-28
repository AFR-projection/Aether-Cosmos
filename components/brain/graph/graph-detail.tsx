"use client";

import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { edgesOf, neighboursOf } from "@/lib/brain/graph/model";
import { memoryHref } from "@/lib/brain/graph/links";
import type { ResolvedGroups } from "@/lib/brain/graph/groups";
import type { GraphEdgeRelation, GraphModel } from "@/lib/brain/graph/types";
import type { GraphView } from "@/lib/brain/graph/view";

/**
 * The detail card for the selected node.
 *
 * Neighbours are read straight out of the CSR adjacency and filtered to what is
 * currently visible, so the card never offers to jump to a node the filter has
 * hidden. Clicking a neighbour selects it, which is how you walk the graph
 * without touching the canvas.
 */

const MAX_NEIGHBOURS = 40;

/** How an edge is described in the connection list. */
const RELATION_LABEL: Record<GraphEdgeRelation, string> = {
  explicit: "link",
  semantic: "wording",
  tag: "tag",
  entity: "entity",
  project: "project",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate text-right text-foreground">{value}</span>
    </div>
  );
}

export function GraphDetail({
  model,
  view,
  groups,
  selected,
  onSelect,
  onClose,
}: {
  model: GraphModel;
  view: GraphView;
  groups: ResolvedGroups;
  selected: number;
  onSelect: (modelIndex: number) => void;
  onClose: () => void;
}) {
  const node = model.nodes[selected];
  if (!node) return null;

  const neighbours = neighboursOf(model, selected);
  const touching = edgesOf(model, selected);
  const connections: {
    modelIndex: number;
    edgeIndex: number;
    tier: string;
    weight: number;
    reason: string | null;
  }[] = [];
  for (let k = 0; k < neighbours.length; k += 1) {
    const other = neighbours[k];
    const edgeIndex = touching[k];
    const edge = model.edges[edgeIndex];
    // Both ends on screen *and* this relationship's own tier switched on, so the
    // card lists exactly the edges the canvas is drawing — no more, no fewer.
    if (!edge || view.localOf[other] < 0 || !view.edgeVisible[edgeIndex]) continue;
    connections.push({
      modelIndex: other,
      edgeIndex,
      // A stored row names itself (link_type / relationship_type); a derived edge
      // has no name of its own, so it is described by the signal that produced it.
      tier: edge.kind === "derived" ? RELATION_LABEL[edge.relation] : edge.type,
      weight: edge.weight,
      reason: edge.reason,
    });
  }
  // Strongest first: the question this card answers is "what is this closest to".
  connections.sort((a, b) => b.weight - a.weight);
  const visible = connections.slice(0, MAX_NEIGHBOURS);
  const hiddenNeighbours = (view.visibleDegree[selected] ?? 0) - visible.length;
  // Entities have no page of their own yet, so only memories get an "open" link.
  const href = memoryHref(node);

  return (
    <aside
      aria-label="Selected node"
      className="pointer-events-auto w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/60 bg-surface/95 shadow-lg backdrop-blur"
    >
      <header className="flex items-start gap-2 border-b border-border/40 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: groups.colors[groups.groupOf[selected]] ?? groups.colors[0] }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground" title={node.label}>
            {node.label}
          </p>
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {node.kind} · {node.type}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-border/40 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      <div className="max-h-[52vh] overflow-y-auto">
        {node.detail ? (
          <p className="border-b border-border/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            {node.detail}
          </p>
        ) : null}

        <div className="space-y-1.5 border-b border-border/40 px-3 py-2.5">
          {node.projectName ? <Row label="Project" value={node.projectName} /> : null}
          {node.importance !== null ? <Row label="Importance" value={node.importance} /> : null}
          <Row label="Connections" value={view.visibleDegree[selected] ?? 0} />
          <Row
            label="Updated"
            value={new Date(node.updatedAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          />
          {node.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {node.tags.slice(0, 8).map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="px-3 py-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Connected
          </p>
          {visible.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No visible connections.</p>
          ) : (
            <ul className="space-y-0.5">
              {visible.map(({ modelIndex, edgeIndex, tier, weight, reason }) => (
                <li key={edgeIndex}>
                  <button
                    type="button"
                    onClick={() => onSelect(modelIndex)}
                    // Why this edge exists, in the words the server used. Hover is the
                    // right place for it: it explains without spending a row.
                    title={reason ?? `${tier} · strength ${Math.round(weight * 100)}%`}
                    className="flex w-full items-baseline justify-between gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/10"
                  >
                    <span className="truncate text-[11px] text-foreground">
                      {model.nodes[modelIndex]?.label}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {tier} · {Math.round(weight * 100)}%
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hiddenNeighbours > 0 ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              +{hiddenNeighbours} more not listed
            </p>
          ) : null}
        </div>
      </div>

      <footer className="border-t border-border/40 px-3 py-2">
        {href ? (
          <Link
            href={href}
            className="flex items-center gap-1 text-[11px] font-medium text-accent-ink transition-opacity hover:opacity-80"
          >
            Open memory
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Entity — {view.visibleDegree[selected] ?? 0} visible links
          </p>
        )}
      </footer>
    </aside>
  );
}
