"use client";

import { useMemo, useState } from "react";
import { Network, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useActiveBrain, useEntities, useRelationships } from "@/hooks/use-brain";

/**
 * Knowledge graph, rendered as an adjacency view rather than a force layout.
 *
 * §40 asks that a graph of thousands of nodes must not freeze the browser. A
 * force-directed canvas is the thing most likely to do exactly that, so this view
 * stays deterministic: nodes are grouped, edges are listed per node, and the node
 * list is capped and filterable. It answers "what is connected to what" without
 * simulating physics on every frame.
 */

const NODE_LIMIT = 60;

const TYPE_TONE: Record<string, string> = {
  person: "bg-accent/10 text-accent",
  project: "bg-success/10 text-success",
  technology: "bg-warning/10 text-warning",
  product: "bg-warning/10 text-warning",
  organization: "bg-accent/10 text-accent",
};

export default function BrainGraphPage() {
  const { brain } = useActiveBrain();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const debouncedSearch = useDebouncedValue(search);
  const entities = useEntities(brain?.id, debouncedSearch);
  const relationships = useRelationships(brain?.id);

  const nodes = entities.data?.entities ?? [];
  // Memoized so the `?? []` fallback does not hand useMemo a fresh array each render.
  const edges = useMemo(
    () => relationships.data?.relationships ?? [],
    [relationships.data]
  );

  const edgesByEntity = useMemo(() => {
    const map = new Map<string, { label: string; direction: "out" | "in"; other: string }[]>();
    for (const edge of edges) {
      const out = map.get(edge.sourceEntityId) ?? [];
      out.push({ label: edge.type, direction: "out", other: edge.target });
      map.set(edge.sourceEntityId, out);

      const incoming = map.get(edge.targetEntityId) ?? [];
      incoming.push({ label: edge.type, direction: "in", other: edge.source });
      map.set(edge.targetEntityId, incoming);
    }
    return map;
  }, [edges]);

  const visible = nodes.slice(0, NODE_LIMIT);
  const activeNode = visible.find((node) => node.id === selected) ?? null;
  const activeEdges = activeNode ? (edgesByEntity.get(activeNode.id) ?? []) : [];

  return (
    <BrainShell
      title="Graph"
      description="Entities this brain knows about, and how they relate. Pick a node to see its edges."
    >
      <div className="space-y-5">
        <div className="flex items-center gap-2 rounded-2xl border border-border/50 bg-surface p-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter entities by name…"
            aria-label="Filter entities"
            className="border-0 bg-transparent focus-visible:ring-0"
          />
          <span className="shrink-0 text-xs text-muted-foreground">
            {nodes.length} node{nodes.length === 1 ? "" : "s"} · {edges.length} edge
            {edges.length === 1 ? "" : "s"}
          </span>
        </div>

        {(entities.isLoading || relationships.isLoading) && <BrainLoading label="Loading graph" />}
        {entities.isError && (
          <BrainErrorState
            message="Could not load the graph."
            onRetry={() => void entities.refetch()}
          />
        )}

        {entities.data && nodes.length === 0 && (
          <EmptyState
            icon={Network}
            title={debouncedSearch ? "No entities match that filter" : "The graph is empty"}
            description={
              debouncedSearch
                ? "Try a shorter search term."
                : "Entities and relationships appear here as agents record them with brain_link, or as you add them through the API."
            }
          />
        )}

        {nodes.length > 0 && (
          <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
            <BrainPanel icon={Network} title="Entities">
              <ul className="flex flex-wrap gap-2">
                {visible.map((node) => {
                  const degree = edgesByEntity.get(node.id)?.length ?? 0;
                  const isActive = node.id === selected;
                  return (
                    <li key={node.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(isActive ? null : node.id)}
                        aria-pressed={isActive}
                        className={cn(
                          "flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                          isActive
                            ? "border-accent/40 bg-accent/10 text-foreground"
                            : "border-border/50 bg-surface hover:border-accent/30 hover:bg-surface-hover"
                        )}
                      >
                        <span className="font-medium">{node.name}</span>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                            TYPE_TONE[node.type] ?? "bg-muted/40 text-muted-foreground"
                          )}
                        >
                          {node.type}
                        </span>
                        {degree > 0 && (
                          <span className="text-[11px] text-muted-foreground">{degree}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {nodes.length > NODE_LIMIT && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Showing {NODE_LIMIT} of {nodes.length}. Use the filter to narrow the graph.
                </p>
              )}
            </BrainPanel>

            <BrainPanel icon={Network} title={activeNode ? activeNode.name : "Connections"}>
              {!activeNode && (
                <p className="text-sm text-muted-foreground">
                  Select an entity to see what it is connected to.
                </p>
              )}

              {activeNode && (
                <div className="space-y-3">
                  {activeNode.description && (
                    <p className="text-sm text-muted-foreground">{activeNode.description}</p>
                  )}

                  {activeEdges.length > 0 ? (
                    <ul className="space-y-2">
                      {activeEdges.map((edge, index) => (
                        <li
                          key={`${edge.direction}-${edge.label}-${edge.other}-${index}`}
                          className="rounded-xl border border-border/40 px-3 py-2 text-sm"
                        >
                          {edge.direction === "out" ? (
                            <span className="text-foreground">
                              <span className="text-muted-foreground">{activeNode.name}</span>{" "}
                              <span className="text-accent">--{edge.label}--&gt;</span>{" "}
                              {edge.other}
                            </span>
                          ) : (
                            <span className="text-foreground">
                              {edge.other}{" "}
                              <span className="text-accent">--{edge.label}--&gt;</span>{" "}
                              <span className="text-muted-foreground">{activeNode.name}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Nothing links to this entity yet.
                    </p>
                  )}
                </div>
              )}
            </BrainPanel>
          </div>
        )}
      </div>
    </BrainShell>
  );
}
