"use client";

import { PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useBrainDataSync, useBrainGraph } from "@brain/presentation/hooks/use-brain";
import { useGraphCanvas, type GraphCanvasHandle } from "@brain/presentation/hooks/use-graph-canvas";
import { useGraphEngine } from "@brain/presentation/hooks/use-graph-engine";
import { useGraphInteraction } from "@brain/presentation/hooks/use-graph-interaction";
import { useGraphSettings } from "@brain/presentation/hooks/use-graph-settings";
import { BrainErrorState, BrainLoading } from "@brain/presentation/components/brain-states";
import { resolveGroups } from "@brain/presentation/canvas/groups";
import { memoryHref, nodeShareUrl, openGraphPopup } from "@brain/presentation/canvas/links";
import { buildGraphModel, emptyGraphModel } from "@brain/presentation/canvas/model";
import { parseGraphQuery } from "@brain/presentation/canvas/query";
import { FALLBACK_THEME, panCamera } from "@brain/presentation/canvas/renderer";
import { DEFAULT_DISPLAY_SETTINGS, type GraphModel } from "@brain/presentation/canvas/types";
import { buildGraphView, buildLocalView, type GraphView as GraphViewShape } from "@brain/presentation/canvas/view";
import { notify } from "@/shared/lib/system/notify-store";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import { GraphCanvas } from "./graph-canvas";
import { GraphContextMenu, type GraphContextMenuAction } from "./graph-context-menu";
import { GraphControls } from "./graph-controls";
import { GraphDetail } from "./graph-detail";

/**
 * Composition root for the graph view.
 *
 * The pipeline is one direction only: snapshot -> model -> query -> view ->
 * groups -> engine -> canvas. Each stage is memoized on exactly what it reads, so
 * dragging a physics slider does not rebuild the view and typing in the filter does
 * not rebuild the model.
 *
 * Global and local graphs differ by one call in that pipeline — buildLocalView
 * instead of buildGraphView — and share the renderer, the physics, the interaction
 * hook, the controls and the detail card entirely. Behaviour cannot drift between
 * the two modes because there is only one of everything.
 *
 * All user-visible settings live in the per-brain store (@brain/presentation/hooks/use-graph-settings),
 * not in component state, which is what makes them survive a refresh and reach the
 * popped-out window. The camera and the hover/selection stay local: they are about
 * this viewport, not about this brain.
 *
 * The canvas and the interaction hooks need each other (interaction needs hitTest,
 * the canvas needs hover and the camera). The cycle is broken with stable callbacks
 * that read a ref holding the canvas handle, so neither hook has to be recreated.
 */

/** Best default centre for the local graph: the most connected visible node. */
function busiestNodeId(model: GraphModel, view: GraphViewShape): string | null {
  let best = -1;
  let bestDegree = -1;
  for (let local = 0; local < view.count; local += 1) {
    const modelIndex = view.nodesOf[local];
    const degree = view.visibleDegree[modelIndex] ?? 0;
    if (degree > bestDegree) {
      bestDegree = degree;
      best = modelIndex;
    }
  }
  return best >= 0 ? (model.nodes[best]?.id ?? null) : null;
}

export function GraphView({
  brainId,
  /** Standalone workspace window: fills the viewport and offers no second pop-out. */
  isPopup = false,
  /** Node id from a shared link. Opens the local graph on it, once, when it exists. */
  focusNodeId = null,
}: {
  brainId: string | undefined;
  isPopup?: boolean;
  focusNodeId?: string | null;
}) {
  const { data, isLoading, isError, error, refetch } = useBrainGraph(brainId);
  // Writes made in another document (the main window, a second tab) land here.
  useBrainDataSync(brainId);
  const t = useT();

  const { settings, update } = useGraphSettings(brainId);
  const { query, groups, force, display, localMode, localDepth, localFocalId, hiddenIds } =
    settings;

  const [panelOpen, setPanelOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const shellRef = useRef<HTMLDivElement | null>(null);
  /**
   * The canvas arrives as state, not as a ref: it only mounts once the graph has
   * loaded, and the hooks below attach native listeners and build the renderer
   * against it, which an effect keyed on a ref object would miss entirely.
   */
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const handleRef = useRef<GraphCanvasHandle | null>(null);

  const model = useMemo(() => (data ? buildGraphModel(data) : emptyGraphModel()), [data]);

  // Deferred so a long graph never blocks a keystroke in the filter box.
  const deferredQuery = useDeferredValue(query);
  const compiled = useMemo(() => parseGraphQuery(deferredQuery), [deferredQuery]);

  const hidden = useMemo(
    () => (hiddenIds.length > 0 ? new Set(hiddenIds) : undefined),
    [hiddenIds]
  );

  const focalIndex = localFocalId ? (model.indexById.get(localFocalId) ?? -1) : -1;
  const localActive = localMode && focalIndex >= 0;

  const {
    showEntities,
    showMemories,
    showOrphans,
    showExplicitEdges,
    showSemanticEdges,
    showContextEdges,
  } = display;
  const view = useMemo(() => {
    // Only these fields change the visible set; the scales are paint-only. The three
    // tier flags belong here too: a tier that is off is filtered at the edge, so the
    // view — not the renderer — is what has to know about it.
    const options = {
      query: compiled,
      display: {
        ...DEFAULT_DISPLAY_SETTINGS,
        showEntities,
        showMemories,
        showOrphans,
        showExplicitEdges,
        showSemanticEdges,
        showContextEdges,
      },
      hidden,
    };
    return localActive
      ? buildLocalView(model, focalIndex, localDepth, options)
      : buildGraphView(model, options);
  }, [
    compiled,
    focalIndex,
    hidden,
    localActive,
    localDepth,
    model,
    showEntities,
    showMemories,
    showOrphans,
    showExplicitEdges,
    showSemanticEdges,
    showContextEdges,
  ]);

  const resolved = useMemo(
    // Ungrouped nodes keep the renderer's neutral node colour.
    () => resolveGroups(model, groups, view.visibleDegree, FALLBACK_THEME.node),
    [groups, model, view]
  );

  const engine = useGraphEngine({ model, view, settings: force });

  const hitTest = useCallback(
    (x: number, y: number) => handleRef.current?.hitTest(x, y) ?? -1,
    []
  );
  const requestDraw = useCallback(() => handleRef.current?.requestDraw(), []);

  /**
   * Make a node the local graph's centre. Double-click and the context menu both
   * land here, so "recentre" means one thing everywhere. The refit is deferred to
   * the canvas, which waits for the new subgraph to take shape before framing it.
   */
  const focusLocal = useCallback(
    (modelIndex: number) => {
      const node = model.nodes[modelIndex];
      if (!node) return;
      update({ localMode: true, localFocalId: node.id });
      handleRef.current?.requestFit();
    },
    [model, update]
  );

  const interaction = useGraphInteraction({
    model,
    view,
    engine,
    canvas,
    hitTest,
    requestDraw,
    onActivate: focusLocal,
  });

  const handle = useGraphCanvas({
    canvas,
    model,
    view,
    groups: resolved,
    display,
    engine,
    camera: interaction.camera,
    setCamera: interaction.setCamera,
    hover: interaction.hover,
    selected: interaction.selected,
    focal: localActive ? focalIndex : -1,
    highlightNodes: interaction.highlightNodes,
    highlightEdges: interaction.highlightEdges,
  });

  // The backend flag is external state (the worker may fail to load at any time),
  // so it is read through a store rather than mirrored into component state.
  const workerActive = useSyncExternalStore(
    engine.subscribeBackend,
    engine.getBackend,
    () => false
  );

  useEffect(() => {
    handleRef.current = handle;
  }, [handle]);

  // A shared link carries the node it is about. Applied once, and only after the
  // snapshot has arrived — before that the id cannot be checked against anything.
  const appliedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNodeId || appliedFocus.current === focusNodeId) return;
    if (!model.indexById.has(focusNodeId)) return;
    appliedFocus.current = focusNodeId;
    update({
      localMode: true,
      localFocalId: focusNodeId,
      // Unhide the linked node so the link cannot land on an empty canvas, but leave
      // the rest of the user's hidden set alone.
      hiddenIds: hiddenIds.filter((id) => id !== focusNodeId),
    });
  }, [focusNodeId, hiddenIds, model, update]);

  // Fullscreen is owned by the browser: mirror it from the event rather than
  // assuming the request succeeded, so Escape and F11 stay in sync with the button.
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = shellRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      void document.exitFullscreen();
      return;
    }
    void element.requestFullscreen().catch(() => {
      notify({ title: t("brain.graph.fullscreenRefused"), tone: "error" });
    });
  }, [t]);

  const setQuery = useCallback((next: string) => update({ query: next }), [update]);
  const panBy = useCallback(
    (dx: number, dy: number) =>
      interaction.setCamera(panCamera(interaction.camera.current, dx, dy)),
    [interaction]
  );

  /**
   * Turning local mode on needs a centre. The current selection is the obvious
   * candidate; failing that the busiest visible node, which is the most useful
   * place to start exploring. Only when the graph is empty does the toggle land
   * without a focus, and then the panel says so.
   */
  const setLocalMode = useCallback(
    (next: boolean) => {
      if (!next) {
        update({ localMode: false });
        handleRef.current?.requestFit();
        return;
      }
      const keep = focalIndex >= 0 ? localFocalId : null;
      const picked =
        keep ??
        (interaction.selected >= 0 ? (model.nodes[interaction.selected]?.id ?? null) : null) ??
        busiestNodeId(model, view);
      update({ localMode: true, localFocalId: picked });
      handleRef.current?.requestFit();
    },
    [focalIndex, interaction.selected, localFocalId, model, update, view]
  );

  const hideNode = useCallback(
    (modelIndex: number) => {
      const node = model.nodes[modelIndex];
      if (!node) return;
      update({
        hiddenIds: [...hiddenIds.filter((id) => id !== node.id), node.id],
        // Hiding the centre would leave the local graph with nothing to be about.
        ...(node.id === localFocalId ? { localFocalId: null } : null),
      });
      if (interaction.selected === modelIndex) interaction.clear();
    },
    [hiddenIds, interaction, localFocalId, model, update]
  );

  const copyLink = useCallback(
    (modelIndex: number) => {
      const node = model.nodes[modelIndex];
      const url = node ? nodeShareUrl(brainId, node) : null;
      if (!url) {
        notify({ title: t("brain.graph.noLink"), tone: "error" });
        return;
      }
      const write = navigator.clipboard?.writeText(url);
      if (!write) {
        notify({ title: t("brain.graph.clipboardUnavailable"), tone: "error" });
        return;
      }
      void write.then(
        () => notify({ title: t("brain.graph.linkCopied"), tone: "success" }),
        () => notify({ title: t("brain.graph.copyFailed"), tone: "error" })
      );
    },
    [brainId, model, t]
  );

  const popOut = useCallback(() => {
    if (!openGraphPopup(brainId, localActive ? localFocalId : null)) {
      // Same wording as the sidebar's pop-out: one failure, one sentence.
      notify({ title: t("brain.nav.popupBlocked"), tone: "error" });
    }
  }, [brainId, localActive, localFocalId, t]);

  const runContextAction = useCallback(
    (action: GraphContextMenuAction, modelIndex: number) => {
      switch (action) {
        case "open-note": {
          const href = memoryHref(model.nodes[modelIndex]);
          // Opened in a tab rather than navigated to: leaving the graph would throw
          // away the layout, and the graph is usually the thing you came back to.
          if (href) window.open(href, "_blank", "noopener,noreferrer");
          break;
        }
        case "open-local":
          focusLocal(modelIndex);
          break;
        case "focus":
          interaction.select(modelIndex);
          handleRef.current?.centerOn(modelIndex);
          break;
        case "copy-link":
          copyLink(modelIndex);
          break;
        case "hide":
          hideNode(modelIndex);
          break;
      }
    },
    [copyLink, focusLocal, hideNode, interaction, model]
  );

  if (!brainId || isLoading) return <BrainLoading label={t("brain.graph.loading")} rows={2} />;
  if (isError) {
    return (
      <BrainErrorState
        message={error instanceof Error ? error.message : t("brain.graph.loadFailed")}
        onRetry={() => void refetch()}
      />
    );
  }

  const hoverIndex = interaction.hover >= 0 ? interaction.hover : -1;
  const focalLabel = focalIndex >= 0 ? (model.nodes[focalIndex]?.label ?? null) : null;

  return (
    <div
      ref={shellRef}
      className={cn(
        "relative flex overflow-hidden bg-surface",
        isPopup
          ? "h-full w-full"
          : "h-[calc(100vh-14rem)] min-h-[520px] rounded-2xl border border-border/50 shadow-md",
        // Fullscreen paints the whole screen: the rounded card would show its
        // corners against black.
        fullscreen && "h-screen w-screen rounded-none border-0"
      )}
    >
      <div className="relative min-w-0 flex-1">
        <GraphCanvas
          canvasRef={setCanvas}
          handlers={interaction.handlers}
          onPan={panBy}
          onZoomIn={() => interaction.zoomBy(1.25)}
          onZoomOut={() => interaction.zoomBy(0.8)}
          onFit={() => handleRef.current?.fit()}
          hoverLabel={hoverIndex >= 0 ? (model.nodes[hoverIndex]?.label ?? null) : null}
          onToggleFullscreen={toggleFullscreen}
          fullscreen={fullscreen}
          onPopOut={isPopup ? undefined : popOut}
        />

        <button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          aria-expanded={panelOpen}
          aria-label={panelOpen ? t("brain.graph.hideControls") : t("brain.graph.showControls")}
          className="absolute left-3 top-3 rounded-lg border border-border/50 bg-surface/90 p-1.5 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          {panelOpen ? (
            <PanelRightClose className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
          )}
        </button>

        {localActive ? (
          <p className="pointer-events-none absolute left-14 top-3 max-w-[45%] truncate rounded-lg border border-accent/25 bg-accent/10 px-2 py-1.5 text-[11px] font-medium text-accent-ink">
            {/* One key for the whole badge: the middle dots and the order of the
                three parts are wording, not layout. */}
            {t("brain.graph.localBadge", {
              label: focalLabel ?? "",
              hops: t("brain.graph.hops", { count: localDepth }),
            })}
          </p>
        ) : null}

        {interaction.selected >= 0 ? (
          <div className="pointer-events-none absolute left-3 top-14 z-10">
            <GraphDetail
              model={model}
              view={view}
              groups={resolved}
              selected={interaction.selected}
              onSelect={interaction.select}
              onClose={interaction.clear}
            />
          </div>
        ) : null}

        {view.count === 0 ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {model.nodes.length === 0
              ? t("brain.graph.emptyModel")
              : localMode && focalIndex < 0
                ? t("brain.graph.emptyPickNode")
                : t("brain.graph.emptyFilter")}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "absolute inset-y-0 right-0 z-20 w-[19rem] max-w-full border-l border-border/50 bg-surface transition-transform duration-200 lg:static lg:z-0",
          panelOpen ? "translate-x-0" : "translate-x-full lg:hidden"
        )}
      >
        <GraphControls
          model={model}
          view={view}
          query={query}
          onQueryChange={setQuery}
          groups={groups}
          onGroupsChange={(next) => update({ groups: next })}
          resolved={resolved}
          force={force}
          onForceChange={(next) => update({ force: next })}
          display={display}
          onDisplayChange={(next) => update({ display: next })}
          localMode={localMode}
          onLocalModeChange={setLocalMode}
          localDepth={localDepth}
          onLocalDepthChange={(depth) => update({ localDepth: depth })}
          localFocalLabel={focalLabel}
          hiddenCount={hiddenIds.length}
          onRestoreHidden={() => update({ hiddenIds: [] })}
          onReplayAnimation={() => handleRef.current?.restartAnimation()}
          workerActive={workerActive}
        />
      </div>

      {interaction.contextMenu ? (
        <GraphContextMenu
          model={model}
          modelIndex={interaction.contextMenu.modelIndex}
          x={interaction.contextMenu.x}
          y={interaction.contextMenu.y}
          isFocal={interaction.contextMenu.modelIndex === focalIndex}
          onAction={runContextAction}
          onClose={interaction.closeContextMenu}
        />
      ) : null}
    </div>
  );
}
