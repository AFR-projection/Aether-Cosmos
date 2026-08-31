"use client";

import { Network } from "lucide-react";
import { EmptyState } from "@/ui/primitives/empty-state";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { GraphView } from "@brain/presentation/components/graph/graph-view";
import { useT } from "@/shared/lib/i18n";
import { useActiveBrain } from "@brain/presentation/hooks/use-brain";

/**
 * The graph page is deliberately thin: everything interactive lives in
 * @brain/presentation/components/graph, split into data/model, renderer, simulation, filtering,
 * grouping, interaction state and control UI. The page only picks the brain.
 */
export default function BrainGraphPage() {
  const { brain, isLoading } = useActiveBrain();
  const t = useT();

  return (
    <BrainShell title={t("brain.graph.title")} description={t("brain.graph.description")}>
      {!brain && !isLoading ? (
        <EmptyState
          icon={Network}
          title={t("brain.graph.noBrainTitle")}
          description={t("brain.graph.noBrainBody")}
        />
      ) : (
        <GraphView brainId={brain?.id} />
      )}
    </BrainShell>
  );
}
