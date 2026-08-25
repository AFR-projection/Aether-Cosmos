"use client";

import { Bot, ScrollText, User } from "lucide-react";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading } from "@/components/brain/brain-states";
import { cn, formatDate, formatTime } from "@/lib/utils";
import { BRAIN_OPERATION_COPY } from "@/lib/brain/ui-constants";
import { useActiveBrain, useBrainAudit, type BrainAuditEntry } from "@/hooks/use-brain";

/**
 * Agent activity timeline (§33) read straight from brain_audit_logs, so it shows
 * what actually happened rather than what the UI thinks happened.
 */

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

/**
 * Groups the feed by calendar day. Purely presentational — the entries and their
 * order are exactly what the endpoint returned.
 */
function groupByDay(entries: BrainAuditEntry[]) {
  const groups: { day: string; entries: BrainAuditEntry[] }[] = [];
  for (const entry of entries) {
    const day = formatDate(entry.createdAt, "medium").split(",")[0] ?? entry.createdAt;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
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
          <div className="space-y-1">
            {groupByDay(audit.data.entries).map((group) => (
              <section key={group.day}>
                <h2 className="brain-timeline__day">{group.day}</h2>
                <ol className="brain-timeline">
                  {group.entries.map((entry) => {
                    const detail = detailLine(entry.metadata);
                    const meta = entry.metadata as
                      | { transport?: string; agent?: string }
                      | null;
                    const viaMcp = meta?.transport === "mcp";
                    const agentName = meta?.agent ?? null;

                    return (
                      <li
                        key={entry.id}
                        className="brain-timeline__item"
                        data-actor={entry.principalType}
                      >
                        <div className="brain-surface--flush flex items-start gap-3 p-3">
                          <span
                            className={cn(
                              "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
                              entry.principalType === "agent"
                                ? "bg-accent/10 text-accent"
                                : "bg-muted/40 text-muted-foreground"
                            )}
                            aria-hidden="true"
                          >
                            {entry.principalType === "agent" ? (
                              <Bot className="h-3.5 w-3.5" />
                            ) : (
                              <User className="h-3.5 w-3.5" />
                            )}
                          </span>

                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {BRAIN_OPERATION_COPY[entry.operation] ?? entry.operation}
                              </span>
                              {agentName && (
                                <span className="brain-chip brain-chip--on">{agentName}</span>
                              )}
                              {viaMcp && (
                                <span className="brain-chip brain-chip--mono">mcp</span>
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
                            className="shrink-0 font-mono text-[11px] text-muted-foreground"
                          >
                            {formatTime(entry.createdAt)}
                          </time>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        ) : (
          <div className="brain-empty">
            <span className="brain-empty__icon">
              <ScrollText className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="brain-empty__title">Nothing recorded yet</p>
            <p className="brain-empty__body">
              Once you or an agent writes to this brain, it shows up here — append-only, newest
              first.
            </p>
          </div>
        ))}
    </BrainShell>
  );
}
