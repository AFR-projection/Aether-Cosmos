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
import { Button } from "@/ui/primitives/button";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@brain/presentation/components/brain-states";
import { MemoryCard } from "@brain/presentation/components/memory-card";
import { useFormat, useT } from "@/shared/lib/i18n";
import { brainOperationLabel } from "@brain/domain/ui-constants";
import {
  useActiveBrain,
  useBrainAudit,
  useBrainOverview,
  useProjects,
} from "@brain/presentation/hooks/use-brain";

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
  const t = useT();
  const { formatDate, formatNumber } = useFormat();

  return (
    <BrainShell
      title={t("brain.overview.title")}
      description={t("brain.overview.description")}
      actions={
        <Button asChild size="sm">
          <Link href="/brain/memories?new=1">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t("brain.overview.newMemory")}
          </Link>
        </Button>
      }
    >
      {brainsLoading && <BrainLoading label={t("brain.overview.loadingBrains")} />}
      {brainsError && <BrainErrorState message={t("brain.overview.brainsFailed")} />}

      {brain && overview.isError && (
        <BrainErrorState
          message={t("brain.overview.brainFailed")}
          onRetry={() => void overview.refetch()}
        />
      )}

      {brain && overview.data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              icon={BrainIcon}
              label={t("brain.overview.memories")}
              value={formatNumber(overview.data.stats.memoryCount)}
              hint={t("brain.overview.memoriesHint")}
            />
            <StatTile
              icon={Archive}
              label={t("brain.overview.archived")}
              value={formatNumber(overview.data.stats.archivedCount)}
              hint={t("brain.overview.archivedHint")}
            />
            <StatTile
              icon={FolderKanban}
              label={t("brain.overview.projects")}
              value={formatNumber(projects.data?.projects.length ?? 0)}
              hint={t("brain.overview.projectsHint")}
            />
            <StatTile
              icon={Boxes}
              label={t("brain.overview.agents")}
              value={formatNumber(overview.data.stats.agentCount)}
              hint={t("brain.overview.agentsHint")}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <BrainPanel
              icon={BrainIcon}
              title={t("brain.overview.recentlyUpdated")}
              action={
                <Link
                  href="/brain/memories"
                  className="text-xs font-medium text-accent-ink hover:underline"
                >
                  {t("brain.overview.viewAll")}
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
                  <p className="brain-empty__title">{t("brain.overview.emptyTitle")}</p>
                  <p className="brain-empty__body">{t("brain.overview.emptyBody")}</p>
                  <Button asChild size="sm" className="mt-1">
                    <Link href="/brain/memories?new=1">{t("brain.overview.writeMemory")}</Link>
                  </Button>
                </div>
              )}
            </BrainPanel>

            <div className="space-y-5">
              <BrainPanel
                icon={Boxes}
                title={t("brain.overview.agentActivity")}
                action={
                  <Link
                    href="/brain/activity"
                    className="text-xs font-medium text-accent-ink hover:underline"
                  >
                    {t("brain.overview.fullLog")}
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
                            {brainOperationLabel(entry.operation, t)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {entry.principalType === "agent"
                              ? t("brain.by.agent")
                              : t("brain.by.you")}{" "}
                            · {formatDate(entry.createdAt, "medium")}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("brain.overview.noActivity")}</p>
                )}
              </BrainPanel>

              <BrainPanel icon={Plug} title={t("brain.overview.connectTitle")}>
                <p className="text-sm text-muted-foreground">{t("brain.overview.connectBody")}</p>
                <Button asChild variant="secondary" size="sm" className="mt-3">
                  <Link href="/brain/agents">{t("brain.overview.manageAgents")}</Link>
                </Button>
              </BrainPanel>
            </div>
          </div>
        </div>
      )}
    </BrainShell>
  );
}
