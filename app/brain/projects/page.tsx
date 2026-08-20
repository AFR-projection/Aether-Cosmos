"use client";

import Link from "next/link";
import { useState } from "react";
import { FolderKanban, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { notify } from "@/lib/system/notify-store";
import { cn, formatDate } from "@/lib/utils";
import { PROJECT_STATUS_OPTIONS } from "@/lib/brain/ui-constants";
import {
  useActiveBrain,
  useCreateProject,
  useDeleteProject,
  useProjects,
  useUpdateProject,
  type BrainProject,
} from "@/hooks/use-brain";

const STATUS_TONE: Record<BrainProject["status"], string> = {
  active: "bg-success/10 text-success",
  paused: "bg-warning/10 text-warning",
  done: "bg-accent/10 text-accent",
  archived: "bg-muted/40 text-muted-foreground",
};

export default function BrainProjectsPage() {
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();

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
          notify({ title: "Project created", tone: "success" });
          setName("");
          setDescription("");
          setCreating(false);
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not create project",
            tone: "error",
          }),
      }
    );
  }

  async function handleDelete(project: BrainProject) {
    const confirmed = await askConfirm({
      title: `Delete "${project.name}"?`,
      message: `Its ${project.memoryCount} memor${project.memoryCount === 1 ? "y" : "ies"} are kept — they simply stop belonging to a project.`,
      confirmText: "Delete project",
      danger: true,
    });
    if (!confirmed) return;

    deleteProject.mutate(project.id, {
      onSuccess: () => notify({ title: "Project deleted", tone: "success" }),
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : "Could not delete project",
          tone: "error",
        }),
    });
  }

  return (
    <BrainShell
      title="Projects"
      description="Group memories by the work they belong to. Agents can narrow recall to one project."
      actions={
        <Button size="sm" onClick={() => setCreating((value) => !value)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New project
        </Button>
      }
    >
      {dialogs}

      <div className="space-y-5">
        {creating && (
          <BrainPanel icon={Plus} title="New project">
            <form onSubmit={handleCreate} className="space-y-3">
              <Input
                value={name}
                maxLength={150}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                aria-label="Project name"
                autoFocus
              />
              <Input
                value={description}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this project about? (optional)"
                aria-label="Project description"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!name.trim() || createProject.isPending}>
                  {createProject.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  Create
                </Button>
              </div>
            </form>
          </BrainPanel>
        )}

        {projects.isLoading && <BrainLoading label="Loading projects" />}
        {projects.isError && (
          <BrainErrorState
            message="Could not load projects."
            onRetry={() => void projects.refetch()}
          />
        )}

        {projects.data &&
          (projects.data.projects.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {projects.data.projects.map((project) => (
                <article
                  key={project.id}
                  className="rounded-2xl border border-border/50 bg-surface p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{project.name}</h3>
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        STATUS_TONE[project.status]
                      )}
                    >
                      {project.status}
                    </span>
                  </div>

                  {project.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {project.description}
                    </p>
                  )}

                  <p className="mt-2 text-xs text-muted-foreground">
                    {project.memoryCount} memor{project.memoryCount === 1 ? "y" : "ies"} · updated{" "}
                    {formatDate(project.updatedAt, "short")}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button asChild variant="secondary" size="sm">
                      <Link href={`/brain/memories?project=${project.id}`}>Open memories</Link>
                    </Button>
                    <select
                      value={project.status}
                      aria-label={`Status of ${project.name}`}
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
                                    : "Could not update project",
                                tone: "error",
                              }),
                          }
                        )
                      }
                      className="h-8 rounded-lg border border-border/60 bg-surface px-2 text-xs text-foreground focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
                    >
                      {PROJECT_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${project.name}`}
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
            <EmptyState
              icon={FolderKanban}
              title="No projects yet"
              description="A project groups the memories of one piece of work, so an agent can load just that context."
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  Create a project
                </Button>
              }
            />
          ))}
      </div>
    </BrainShell>
  );
}
