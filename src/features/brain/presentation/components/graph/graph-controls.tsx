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
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { MAX_GROUPS, createGroupRule, type ResolvedGroups } from "@brain/presentation/canvas/groups";
import {
  DEFAULT_DISPLAY_SETTINGS,
  DEFAULT_FORCE_SETTINGS,
  type DisplaySettings,
  type ForceSettings,
  type GraphModel,
  type GroupRule,
} from "@brain/presentation/canvas/types";
import type { GraphView } from "@brain/presentation/canvas/view";
import { useFormat, useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";
import { GraphSlider } from "./graph-slider";

/**
 * The control panel: filters, groups, forces, display.
 *
 * Every control is a controlled input over state owned by GraphView, so a change
 * flows filter -> view -> simulation in the same commit and the graph updates live
 * without a reload. Nothing here touches the canvas or the physics directly.
 */

/**
 * Query syntax rather than prose: the prefixes are the same words in every
 * language (the parser only knows these), so the two examples stay as typed.
 */
const FILTER_PLACEHOLDER = "type:person -tag:draft";
const GROUP_PLACEHOLDER = "type:person";

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
  const t = useT();
  const { formatNumber } = useFormat();
  /** Two decimals, with the locale's own decimal mark: `0.35` is `0,35` in Indonesian. */
  const decimal = (value: number) =>
    formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      <Section title={t("brain.graph.localGraph")} icon={GitFork}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {localMode ? t("brain.graph.localOn") : t("brain.graph.localOff")}
          </p>
          <Toggle
            label={localMode ? t("brain.graph.local") : t("brain.graph.global")}
            pressed={localMode}
            onToggle={() => onLocalModeChange(!localMode)}
          />
        </div>
        {localMode ? (
          <div className="mt-3 space-y-3">
            <p className="truncate rounded-lg border border-border/50 bg-surface px-2 py-1.5 text-[11px] text-foreground">
              <span className="text-muted-foreground">{t("brain.graph.centreLabel")} </span>
              {localFocalLabel ?? t("brain.graph.selectNode")}
            </p>
            <GraphSlider
              id="graph-local-depth"
              label={t("brain.graph.depth")}
              value={localDepth}
              min={1}
              max={6}
              step={1}
              format={(value) => t("brain.graph.hops", { count: Math.round(value) })}
              onChange={(depth) => onLocalDepthChange(Math.round(depth))}
            />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t("brain.graph.recentreHint")}
            </p>
          </div>
        ) : null}
      </Section>

      <Section
        title={t("brain.graph.filters")}
        icon={Search}
        action={
          query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("brain.graph.clear")}
            </button>
          ) : null
        }
      >
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={FILTER_PLACEHOLDER}
          aria-label={t("brain.graph.filterNodes")}
          className="h-9 text-xs"
        />
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          {t("brain.graph.filterHint")}
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
              {t("brain.graph.nodesHidden", { count: hiddenCount })}
            </span>
            <button
              type="button"
              onClick={onRestoreHidden}
              className="shrink-0 text-[11px] font-medium text-accent-ink transition-colors hover:text-foreground"
            >
              {t("brain.graph.restore")}
            </button>
          </div>
        ) : null}
      </Section>

      <Section title={t("brain.graph.relationships")} icon={Link2}>
        <div className="flex flex-wrap gap-1.5">
          <Toggle
            label={t("brain.graph.tierLinks", { count: formatNumber(visibleByTier.explicit) })}
            pressed={display.showExplicitEdges}
            onToggle={() => setDisplay({ showExplicitEdges: !display.showExplicitEdges })}
          />
          <Toggle
            label={t("brain.graph.tierSemantic", { count: formatNumber(visibleByTier.semantic) })}
            pressed={display.showSemanticEdges}
            onToggle={() => setDisplay({ showSemanticEdges: !display.showSemanticEdges })}
          />
          <Toggle
            label={t("brain.graph.tierContext", { count: formatNumber(visibleByTier.context) })}
            pressed={display.showContextEdges}
            onToggle={() => setDisplay({ showContextEdges: !display.showContextEdges })}
          />
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          {t("brain.graph.tiersBody")}
        </p>
        {/*
          A tier switched off is a deliberate choice, but three of them off means an
          empty canvas, and "0 links" is exactly the symptom this view exists to
          explain. Say so instead of letting it look broken.
        */}
        {allTiersOff ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5 text-[10px] leading-relaxed text-warning-ink">
            <span>{t("brain.graph.allTiersOff")}</span>
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
              {t("brain.graph.showAll")}
            </button>
          </div>
        ) : null}
      </Section>

      <Section
        title={t("brain.graph.groups")}
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
            {t("brain.graph.addGroup")}
          </Button>
        }
      >
        {groups.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t("brain.graph.noGroups")}</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((rule, index) => (
              <li key={rule.id} className="flex items-center gap-2">
                <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border/60">
                  <span className="sr-only">
                    {t("brain.graph.groupColour", { index: index + 1 })}
                  </span>
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
                  placeholder={GROUP_PLACEHOLDER}
                  aria-label={t("brain.graph.groupQuery", { index: index + 1 })}
                  className="h-8 flex-1 text-xs"
                />
                <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {formatNumber(resolved.counts[index] ?? 0)}
                </span>
                <button
                  type="button"
                  onClick={() => onGroupsChange(groups.filter((item) => item.id !== rule.id))}
                  aria-label={t("brain.graph.groupRemove", { index: index + 1 })}
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
            {t("brain.graph.groupsMax", { count: formatNumber(MAX_GROUPS) })}
          </p>
        ) : null}
      </Section>

      <Section
        title={t("brain.graph.forces")}
        icon={Sliders}
        action={
          <button
            type="button"
            onClick={() => onForceChange(DEFAULT_FORCE_SETTINGS)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {t("brain.graph.reset")}
          </button>
        }
      >
        <div className="space-y-3">
          <GraphSlider
            id="graph-force-center"
            label={t("brain.graph.centerForce")}
            value={force.center}
            min={0}
            max={1}
            step={0.01}
            format={decimal}
            onChange={(center) => setForce({ center })}
          />
          <GraphSlider
            id="graph-force-repel"
            label={t("brain.graph.repelForce")}
            value={force.repel}
            min={0}
            max={1}
            step={0.01}
            format={decimal}
            onChange={(repel) => setForce({ repel })}
          />
          <GraphSlider
            id="graph-force-link"
            label={t("brain.graph.linkForce")}
            value={force.link}
            min={0}
            max={1}
            step={0.01}
            format={decimal}
            onChange={(link) => setForce({ link })}
          />
          <GraphSlider
            id="graph-force-link-distance"
            label={t("brain.graph.linkDistance")}
            value={force.linkDistance}
            min={10}
            max={300}
            step={1}
            format={(value) =>
              t("brain.graph.pixels", { value: formatNumber(Math.round(value)) })
            }
            onChange={(linkDistance) => setForce({ linkDistance })}
          />
        </div>
      </Section>

      <Section
        title={t("brain.graph.display")}
        icon={Eye}
        action={
          <button
            type="button"
            onClick={() => onDisplayChange(DEFAULT_DISPLAY_SETTINGS)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            {t("brain.graph.reset")}
          </button>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          <Toggle
            label={t("brain.graph.entities")}
            pressed={display.showEntities}
            onToggle={() => setDisplay({ showEntities: !display.showEntities })}
          />
          <Toggle
            label={t("brain.graph.memories")}
            pressed={display.showMemories}
            onToggle={() => setDisplay({ showMemories: !display.showMemories })}
          />
          <Toggle
            label={t("brain.graph.orphans")}
            pressed={display.showOrphans}
            onToggle={() => setDisplay({ showOrphans: !display.showOrphans })}
          />
          <Toggle
            label={t("brain.graph.labels")}
            pressed={display.showLabels}
            onToggle={() => setDisplay({ showLabels: !display.showLabels })}
          />
          <Toggle
            label={t("brain.graph.arrows")}
            pressed={display.showArrows}
            onToggle={() => setDisplay({ showArrows: !display.showArrows })}
          />
          <Toggle
            label={t("brain.graph.animate")}
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
              {t("brain.graph.replay")}
            </button>
          ) : null}
        </div>
        <div className="mt-3 space-y-3">
          <GraphSlider
            id="graph-text-fade"
            label={t("brain.graph.textFade")}
            value={display.textFadeThreshold}
            min={0}
            max={1}
            step={0.05}
            format={(value) =>
              value <= 0
                ? t("brain.graph.fadeAlways")
                : t("brain.graph.fadeZoom", { value: decimal(value * 1.2) })
            }
            onChange={(textFadeThreshold) => setDisplay({ textFadeThreshold })}
          />
          <GraphSlider
            id="graph-node-size"
            label={t("brain.graph.nodeSize")}
            value={display.nodeScale}
            min={0.3}
            max={3}
            step={0.05}
            format={(value) => t("brain.graph.multiplier", { value: decimal(value) })}
            onChange={(nodeScale) => setDisplay({ nodeScale })}
          />
          <GraphSlider
            id="graph-link-thickness"
            label={t("brain.graph.linkThickness")}
            value={display.linkScale}
            min={0.3}
            max={3}
            step={0.05}
            format={(value) => t("brain.graph.multiplier", { value: decimal(value) })}
            onChange={(linkScale) => setDisplay({ linkScale })}
          />
        </div>
      </Section>

      <div className="mt-auto space-y-1.5 border-t border-border/40 px-4 py-3 text-[11px] text-muted-foreground">
        <Stat
          label={t("brain.graph.visible")}
          value={t("brain.graph.visibleValue", {
            nodes: formatNumber(view.count),
            links: formatNumber(view.edgeIndexes.length),
          })}
          tone="text-foreground"
        />
        <Stat label={t("brain.graph.hiddenByFilters")} value={formatNumber(view.hiddenCount)} />
        <Stat
          label={t("brain.graph.loaded")}
          /* Two counts over a slash, not a sentence: nodes then edges, as loaded. */
          value={`${formatNumber(model.nodes.length)} / ${formatNumber(model.edges.length)}`}
        />
        <div className="flex items-center justify-between gap-2">
          <span>{t("brain.graph.physics")}</span>
          <span className={workerActive ? "text-success-ink" : "text-warning-ink"}>
            {workerActive ? t("brain.graph.workerThread") : t("brain.graph.mainThread")}
          </span>
        </div>
        {model.truncated.nodes || model.truncated.edges ? (
          <p className="rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5 text-[10px] leading-relaxed text-warning-ink">
            {t("brain.graph.truncated")}
          </p>
        ) : null}
        {/*
          Development only: where every edge came from, and where every missing edge
          went. Production users get the counts above; whoever is debugging a graph
          that looks wrong gets to see which tier produced what without a rebuild.

          Untranslated on purpose — it never reaches a user, and English keeps it
          greppable against the code that produces each number.
        */}
        {process.env.NODE_ENV !== "production" ? (
          <div className="mt-1 space-y-1 rounded-lg border border-border/50 bg-surface px-2 py-1.5 text-[10px]">
            <p className="font-medium text-foreground">Edges by origin · dev</p>{/* i18n-exempt */}
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
