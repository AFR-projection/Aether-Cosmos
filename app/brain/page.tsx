"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Bot,
  Boxes,
  Brain as BrainIcon,
  FolderKanban,
  Plug,
  Sparkles,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { MemoryCard } from "@/components/brain/memory-card";
import { formatDate } from "@/lib/utils";
import { BRAIN_OPERATION_COPY } from "@/lib/brain/ui-constants";
import {
  useActiveBrain,
  useBrainAudit,
  useBrainOverview,
  useProjects,
} from "@/hooks/use-brain";

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="brain-metric">
      <span>
        <Icon aria-hidden="true" />
        {label}
      </span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function BrainOverviewPage() {
  const { brain, isLoading: brainsLoading, isError: brainsError } = useActiveBrain();
  const overview = useBrainOverview(brain?.id);
  const projects = useProjects(brain?.id);
  const audit = useBrainAudit(brain?.id, 8);

  return (
    <BrainShell
      title="Overview"
      description="Your permanent memory. Agents come and go; what is stored here stays yours."
      actions={
        <Button asChild size="sm">
          <Link href="/brain/memories?new=1">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            New memory
          </Link>
        </Button>
      }
    >
      {brainsLoading && <BrainLoading label="Loading brains" />}
      {brainsError && <BrainErrorState message="Could not load your brains." />}

      {brain && overview.isError && (
        <BrainErrorState
          message="Could not load this brain."
          onRetry={() => void overview.refetch()}
        />
      )}

      {brain && overview.data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              icon={BrainIcon}
              label="Memories"
              value={overview.data.stats.memoryCount.toLocaleString()}
              hint="live, not archived"
            />
            <StatTile
              icon={Archive}
              label="Archived"
              value={overview.data.stats.archivedCount.toLocaleString()}
              hint="kept, out of the way"
            />
            <StatTile
              icon={FolderKanban}
              label="Projects"
              value={(projects.data?.projects.length ?? 0).toLocaleString()}
              hint="threads of work"
            />
            <StatTile
              icon={Boxes}
              label="Agents"
              value={overview.data.stats.agentCount.toLocaleString()}
              hint="with access to this brain"
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <BrainPanel
              icon={BrainIcon}
              title="Recently updated"
              action={
                <Link
                  href="/brain/memories"
                  className="text-xs font-medium text-accent-ink hover:underline"
                >
                  View all
                </Link>
              }
            >
              {overview.data.stats.recentMemories.length > 0 ? (
                <div className="space-y-3">
                  {overview.data.stats.recentMemories.map((memory) => (
                    <MemoryCard key={memory.id} memory={memory} />
                  ))}
                </div>
              ) : (
                <div className="brain-empty">
                  <span className="brain-empty__icon">
                    <BrainIcon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <p className="brain-empty__title">This brain is empty</p>
                  <p className="brain-empty__body">
                    Write your first memory, or connect an agent and let it remember for you.
                  </p>
                  <Button asChild size="sm" className="mt-1">
                    <Link href="/brain/memories?new=1">Write a memory</Link>
                  </Button>
                </div>
              )}
            </BrainPanel>

            <div className="space-y-5">
              <BrainPanel
                icon={Boxes}
                title="Agent activity"
                action={
                  <Link
                    href="/brain/activity"
                    className="text-xs font-medium text-accent-ink hover:underline"
                  >
                    Full log
                  </Link>
                }
              >
                {audit.data?.entries.length ? (
                  <ol className="space-y-2.5">
                    {audit.data.entries.map((entry) => (
                      <li key={entry.id} className="flex items-start gap-2.5">
                        <span
                          className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg ${
                            entry.principalType === "agent"
                              ? "bg-accent/10 text-accent-ink"
                              : "bg-muted/40 text-muted-foreground"
                          }`}
                          aria-hidden="true"
                        >
                          {entry.principalType === "agent" ? (
                            <Bot className="h-3 w-3" />
                          ) : (
                            <User className="h-3 w-3" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {BRAIN_OPERATION_COPY[entry.operation] ?? entry.operation}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {entry.principalType === "agent" ? "agent" : "you"} ·{" "}
                            {formatDate(entry.createdAt, "medium")}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No activity. Writes and agent reads appear here.
                  </p>
                )}
              </BrainPanel>

              <BrainPanel icon={Plug} title="Connect an agent">
                <p className="text-sm text-muted-foreground">
                  Give OpenClaw, Hermes, or any MCP client scoped access to this brain. Keys are
                  shown once and can be revoked at any time.
                </p>
                <Button asChild variant="secondary" size="sm" className="mt-3">
                  <Link href="/brain/agents">Manage agents</Link>
                </Button>
              </BrainPanel>
            </div>
          </div>
        </div>
      )}
    </BrainShell>
  );
}
