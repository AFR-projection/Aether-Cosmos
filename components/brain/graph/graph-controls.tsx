"use client";

import { useMemo } from "react";
import {
  Eye,
  EyeOff,
  GitFork,
  Link2,
  Palette,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Sliders,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_GROUPS, createGroupRule, type ResolvedGroups } from "@/lib/brain/graph/groups";
import {
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_FORCE_SETTINGS,
  type DisplaySettings,
  type ForceSettings,
  type GraphModel,
  type GroupRule,
} from "@/lib/brain/graph/types";
import type { GraphView } from "@/lib/brain/graph/view";
import { cn } from "@/lib/utils";
import { GraphSlider } from "./graph-slider";

/**
 * The control panel: filters, groups, forces, display.
 *
 * Every control is a controlled input over state owned by GraphView, so a change
 * flows filter -> view -> simulation in the same commit and the graph updates live
 * without a reload. Nothing here touches the canvas or the physics directly.
 */

function Section({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: typeof Search;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border/40 px-4 py-4 last:border-b-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-accent-ink" aria-hidden="true" />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Toggle({
  label,
  pressed,
  onToggle,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors",
        pressed
          ? "border-accent/40 bg-accent/10 text-accent-ink"
          : "border-border/60 bg-surface text-muted-foreground hover:border-accent/30 hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

/** One label/value row, used by the footer counters and the dev diagnostics. */
function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className={cn("tabular-nums", tone)}>{value}</span>
    </div>
  );
}

/** Adds the token if the query does not already contain it, removes it if it does. */
function toggleToken(query: string, token: string): string {
  const parts = query.split(/\s+/).filter(Boolean);
  const at = parts.indexOf(token);
  if (at >= 0) {
    parts.splice(at, 1);
    return parts.join(" ");
  }
  return [...parts, token].join(" ");
}

function Chip({
  token,
  query,
  onQueryChange,
}: {
  token: string;
  query: string;
  onQueryChange: (next: string) => void;
}) {
  const active = query.split(/\s+/).includes(token);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onQueryChange(toggleToken(query, token))}
      className={cn(
        "max-w-full truncate rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors",
        active
          ? "border-accent/50 bg-accent/15 text-accent-ink"
          : "border-border/50 bg-surface text-muted-foreground hover:border-accent/30 hover:text-foreground"
      )}
      title={token}
    >
      {token}
    </button>
  );
}

export type GraphControlsProps = {
  model: GraphModel;
  view: GraphView;
  query: string;
  onQueryChange: (next: string) => void;
  groups: GroupRule[];
  onGroupsChange: (next: GroupRule[]) => void;
  resolved: ResolvedGroups;
  force: ForceSettings;
  onForceChange: (next: ForceSettings) => void;
  display: DisplaySettings;
  onDisplayChange: (next: DisplaySettings) => void;
  /** Local graph: only what is within `localDepth` hops of the focal node. */
  localMode: boolean;
  onLocalModeChange: (next: boolean) => void;
  localDepth: number;
  onLocalDepthChange: (next: number) => void;
  /** Label of the focal node, or null when nothing is focused yet. */
  localFocalLabel: string | null;
  /**
   * How many nodes the user hid by hand from the context menu. Separate from
   * `view.hiddenCount`, which counts what the filters and kind toggles removed.
   */
  hiddenCount: number;
  /** Puts every hand-hidden node back. */
  onRestoreHidden: () => void;
  /** Plays the timelapse again from the first node. */
  onReplayAnimation: () => void;
  /** Whether physics is running off the main thread, shown as a badge. */
  workerActive: boolean;
};

export function GraphControls({
  model,
  view,
  query,
  onQueryChange,
  groups,
  onGroupsChange,
  resolved,
  force,
  onForceChange,
  display,
  onDisplayChange,
  localMode,
  onLocalModeChange,
  localDepth,
  onLocalDepthChange,
  localFocalLabel,
  hiddenCount,
  onRestoreHidden,
  onReplayAnimation,
  workerActive,
}: GraphControlsProps) {
  const setForce = (patch: Partial<ForceSettings>) => onForceChange({ ...force, ...patch });
  const setDisplay = (patch: Partial<DisplaySettings>) =>
    onDisplayChange({ ...display, ...patch });

  /**
   * Per-tier counts of what is actually on screen. Taken from the view rather than
   * from the snapshot's own stats: the snapshot counts the whole brain, and the
   * number next to a toggle has to answer "how many of these am I looking at".
   */
  const visibleByTier = useMemo(() => {
    const counts = { explicit: 0, semantic: 0, context: 0 };
    for (let i = 0; i < view.edgeIndexes.length; i += 1) {
      const relation = model.edges[view.edgeIndexes[i]]?.relation;
      if (relation === "explicit") counts.explicit += 1;
      else if (relation === "semantic") counts.semantic += 1;
      else counts.context += 1;
    }
    return counts;
  }, [model, view]);

  const allTiersOff =
    !display.showExplicitEdges && !display.showSemanticEdges && !display.showContextEdges;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title="Local graph" icon={GitFork}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {localMode
              ? "Showing only what connects to the focused node."
              : "Showing the whole brain."}
          </p>
          <Toggle
            label={localMode ? "Local" : "Global"}
            pressed={localMode}
            onToggle={() => onLocalModeChange(!localMode)}
          />
        </div>
        {localMode ? (
          <div className="mt-3 space-y-3">
            <p className="truncate rounded-lg border border-border/50 bg-surface px-2 py-1.5 text-[11px] text-foreground">
              <span className="text-muted-foreground">Centre: </span>
              {localFocalLabel ?? "select a node"}
            </p>
            <GraphSlider
              label="Depth"
              value={localDepth}
              min={1}
              max={6}
              step={1}
              format={(value) => `${Math.round(value)} hop${value > 1 ? "s" : ""}`}
              onChange={(depth) => onLocalDepthChange(Math.round(depth))}
            />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Double-click or right-click a node to recentre.
            </p>
          </div>
        ) : null}
      </Section>

      <Section
        title="Filters"
        icon={Search}
        action={
          query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
          ) : null
        }
      >
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="type:person -tag:draft"
          aria-label="Filter nodes"
          className="h-9 text-xs"
        />
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Prefix with <code className="text-accent-ink">type:</code>{" "}
          <code className="text-accent-ink">kind:</code> <code className="text-accent-ink">tag:</code>{" "}
          <code className="text-accent-ink">project:</code>, or <code className="text-accent-ink">-</code>{" "}
          to exclude.
        </p>
        <div className="mt-3 flex flex-wrap gap-1">
          {model.types.entity.slice(0, 10).map((type) => (
            <Chip key={type} token={`type:${type}`} query={query} onQueryChange={onQueryChange} />
          ))}
          {model.tags.slice(0, 8).map((tag) => (
            <Chip key={tag} token={`tag:${tag}`} query={query} onQueryChange={onQueryChange} />
          ))}
        </div>
        {/*
          Hand-hidden nodes have no token in the query box, so without this row they
          would be invisible and unrecoverable — the only way back would be clearing
          localStorage.
        */}
        {hiddenCount > 0 ? (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-surface px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {hiddenCount} node{hiddenCount > 1 ? "s" : ""} hidden
            </span>
            <button
              type="button"
              onClick={onRestoreHidden}
              className="shrink-0 text-[11px] font-medium text-accent-ink transition-colors hover:text-foreground"
            >
              Restore
            </button>
          </div>
        ) : null}
      </Section>

      <Section title="Relationships" icon={Link2}>
        <div className="flex flex-wrap gap-1.5">
          <Toggle
            label={`Links · ${visibleByTier.explicit}`}
            pressed={display.showExplicitEdges}
            onToggle={() => setDisplay({ showExplicitEdges: !display.showExplicitEdges })}
          />
          <Toggle
            label={`Semantic · ${visibleByTier.semantic}`}
            pressed={display.showSemanticEdges}
            onToggle={() => setDisplay({ showSemanticEdges: !display.showSemanticEdges })}
          />
          <Toggle
            label={`Context · ${visibleByTier.context}`}
            pressed={display.showContextEdges}
            onToggle={() => setDisplay({ showContextEdges: !display.showContextEdges })}
          />
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          Links are relationships you stored. Semantic edges come from wording the two notes
          share; context edges from a shared tag, entity or project. Thicker and brighter means
          stronger. Switching a tier off hides its edges only — the notes stay, as orphans.
        </p>
        {/*
          A tier switched off is a deliberate choice, but three of them off means an
          empty canvas, and "0 links" is exactly the symptom this view exists to
          explain. Say so instead of letting it look broken.
        */}
        {allTiersOff ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5 text-[10px] leading-relaxed text-warning-ink">
            <span>Every tier is off, so no edges are drawn.</span>
            <button
              type="button"
              onClick={() =>
                setDisplay({
                  showExplicitEdges: true,
                  showSemanticEdges: true,
                  showContextEdges: true,
                })
              }
              className="shrink-0 font-medium underline decoration-warning/40 underline-offset-2 transition-colors hover:text-foreground"
            >
              Show all
            </button>
          </div>
        ) : null}
      </Section>

      <Section
        title="Groups"
        icon={Palette}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={groups.length >= MAX_GROUPS}
            onClick={() => onGroupsChange([...groups, createGroupRule(groups)])}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add
          </Button>
        }
      >
        {groups.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No groups. Every node uses the neutral colour.
          </p>
        ) : (
          <ul className="space-y-2">
            {groups.map((rule, index) => (
              <li key={rule.id} className="flex items-center gap-2">
                <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border/60">
                  <span className="sr-only">Colour for group {index + 1}</span>
                  <input
                    type="color"
                    value={rule.color}
                    onChange={(event) =>
                      onGroupsChange(
                        groups.map((item) =>
                          item.id === rule.id ? { ...item, color: event.target.value } : item
                        )
                      )
                    }
                    className="absolute -inset-2 h-10 w-10 cursor-pointer border-0 bg-transparent p-0"
                  />
                </label>
                <Input
                  value={rule.query}
                  onChange={(event) =>
                    onGroupsChange(
                      groups.map((item) =>
                        item.id === rule.id ? { ...item, query: event.target.value } : item
                      )
                    )
                  }
                  placeholder="type:person"
                  aria-label={`Query for group ${index + 1}`}
                  className="h-8 flex-1 text-xs"
                />
                <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {resolved.counts[index] ?? 0}
                </span>
                <button
                  type="button"
                  onClick={() => onGroupsChange(groups.filter((item) => item.id !== rule.id))}
                  aria-label={`Remove group ${index + 1}`}
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger-ink"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {groups.length >= MAX_GROUPS ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Maximum of {MAX_GROUPS} groups reached.
          </p>
        ) : null}
      </Section>

      <Section
        title="Forces"
        icon={Sliders}
        action={
          <button
            type="button"
            onClick={() => onForceChange(DEFAULT_FORCE_SETTINGS)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Reset
          </button>
        }
      >
        <div className="space-y-3">
          <GraphSlider
            label="Center force"
            value={force.center}
            min={0}
            max={1}
            step={0.01}
            onChange={(center) => setForce({ center })}
          />
          <GraphSlider
            label="Repel force"
            value={force.repel}
            min={0}
            max={1}
            step={0.01}
            onChange={(repel) => setForce({ repel })}
          />
          <GraphSlider
            label="Link force"
            value={force.link}
            min={0}
            max={1}
            step={0.01}
            onChange={(link) => setForce({ link })}
          />
          <GraphSlider
            label="Link distance"
            value={force.linkDistance}
            min={10}
            max={300}
            step={1}
            format={(value) => `${Math.round(value)} px`}
            onChange={(linkDistance) => setForce({ linkDistance })}
          />
        </div>
      </Section>

      <Section
        title="Display"
        icon={Eye}
        action={
          <button
            type="button"
            onClick={() => onDisplayChange(DEFAULT_DISPLAY_SETTINGS)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Reset
          </button>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          <Toggle
            label="Entities"
            pressed={display.showEntities}
            onToggle={() => setDisplay({ showEntities: !display.showEntities })}
          />
          <Toggle
            label="Memories"
            pressed={display.showMemories}
            onToggle={() => setDisplay({ showMemories: !display.showMemories })}
          />
          <Toggle
            label="Orphans"
            pressed={display.showOrphans}
            onToggle={() => setDisplay({ showOrphans: !display.showOrphans })}
          />
          <Toggle
            label="Labels"
            pressed={display.showLabels}
            onToggle={() => setDisplay({ showLabels: !display.showLabels })}
          />
          <Toggle
            label="Arrows"
            pressed={display.showArrows}
            onToggle={() => setDisplay({ showArrows: !display.showArrows })}
          />
          <Toggle
            label="Animate"
            pressed={display.animate}
            onToggle={() => setDisplay({ animate: !display.animate })}
          />
          {display.animate ? (
            <button
              type="button"
              onClick={onReplayAnimation}
              className="flex items-center gap-1 rounded-lg border border-border/60 bg-surface px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-accent/30 hover:text-foreground"
            >
              <RotateCw className="h-3 w-3" aria-hidden="true" />
              Replay
            </button>
          ) : null}
        </div>
        <div className="mt-3 space-y-3">
          <GraphSlider
            label="Text fade threshold"
            value={display.textFadeThreshold}
            min={0}
            max={1}
            step={0.05}
            format={(value) =>
              value <= 0 ? "always" : `zoom ≥ ${(value * 1.2).toFixed(2)}x`
            }
            onChange={(textFadeThreshold) => setDisplay({ textFadeThreshold })}
          />
          <GraphSlider
            label="Node size"
            value={display.nodeScale}
            min={0.3}
            max={3}
            step={0.05}
            format={(value) => `${value.toFixed(2)}x`}
            onChange={(nodeScale) => setDisplay({ nodeScale })}
          />
          <GraphSlider
            label="Link thickness"
            value={display.linkScale}
            min={0.3}
            max={3}
            step={0.05}
            format={(value) => `${value.toFixed(2)}x`}
            onChange={(linkScale) => setDisplay({ linkScale })}
          />
        </div>
      </Section>

      <div className="mt-auto space-y-1.5 border-t border-border/40 px-4 py-3 text-[11px] text-muted-foreground">
        <Stat
          label="Visible"
          value={`${view.count} nodes · ${view.edgeIndexes.length} links`}
          tone="text-foreground"
        />
        <Stat label="Hidden by filters" value={view.hiddenCount} />
        <Stat label="Loaded" value={`${model.nodes.length} / ${model.edges.length}`} />
        <div className="flex items-center justify-between gap-2">
          <span>Physics</span>
          <span className={workerActive ? "text-success-ink" : "text-warning-ink"}>
            {workerActive ? "worker thread" : "main thread"}
          </span>
        </div>
        {model.truncated.nodes || model.truncated.edges ? (
          <p className="rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5 text-[10px] leading-relaxed text-warning-ink">
            Snapshot truncated at the server limit — narrow the filter or lower the node limit to
            see a complete subgraph.
          </p>
        ) : null}
        {/*
          Development only: where every edge came from, and where every missing edge
          went. Production users get the counts above; whoever is debugging a graph
          that looks wrong gets to see which tier produced what without a rebuild.
        */}
        {process.env.NODE_ENV !== "production" ? (
          <div className="mt-1 space-y-1 rounded-lg border border-border/50 bg-surface px-2 py-1.5 text-[10px]">
            <p className="font-medium text-foreground">Edges by origin · dev</p>
            <Stat label="Explicit (stored)" value={model.edgeStats.explicit} />
            <Stat label="Semantic (wording)" value={model.edgeStats.semantic} />
            <Stat label="Shared tag" value={model.edgeStats.tag} />
            <Stat label="Shared entity" value={model.edgeStats.entity} />
            <Stat label="Shared project" value={model.edgeStats.project} />
            <Stat label="Total" value={model.edges.length} tone="text-foreground" />
            <Stat label="Pairs scored" value={model.edgeStats.candidates} />
            <Stat
              label="Dropped (endpoint truncated)"
              value={model.edgeStats.dropped}
              tone={model.edgeStats.dropped > 0 ? "text-warning-ink" : undefined}
            />
            <Stat
              label="Refused (dangling / self)"
              value={model.invalidEdges}
              tone={model.invalidEdges > 0 ? "text-warning-ink" : undefined}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
