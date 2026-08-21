"use client";

import { Network } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { BrainShell } from "@/components/brain/brain-shell";
import { GraphView } from "@/components/brain/graph/graph-view";
import { useActiveBrain } from "@/hooks/use-brain";

/**
 * The graph page is deliberately thin: everything interactive lives in
 * components/brain/graph, split into data/model, renderer, simulation, filtering,
 * grouping, interaction state and control UI. The page only picks the brain.
 */
export default function BrainGraphPage() {
  const { brain, isLoading } = useActiveBrain();

  return (
    <BrainShell
      title="Graph"
      description="Every entity and memory in this brain as a force-directed graph. Drag to pan, scroll to zoom, drag a node to move it."
    >
      {!brain && !isLoading ? (
        <EmptyState
          icon={Network}
          title="No brain selected"
          description="Create or pick a brain to see its knowledge graph."
        />
      ) : (
        <GraphView brainId={brain?.id} />
      )}
    </BrainShell>
  );
}
