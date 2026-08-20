"use client";

import { Bot, ScrollText, User } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading } from "@/components/brain/brain-states";
import { cn, formatDate } from "@/lib/utils";
import { useActiveBrain, useBrainAudit } from "@/hooks/use-brain";

/**
 * Agent activity timeline (§33) read straight from brain_audit_logs, so it shows
 * what actually happened rather than what the UI thinks happened.
 */

const OPERATION_COPY: Record<string, string> = {
  "memory.create": "Created a memory",
  "memory.update": "Updated a memory",
  "memory.delete": "Deleted a memory",
  "memory.restore": "Restored a memory version",
  "memory.search": "Searched the brain",
  "memory.recall": "Recalled context",
  "entity.upsert": "Recorded an entity",
  "entity.update": "Updated an entity",
  "entity.delete": "Deleted an entity",
  "relationship.upsert": "Linked two entities",
  "relationship.delete": "Removed a link",
  "project.create": "Created a project",
  "project.update": "Updated a project",
  "project.delete": "Deleted a project",
  "brain.update": "Changed brain settings",
  "brain.export": "Exported the brain",
  "agent.create": "Connected an agent",
  "agent.revoke": "Revoked an agent",
  "agent.scopes": "Changed agent permissions",
  "agent.access_revoke": "Removed an agent from this brain",
};

/** Pull the few metadata fields worth showing without dumping memory content. */
function detailLine(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const parts: string[] = [];
  const title = metadata.title;
  if (typeof title === "string") parts.push(title);
  const query = metadata.query;
  if (typeof query === "string") parts.push(`"${query}"`);
  const task = metadata.task;
  if (typeof task === "string") parts.push(`"${task}"`);
  const relationshipType = metadata.relationshipType;
  if (typeof relationshipType === "string" && typeof metadata.source === "string") {
    parts.push(`${metadata.source} --${relationshipType}--> ${String(metadata.target ?? "?")}`);
  }
  const name = metadata.name;
  if (typeof name === "string" && parts.length === 0) parts.push(name);
  const fields = metadata.fields;
  if (Array.isArray(fields) && fields.length > 0) parts.push(fields.join(", "));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default function BrainActivityPage() {
  const { brain } = useActiveBrain();
  const audit = useBrainAudit(brain?.id, 100);

  return (
    <BrainShell
      title="Activity"
      description="Every write, and every agent read, against this brain. Append-only."
    >
      {audit.isLoading && <BrainLoading label="Loading activity" rows={5} />}
      {audit.isError && (
        <BrainErrorState
          message="Could not load the activity log."
          onRetry={() => void audit.refetch()}
        />
      )}

      {audit.data &&
        (audit.data.entries.length > 0 ? (
          <ol className="space-y-2">
            {audit.data.entries.map((entry) => {
              const detail = detailLine(entry.metadata);
              const viaMcp =
                !!entry.metadata && (entry.metadata as { transport?: string }).transport === "mcp";
              const agentName =
                (entry.metadata as { agent?: string } | null)?.agent ?? null;

              return (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 rounded-2xl border border-border/50 bg-surface p-3.5"
                >
                  <span
                    className={cn(
                      "mt-0.5 rounded-lg p-2",
                      entry.principalType === "agent" ? "bg-accent/10" : "bg-muted/40"
                    )}
                    aria-hidden="true"
                  >
                    {entry.principalType === "agent" ? (
                      <Bot className="h-3.5 w-3.5 text-accent" />
                    ) : (
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {OPERATION_COPY[entry.operation] ?? entry.operation}
                      </span>
                      {agentName && (
                        <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                          {agentName}
                        </span>
                      )}
                      {viaMcp && (
                        <span className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          mcp
                        </span>
                      )}
                    </span>
                    {detail && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {detail}
                      </span>
                    )}
                  </span>

                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 text-[11px] text-muted-foreground"
                  >
                    {formatDate(entry.createdAt, "short")}
                  </time>
                </li>
              );
            })}
          </ol>
        ) : (
          <EmptyState
            icon={ScrollText}
            title="Nothing recorded yet"
            description="Once you or an agent writes to this brain, it shows up here."
          />
        ))}
    </BrainShell>
  );
}
