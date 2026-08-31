"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  History,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@brain/presentation/components/brain-states";
import { MemoryForm } from "@brain/presentation/components/memory-form";
import { MemoryTypeBadge, ScoreMeter } from "@brain/presentation/components/memory-card";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { notify } from "@/shared/lib/system/notify-store";
import { useFormat, useT } from "@/shared/lib/i18n";
import {
  useActiveBrain,
  useDeleteMemory,
  useMemory,
  useMemoryVersions,
  useProjects,
  useRestoreVersion,
  useUpdateMemory,
} from "@brain/presentation/hooks/use-brain";

export default function MemoryDetailPage() {
  const params = useParams<{ memoryId: string }>();
  const memoryId = params.memoryId;
  const router = useRouter();
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();
  const t = useT();
  const { formatDate } = useFormat();

  const [editing, setEditing] = useState(false);

  const memoryQuery = useMemory(brain?.id, memoryId);
  const versions = useMemoryVersions(brain?.id, memoryId);
  const projects = useProjects(brain?.id);
  const updateMemory = useUpdateMemory(brain?.id, memoryId);
  const deleteMemory = useDeleteMemory(brain?.id);
  const restoreVersion = useRestoreVersion(brain?.id, memoryId);

  const memory = memoryQuery.data?.memory;
  const project = projects.data?.projects.find((item) => item.id === memory?.projectId);

  async function handleArchiveToggle() {
    if (!memory) return;
    const archiving = !memory.archivedAt;
    updateMemory.mutate(
      { archived: archiving },
      {
        onSuccess: () =>
          notify({
            title: archiving ? t("brain.memory.archived") : t("brain.memory.unarchived"),
            tone: "success",
          }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.memory.updateFailed"),
            tone: "error",
          }),
      }
    );
  }

  async function handleDelete() {
    if (!memory) return;
    const confirmed = await askConfirm({
      title: t("brain.memory.deleteTitle"),
      message: t("brain.memory.deleteBody"),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;

    deleteMemory.mutate(memory.id, {
      onSuccess: () => {
        notify({ title: t("brain.memory.deleted"), tone: "success" });
        router.push("/brain/memories");
      },
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : t("brain.memory.deleteFailed"),
          tone: "error",
        }),
    });
  }

  async function handleRestore(versionId: string, versionNumber: number) {
    const confirmed = await askConfirm({
      title: t("brain.memory.restoreTitle", { version: versionNumber }),
      message: t("brain.memory.restoreBody"),
      confirmText: t("brain.memory.restore"),
    });
    if (!confirmed) return;

    restoreVersion.mutate(versionId, {
      onSuccess: () =>
        notify({
          title: t("brain.memory.restored", { version: versionNumber }),
          tone: "success",
        }),
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : t("brain.memory.restoreFailed"),
          tone: "error",
        }),
    });
  }

  return (
    <BrainShell
      title={memory?.title ?? t("brain.memory.fallbackTitle")}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/brain/memories">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("common.back")}
          </Link>
        </Button>
      }
    >
      {dialogs}

      {memoryQuery.isLoading && (
        <BrainLoading label={t("brain.memory.loading")} rows={2} />
      )}
      {memoryQuery.isError && (
        <BrainErrorState
          message={t("brain.memory.loadFailed")}
          onRetry={() => void memoryQuery.refetch()}
        />
      )}

      {memory && (
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-5">
            {editing ? (
              <BrainPanel icon={Pencil} title={t("brain.memory.editTitle")}>
                <MemoryForm
                  initial={{
                    title: memory.title,
                    content: memory.content,
                    type: memory.type,
                    summary: memory.summary ?? "",
                    importance: memory.importance,
                    confidence: memory.confidence,
                    projectId: memory.projectId,
                    tags: memory.tags,
                  }}
                  projects={projects.data?.projects ?? []}
                  submitLabel={t("brain.memory.saveChanges")}
                  showChangeReason
                  pending={updateMemory.isPending}
                  error={updateMemory.error instanceof Error ? updateMemory.error.message : null}
                  onCancel={() => setEditing(false)}
                  onSubmit={(values) =>
                    updateMemory.mutate(values, {
                      onSuccess: () => {
                        notify({ title: t("brain.memory.updated"), tone: "success" });
                        setEditing(false);
                      },
                      onError: (error) =>
                        notify({
                          title:
                            error instanceof Error
                              ? error.message
                              : t("brain.memory.updateFailed"),
                          tone: "error",
                        }),
                    })
                  }
                />
              </BrainPanel>
            ) : (
              <BrainPanel
                icon={Pencil}
                title={t("brain.memory.content")}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    {t("brain.memory.edit")}
                  </Button>
                }
              >
                {memory.summary && (
                  <p className="mb-3 rounded-xl border border-border/40 bg-background-secondary/40 p-3 text-sm text-muted-foreground">
                    {memory.summary}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {memory.content}
                </p>
              </BrainPanel>
            )}

            <BrainPanel icon={History} title={t("brain.memory.versionHistory")}>
              {versions.data?.versions.length ? (
                <ol className="space-y-2">
                  {versions.data.versions.map((version) => (
                    <li
                      key={version.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/40 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">
                          v{version.versionNumber} · {version.title}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {version.changeReason ?? t("brain.memory.noReason")} ·{" "}
                          {formatDate(version.createdAt, "short")} ·{" "}
                          {version.changedByAgent ? t("brain.by.agent") : t("brain.by.you")}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={restoreVersion.isPending}
                        onClick={() => void handleRestore(version.id, version.versionNumber)}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        {t("brain.memory.restore")}
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">{t("brain.memory.noVersions")}</p>
              )}
            </BrainPanel>
          </div>

          <div className="space-y-5">
            <BrainPanel icon={Archive} title={t("brain.memory.details")}>
              <dl className="space-y-3 text-sm">
                <Detail label={t("brain.memory.detailType")}>
                  <MemoryTypeBadge type={memory.type} />
                </Detail>
                <Detail label={t("brain.memory.detailScores")}>
                  <span className="flex flex-wrap items-center gap-3">
                    <ScoreMeter
                      label={t("brain.card.importanceShort")}
                      value={memory.importance}
                      tone="accent"
                    />
                    <ScoreMeter
                      label={t("brain.card.confidenceShort")}
                      value={memory.confidence}
                      tone="warning"
                    />
                  </span>
                </Detail>
                <Detail label={t("brain.memory.detailProject")}>
                  {project ? (
                    <Link href="/brain/projects" className="text-accent-ink hover:underline">
                      {project.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{t("brain.none")}</span>
                  )}
                </Detail>
                <Detail label={t("brain.memory.detailTags")}>
                  {memory.tags.length ? (
                    <span className="flex flex-wrap gap-1">
                      {memory.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md border border-border/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("brain.none")}</span>
                  )}
                </Detail>
                <Detail label={t("brain.memory.detailSource")}>
                  {/* `sourceType` is a wire value, shown as the server sends it. */}
                  <span className="text-muted-foreground">
                    {memory.sourceType}
                    {memory.createdByAgent ? ` ${t("brain.by.agentSuffix")}` : ""}
                  </span>
                </Detail>
                <Detail label={t("brain.memory.detailVersion")}>
                  <span className="text-muted-foreground">v{memory.version}</span>
                </Detail>
                <Detail label={t("brain.memory.detailCreated")}>
                  <span className="text-muted-foreground">
                    {formatDate(memory.createdAt, "medium")}
                  </span>
                </Detail>
                <Detail label={t("brain.memory.detailUpdated")}>
                  <span className="text-muted-foreground">
                    {formatDate(memory.updatedAt, "medium")}
                  </span>
                </Detail>
              </dl>
            </BrainPanel>

            <BrainPanel icon={Trash2} title={t("brain.memory.lifecycle")}>
              <p className="text-sm text-muted-foreground">{t("brain.memory.lifecycleBody")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={updateMemory.isPending}
                  onClick={() => void handleArchiveToggle()}
                >
                  {memory.archivedAt ? (
                    <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Archive className="h-4 w-4" aria-hidden="true" />
                  )}
                  {memory.archivedAt ? t("brain.memory.unarchive") : t("brain.memory.archive")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleteMemory.isPending}
                  onClick={() => void handleDelete()}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t("common.delete")}
                </Button>
              </div>
            </BrainPanel>
          </div>
        </div>
      )}
    </BrainShell>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}
