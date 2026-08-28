"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  Link2,
  Link2Off,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { notify } from "@/lib/system/notify-store";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";
import {
  useEntities,
  useLinkMemory,
  useMemories,
  useMemoryLinks,
  useUnlinkMemory,
  type MemoryLinkNode,
} from "@/hooks/use-brain";
import { BrainPanel } from "./brain-states";
import { MemoryTypeBadge } from "./memory-card";

/**
 * "Related to" / "Referenced by" for one memory (§41).
 *
 * The two lists are deliberately not merged. An outgoing link is an editorial
 * choice made on this memory and can be removed here; an incoming link belongs to
 * the other memory and is read-only from this side — removing it there is that
 * memory's decision, not this one's.
 */

/** Verbs offered by default. Free text is still allowed behind "Custom". */
const LINK_TYPE_SUGGESTIONS = [
  "relates_to",
  "supersedes",
  "supported_by",
  "contradicts",
  "depends_on",
  "mentions",
] as const;

const CUSTOM = "__custom__";

/** Same rule the server enforces, so an invalid verb never costs a round trip. */
const LINK_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeLinkType(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

/** `supported_by` reads badly in a sentence; `supported by` reads fine. */
function linkTypeLabel(linkType: string): string {
  return linkType.replace(/[_-]+/g, " ");
}

/** One edge. Memory targets navigate; entity targets have no detail page yet. */
function LinkRow({
  link,
  onRemove,
  removing,
}: {
  link: MemoryLinkNode;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const Icon = link.direction === "outgoing" ? ArrowUpRight : ArrowDownLeft;

  return (
    <li className="flex items-center gap-2 rounded-xl border border-border/40 px-3 py-2 transition-colors hover:border-accent/30">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />

      <span className="min-w-0 flex-1">
        {link.targetType === "memory" ? (
          <Link
            href={`/brain/memories/${link.nodeId}`}
            className="block truncate text-xs font-medium text-foreground hover:text-accent-ink hover:underline"
          >
            {link.label}
          </Link>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <Boxes className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-xs font-medium text-foreground">{link.label}</span>
          </span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{linkTypeLabel(link.linkType)}</span>
          {link.nodeType &&
            (link.targetType === "memory" ? (
              <MemoryTypeBadge type={link.nodeType} />
            ) : (
              <span className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {link.nodeType}
              </span>
            ))}
        </span>
      </span>

      {onRemove && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={removing}
          aria-label={`Remove ${linkTypeLabel(link.linkType)} link to ${link.label}`}
          onClick={onRemove}
        >
          {removing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      )}
    </li>
  );
}

export function MemoryLinksPanel({
  brainId,
  memoryId,
}: {
  brainId: string | undefined;
  memoryId: string;
}) {
  const links = useMemoryLinks(brainId, memoryId);
  const unlink = useUnlinkMemory(brainId, memoryId);
  const { dialogs, askConfirm } = useDialogs();

  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const relatedTo = links.data?.relatedTo ?? [];
  const referencedBy = links.data?.referencedBy ?? [];

  async function handleRemove(link: MemoryLinkNode) {
    const confirmed = await askConfirm({
      title: `Remove the "${linkTypeLabel(link.linkType)}" link?`,
      message:
        "Only the connection goes away — both memories stay exactly as they are, and you can link them again at any time.",
      confirmText: "Remove link",
    });
    if (!confirmed) return;

    setRemovingId(link.id);
    unlink.mutate(link.id, {
      onSuccess: () => notify({ title: "Link removed", tone: "success" }),
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : "Could not remove the link",
          tone: "error",
        }),
      onSettled: () => setRemovingId(null),
    });
  }

  return (
    <BrainPanel
      icon={Link2}
      title="Links"
      action={
        <Button
          variant={adding ? "ghost" : "secondary"}
          size="sm"
          onClick={() => setAdding((open) => !open)}
        >
          {adding ? (
            <X className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Plus className="h-4 w-4" aria-hidden="true" />
          )}
          {adding ? "Cancel" : "Add link"}
        </Button>
      }
    >
      {dialogs}

      {adding && brainId && (
        <AddLinkForm
          brainId={brainId}
          memoryId={memoryId}
          excludeMemoryIds={[memoryId, ...relatedTo.map((link) => link.nodeId)]}
          onDone={() => setAdding(false)}
        />
      )}

      {links.isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading links">
          {[0, 1].map((row) => (
            <div key={row} className="h-12 animate-pulse rounded-xl border border-border/40" />
          ))}
        </div>
      )}

      {links.isError && (
        <p role="alert" className="text-sm text-muted-foreground">
          Links could not be loaded.{" "}
          <button
            type="button"
            className="text-accent-ink hover:underline"
            onClick={() => void links.refetch()}
          >
            Try again
          </button>
        </p>
      )}

      {links.data && (
        <div className="space-y-4">
          <LinkGroup
            heading="Related to"
            hint="Connections this memory declares."
            empty="Nothing linked yet. Use Add link to connect a related memory or an entity from the graph."
            links={relatedTo}
            onRemove={handleRemove}
            removingId={removingId}
          />
          <LinkGroup
            heading="Referenced by"
            hint="Memories that point at this one."
            empty="No other memory references this yet."
            links={referencedBy}
          />
        </div>
      )}
    </BrainPanel>
  );
}

function LinkGroup({
  heading,
  hint,
  empty,
  links,
  onRemove,
  removingId,
}: {
  heading: string;
  hint: string;
  empty: string;
  links: MemoryLinkNode[];
  onRemove?: (link: MemoryLinkNode) => void;
  removingId?: string | null;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {heading}
          <span className="ml-1.5 font-normal tabular-nums">{links.length}</span>
        </h3>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      {links.length ? (
        <ul className="space-y-1.5">
          {links.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              removing={removingId === link.id}
              onRemove={onRemove ? () => onRemove(link) : undefined}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border/50 px-3 py-2.5 text-xs text-muted-foreground">
          {empty}
        </p>
      )}
    </div>
  );
}

type TargetOption = { id: string; label: string; sublabel: string | null };

/**
 * Two-step picker: choose what to link to, then say how. The verb defaults to
 * `relates_to` so the common case is one click plus one search.
 */
function AddLinkForm({
  brainId,
  memoryId,
  excludeMemoryIds,
  onDone,
}: {
  brainId: string;
  memoryId: string;
  excludeMemoryIds: string[];
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"memory" | "entity">("memory");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<TargetOption | null>(null);
  const [linkType, setLinkType] = useState<string>(LINK_TYPE_SUGGESTIONS[0]);
  const [customType, setCustomType] = useState("");

  const debounced = useDebouncedValue(search, 300);
  const link = useLinkMemory(brainId, memoryId);

  const memoryResults = useMemories(mode === "memory" ? brainId : undefined, {
    q: debounced,
    limit: 8,
  });
  const entityResults = useEntities(mode === "entity" ? brainId : undefined, debounced);

  const excluded = new Set(excludeMemoryIds);
  const options: TargetOption[] =
    mode === "memory"
      ? (memoryResults.data?.memories ?? [])
          .filter((memory) => !excluded.has(memory.id))
          .map((memory) => ({ id: memory.id, label: memory.title, sublabel: memory.type }))
      : (entityResults.data?.entities ?? [])
          .slice(0, 8)
          .map((entity) => ({ id: entity.id, label: entity.name, sublabel: entity.type }));

  const searching = mode === "memory" ? memoryResults.isLoading : entityResults.isLoading;
  const resolvedType = linkType === CUSTOM ? normalizeLinkType(customType) : linkType;
  const typeError =
    linkType === CUSTOM && customType.trim() && !LINK_TYPE_RE.test(resolvedType)
      ? "Use lowercase letters, digits, _ or - (max 64)."
      : null;
  const canSubmit = Boolean(selected) && Boolean(resolvedType) && !typeError && !link.isPending;

  function switchMode(next: "memory" | "entity") {
    setMode(next);
    setSelected(null);
    setSearch("");
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !canSubmit) return;

    link.mutate(
      {
        ...(mode === "memory"
          ? { targetMemoryId: selected.id }
          : { targetEntityId: selected.id }),
        linkType: resolvedType,
      },
      {
        onSuccess: () => {
          notify({ title: `Linked to "${selected.label}"`, tone: "success" });
          onDone();
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not create the link",
            tone: "error",
          }),
      }
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 space-y-3 rounded-xl border border-accent/20 bg-background-secondary/40 p-3"
    >
      <div className="flex items-center gap-1" role="group" aria-label="What to link to">
        {(["memory", "entity"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            onClick={() => switchMode(option)}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
              mode === option
                ? "bg-accent/10 text-accent-ink"
                : "text-muted-foreground hover:bg-accent/5 hover:text-foreground"
            )}
          >
            {option === "memory" ? "Another memory" : "An entity"}
          </button>
        ))}
      </div>

      <div>
        <label htmlFor="link-search" className="mb-1.5 block text-xs font-medium text-foreground">
          {mode === "memory" ? "Find a memory" : "Find an entity"}
        </label>
        <Input
          id="link-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={mode === "memory" ? "Search titles and content" : "Search names"}
          autoComplete="off"
        />
      </div>

      {selected ? (
        <p className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {selected.label}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selection"
            onClick={() => setSelected(null)}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </p>
      ) : searching ? (
        <p className="px-1 text-xs text-muted-foreground">Searching…</p>
      ) : options.length ? (
        <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => setSelected(option)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent/5"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {option.label}
                </span>
                {option.sublabel && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {option.sublabel}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          {mode === "memory"
            ? "No other memory matches. Everything found is already linked, or try different words."
            : "No entity matches. Entities come from the knowledge graph."}
        </p>
      )}

      <div>
        <label htmlFor="link-type" className="mb-1.5 block text-xs font-medium text-foreground">
          Link type
        </label>
        <select
          id="link-type"
          value={linkType}
          onChange={(event) => setLinkType(event.target.value)}
          className="w-full rounded-lg border border-accent/20 bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-accent/40 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        >
          {LINK_TYPE_SUGGESTIONS.map((type) => (
            <option key={type} value={type}>
              {linkTypeLabel(type)}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </div>

      {linkType === CUSTOM && (
        <div>
          <label htmlFor="custom-type" className="mb-1.5 block text-xs font-medium text-foreground">
            Custom link type
          </label>
          <Input
            id="custom-type"
            value={customType}
            onChange={(event) => setCustomType(event.target.value)}
            placeholder="e.g., supersedes, mentions, implements"
            className={cn(typeError && "border-danger")}
          />
          {typeError && <p className="mt-1 text-xs text-danger-ink">{typeError}</p>}
        </div>
      )}

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {link.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Linking…
          </>
        ) : (
          <>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Link to {selected ? `"${selected.label}"` : "selected item"}
          </>
        )}
      </Button>
    </form>
  );
}
