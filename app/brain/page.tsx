"use client";

import Link from "next/link";
import { Bot, Brain as BrainIcon, Boxes, Plug, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { MemoryCard } from "@/components/brain/memory-card";
import { formatDate } from "@/lib/utils";
import {
  useActiveBrain,
  useBrainAudit,
  useBrainOverview,
  useProjects,
} from "@/hooks/use-brain";

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/40 bg-background-secondary/40 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Memories"
              value={overview.data.stats.memoryCount.toLocaleString()}
              hint="live, not archived"
            />
            <StatTile
              label="Archived"
              value={overview.data.stats.archivedCount.toLocaleString()}
              hint="kept, out of the way"
            />
            <StatTile
              label="Projects"
              value={(projects.data?.projects.length ?? 0).toLocaleString()}
            />
            <StatTile
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
                  className="text-xs font-medium text-accent hover:underline"
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
                <EmptyState
                  icon={BrainIcon}
                  title="This brain is empty"
                  description="Write your first memory, or connect an agent and let it remember for you."
                  action={
                    <Button asChild size="sm">
                      <Link href="/brain/memories?new=1">Write a memory</Link>
                    </Button>
                  }
                />
              )}
            </BrainPanel>

            <div className="space-y-5">
              <BrainPanel
                icon={Boxes}
                title="Agent activity"
                action={
                  <Link
                    href="/brain/activity"
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Full log
                  </Link>
                }
              >
                {audit.data?.entries.length ? (
                  <ol className="space-y-2.5">
                    {audit.data.entries.map((entry) => (
                      <li key={entry.id} className="flex items-start gap-2.5">
                        <span className="mt-0.5 rounded-lg bg-accent/10 p-1.5" aria-hidden="true">
                          <Bot className="h-3 w-3 text-accent" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {entry.operation}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {entry.principalType} · {formatDate(entry.createdAt, "short")}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nothing yet. Every write and every agent read shows up here.
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
