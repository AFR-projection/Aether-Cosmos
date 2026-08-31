"use client";

import { Bot, ScrollText, User } from "lucide-react";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainErrorState, BrainLoading } from "@brain/presentation/components/brain-states";
import { cn } from "@/shared/lib/utils";
import { useFormat, useT } from "@/shared/lib/i18n";
import { brainOperationLabel } from "@brain/domain/ui-constants";
import { useActiveBrain, useBrainAudit, type BrainAuditEntry } from "@brain/presentation/hooks/use-brain";

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
 * order are exactly what the endpoint returned. The group key is a locale-free
 * `toDateString()` so the grouping never changes with the language; the heading
 * is formatted from `iso` at render time.
 */
function groupByDay(entries: BrainAuditEntry[]) {
  const groups: { key: string; iso: string; entries: BrainAuditEntry[] }[] = [];
  for (const entry of entries) {
    const parsed = new Date(entry.createdAt);
    const key = Number.isNaN(parsed.getTime()) ? entry.createdAt : parsed.toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, iso: entry.createdAt, entries: [entry] });
  }
  return groups;
}

export default function BrainActivityPage() {
  const { brain } = useActiveBrain();
  const audit = useBrainAudit(brain?.id, 100);
  const t = useT();
  const { formatMonthDay, formatTime } = useFormat();

  return (
    <BrainShell
      title={t("brain.activity.title")}
      description={t("brain.activity.description")}
    >
      {audit.isLoading && <BrainLoading label={t("brain.activity.loading")} rows={5} />}
      {audit.isError && (
        <BrainErrorState
          message={t("brain.activity.loadFailed")}
          onRetry={() => void audit.refetch()}
        />
      )}

      {audit.data &&
        (audit.data.entries.length > 0 ? (
          <div className="space-y-1">
            {groupByDay(audit.data.entries).map((group) => (
              <section key={group.key}>
                <h2 className="brain-timeline__day">{formatMonthDay(group.iso)}</h2>
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
                                ? "bg-accent/10 text-accent-ink"
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
                                {brainOperationLabel(entry.operation, t)}
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
            <p className="brain-empty__title">{t("brain.activity.emptyTitle")}</p>
            <p className="brain-empty__body">{t("brain.activity.emptyBody")}</p>
          </div>
        ))}
    </BrainShell>
  );
}
