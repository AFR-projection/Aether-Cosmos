"use client";

import { Suspense, useEffect, useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { Network } from "lucide-react";
import { GraphView } from "@/components/brain/graph/graph-view";
import { useBrains } from "@/hooks/use-brain";
import {
  getActiveBrainId,
  getServerActiveBrainId,
  subscribeActiveBrain,
} from "@/lib/brain/active-brain";

/**
 * The standalone graph workspace — what the pop-out button opens.
 *
 * Independent UI, identical data: it mounts the same GraphView as the in-app page,
 * reads the same per-brain settings out of localStorage (so a change made here or
 * there shows up in both), and subscribes to the same write notifications, so a
 * memory saved in the main window redraws this graph without a refresh.
 *
 * The brain comes from the query string rather than from the active-brain store,
 * so the window keeps showing the brain it was opened for even if the main window
 * switches to another one. The snapshot endpoint authorizes that id server-side.
 */

function Workspace() {
  const params = useSearchParams();
  const requested = params.get("brain");
  const focus = params.get("focus");

  const { data, isLoading } = useBrains();
  const brains = data?.brains;
  // Read through the store, not straight from localStorage: the render output must
  // match on the server (null) and on the client's first pass.
  const stored = useSyncExternalStore(
    subscribeActiveBrain,
    getActiveBrainId,
    getServerActiveBrainId
  );

  // Falls back to the stored active brain, so the URL is usable without the param.
  const brainId = useMemo(() => {
    if (requested) return requested;
    if (stored) return stored;
    const list = brains ?? [];
    return (list.find((brain) => brain.isDefault) ?? list[0])?.id;
  }, [brains, requested, stored]);

  const brain = brains?.find((item) => item.id === brainId);

  useEffect(() => {
    document.title = brain ? `${brain.name} · Graph` : "Graph workspace";
  }, [brain]);

  if (!brainId && !isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center px-8 text-center">
        <p className="text-sm text-muted-foreground">
          No brain to graph. Open the graph from the app and use the pop-out button.
        </p>
      </div>
    );
  }

  return <GraphView brainId={brainId} focusNodeId={focus} isPopup />;
}

export default function GraphWorkspacePage() {
  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-[#0d1117]">
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Network className="h-4 w-4 animate-pulse" aria-hidden="true" />
            Loading graph…
          </div>
        }
      >
        <Workspace />
      </Suspense>
    </main>
  );
}
