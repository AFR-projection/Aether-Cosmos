"use client";

import Link from "next/link";
import { Bot, Clock, User } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import type { Memory } from "@/hooks/use-brain";

/**
 * Memory types grouped into four tones. A memory's type is the strongest signal
 * of how to read it, so it gets colour rather than another grey label.
 */
const TYPE_TONE: Record<string, string> = {
  instruction: "bg-accent/10 text-accent-ink",
  preference: "bg-accent/10 text-accent-ink",
  decision: "bg-warning/10 text-warning-ink",
  procedure: "bg-warning/10 text-warning-ink",
  fact: "bg-success/10 text-success-ink",
  knowledge: "bg-success/10 text-success-ink",
  concept: "bg-success/10 text-success-ink",
};

export function MemoryTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        TYPE_TONE[type] ?? "bg-muted/40 text-muted-foreground"
      )}
    >
      {type}
    </span>
  );
}

/** Compact 0–1 bar for importance / confidence. */
export function ScoreMeter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "accent" | "warning";
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="flex items-center gap-1.5" title={`${label}: ${pct}%`}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span
        className="h-1 w-10 overflow-hidden rounded-full bg-muted/50"
        role="img"
        aria-label={`${label} ${pct} percent`}
      >
        <span
          className={cn("block h-full rounded-full", tone === "accent" ? "bg-accent" : "bg-warning")}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

export function MemoryCard({ memory }: { memory: Memory }) {
  const preview = (memory.summary?.trim() || memory.content).replace(/\s+/g, " ").trim();

  return (
    <Link
      href={`/brain/memories/${memory.id}`}
      className="block rounded-2xl border border-border/50 bg-surface p-4 transition-all hover:border-accent/30 hover:shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MemoryTypeBadge type={memory.type} />
        {memory.archivedAt && (
          <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            archived
          </span>
        )}
        {memory.tags?.slice(0, 4).map((tag) => (
          <span
            key={tag}
            className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {tag}
          </span>
        ))}
        {memory.tags && memory.tags.length > 4 && (
          <span className="text-[10px] text-muted-foreground">+{memory.tags.length - 4}</span>
        )}
      </div>

      <h3 className="mt-2 line-clamp-1 text-sm font-semibold text-foreground">{memory.title}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{preview}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <ScoreMeter label="imp" value={memory.importance} tone="accent" />
        <ScoreMeter label="conf" value={memory.confidence} tone="warning" />
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {memory.createdByAgent ? (
            <Bot className="h-3 w-3" aria-hidden="true" />
          ) : (
            <User className="h-3 w-3" aria-hidden="true" />
          )}
          {memory.createdByAgent ? "agent" : "you"}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {formatDate(memory.updatedAt, "short")}
        </span>
        {memory.version > 1 && (
          <span className="text-[11px] text-muted-foreground">v{memory.version}</span>
        )}
      </div>
    </Link>
  );
}
