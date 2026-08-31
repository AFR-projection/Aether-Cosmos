"use client";

import Link from "next/link";
import { useState } from "react";
import { FolderKanban, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@brain/presentation/components/brain-states";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { notify } from "@/shared/lib/system/notify-store";
import { useFormat, useT } from "@/shared/lib/i18n";
import { PROJECT_STATUS_OPTIONS, projectStatusLabel } from "@brain/domain/ui-constants";
import {
  useActiveBrain,
  useCreateProject,
  useDeleteProject,
  useProjects,
  useUpdateProject,
  type BrainProject,
} from "@brain/presentation/hooks/use-brain";

const STATUS_TONE: Record<BrainProject["status"], string> = {
  active: "success",
  paused: "warning",
  done: "accent",
  archived: "muted",
};

export default function BrainProjectsPage() {
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();
  const t = useT();
  const { formatDate } = useFormat();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const projects = useProjects(brain?.id);
  const createProject = useCreateProject(brain?.id);
  const updateProject = useUpdateProject(brain?.id);
  const deleteProject = useDeleteProject(brain?.id);

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    createProject.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      {
        onSuccess: () => {
          notify({ title: t("brain.projects.created"), tone: "success" });
          setName("");
          setDescription("");
          setCreating(false);
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.projects.createFailed"),
            tone: "error",
          }),
      }
    );
  }

  async function handleDelete(project: BrainProject) {
    const confirmed = await askConfirm({
      title: t("brain.projects.deleteTitle", { name: project.name }),
      message: t("brain.projects.deleteBody", { count: project.memoryCount }),
      confirmText: t("brain.projects.deleteConfirm"),
      danger: true,
    });
    if (!confirmed) return;

    deleteProject.mutate(project.id, {
      onSuccess: () => notify({ title: t("brain.projects.deleted"), tone: "success" }),
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : t("brain.projects.deleteFailed"),
          tone: "error",
        }),
    });
  }

  return (
    <BrainShell
      title={t("brain.projects.title")}
      description={t("brain.projects.description")}
      actions={
        <Button size="sm" onClick={() => setCreating((value) => !value)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("brain.projects.newProject")}
        </Button>
      }
    >
      {dialogs}

      <div className="space-y-5">
        {creating && (
          <BrainPanel icon={Plus} title={t("brain.projects.newProject")}>
            <form onSubmit={handleCreate} className="space-y-3">
              <Input
                value={name}
                maxLength={150}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("brain.projects.namePlaceholder")}
                aria-label={t("brain.projects.nameLabel")}
                autoFocus
              />
              <Input
                value={description}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("brain.projects.descriptionPlaceholder")}
                aria-label={t("brain.projects.descriptionLabel")}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" size="sm" disabled={!name.trim() || createProject.isPending}>
                  {createProject.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  {t("brain.projects.create")}
                </Button>
              </div>
            </form>
          </BrainPanel>
        )}

        {projects.isLoading && <BrainLoading label={t("brain.projects.loading")} />}
        {projects.isError && (
          <BrainErrorState
            message={t("brain.projects.loadFailed")}
            onRetry={() => void projects.refetch()}
          />
        )}

        {projects.data &&
          (projects.data.projects.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {projects.data.projects.map((project) => (
                <article key={project.id} className="brain-surface flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 text-sm font-semibold text-foreground">
                      {project.name}
                    </h3>
                    <span
                      className="brain-chip brain-chip--mono shrink-0"
                      data-tone={STATUS_TONE[project.status]}
                    >
                      {projectStatusLabel(project.status, t)}
                    </span>
                  </div>

                  {project.description && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {project.description}
                    </p>
                  )}

                  <p className="mt-auto pt-1 text-xs text-muted-foreground">
                    {t("brain.projects.meta", {
                      memories: t("brain.projects.memoryCount", { count: project.memoryCount }),
                      date: formatDate(project.updatedAt, "medium"),
                    })}
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Button asChild variant="secondary" size="sm">
                      <Link href={`/brain/memories?project=${project.id}`}>
                        {t("brain.projects.openMemories")}
                      </Link>
                    </Button>
                    <select
                      value={project.status}
                      aria-label={t("brain.projects.statusOf", { name: project.name })}
                      onChange={(event) =>
                        updateProject.mutate(
                          {
                            projectId: project.id,
                            status: event.target.value as BrainProject["status"],
                          },
                          {
                            onError: (error) =>
                              notify({
                                title:
                                  error instanceof Error
                                    ? error.message
                                    : t("brain.projects.updateFailed"),
                                tone: "error",
                              }),
                          }
                        )
                      }
                      className="h-8 cursor-pointer rounded-lg border border-border/60 bg-surface px-2 text-xs text-foreground transition-colors hover:border-accent/30 focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
                    >
                      {PROJECT_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("brain.projects.deleteLabel", { name: project.name })}
                      disabled={deleteProject.isPending}
                      onClick={() => void handleDelete(project)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="brain-empty">
              <span className="brain-empty__icon">
                <FolderKanban className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="brain-empty__title">{t("brain.projects.emptyTitle")}</p>
              <p className="brain-empty__body">{t("brain.projects.emptyBody")}</p>
              <Button size="sm" className="mt-1" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("brain.projects.createFirst")}
              </Button>
            </div>
          ))}
      </div>
    </BrainShell>
  );
}
