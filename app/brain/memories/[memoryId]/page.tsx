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
import { Button } from "@/components/ui/button";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { MemoryForm } from "@/components/brain/memory-form";
import { MemoryTypeBadge, ScoreMeter } from "@/components/brain/memory-card";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { notify } from "@/lib/system/notify-store";
import { formatDate } from "@/lib/utils";
import {
  useActiveBrain,
  useDeleteMemory,
  useMemory,
  useMemoryVersions,
  useProjects,
  useRestoreVersion,
  useUpdateMemory,
} from "@/hooks/use-brain";

export default function MemoryDetailPage() {
  const params = useParams<{ memoryId: string }>();
  const memoryId = params.memoryId;
  const router = useRouter();
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();

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
          notify({ title: archiving ? "Memory archived" : "Memory restored", tone: "success" }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not update memory",
            tone: "error",
          }),
      }
    );
  }

  async function handleDelete() {
    if (!memory) return;
    const confirmed = await askConfirm({
      title: "Delete this memory?",
      message:
        "It is soft-deleted and stops appearing everywhere, including for agents. Archiving keeps it searchable instead.",
      confirmText: "Delete",
      danger: true,
    });
    if (!confirmed) return;

    deleteMemory.mutate(memory.id, {
      onSuccess: () => {
        notify({ title: "Memory deleted", tone: "success" });
        router.push("/brain/memories");
      },
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : "Could not delete memory",
          tone: "error",
        }),
    });
  }

  async function handleRestore(versionId: string, versionNumber: number) {
    const confirmed = await askConfirm({
      title: `Restore version ${versionNumber}?`,
      message:
        "The current text is saved as a new version first, so nothing is lost either way.",
      confirmText: "Restore",
    });
    if (!confirmed) return;

    restoreVersion.mutate(versionId, {
      onSuccess: () => notify({ title: `Restored version ${versionNumber}`, tone: "success" }),
      onError: (error) =>
        notify({
          title: error instanceof Error ? error.message : "Could not restore version",
          tone: "error",
        }),
    });
  }

  return (
    <BrainShell
      title={memory?.title ?? "Memory"}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/brain/memories">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Link>
        </Button>
      }
    >
      {dialogs}

      {memoryQuery.isLoading && <BrainLoading label="Loading memory" rows={2} />}
      {memoryQuery.isError && (
        <BrainErrorState
          message="This memory could not be loaded. It may have been deleted."
          onRetry={() => void memoryQuery.refetch()}
        />
      )}

      {memory && (
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-5">
            {editing ? (
              <BrainPanel icon={Pencil} title="Edit memory">
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
                  submitLabel="Save changes"
                  showChangeReason
                  pending={updateMemory.isPending}
                  error={updateMemory.error instanceof Error ? updateMemory.error.message : null}
                  onCancel={() => setEditing(false)}
                  onSubmit={(values) =>
                    updateMemory.mutate(values, {
                      onSuccess: () => {
                        notify({ title: "Memory updated", tone: "success" });
                        setEditing(false);
                      },
                      onError: (error) =>
                        notify({
                          title:
                            error instanceof Error ? error.message : "Could not update memory",
                          tone: "error",
                        }),
                    })
                  }
                />
              </BrainPanel>
            ) : (
              <BrainPanel
                icon={Pencil}
                title="Content"
                action={
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    Edit
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

            <BrainPanel icon={History} title="Version history">
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
                          {version.changeReason ?? "no reason given"} ·{" "}
                          {formatDate(version.createdAt, "short")} ·{" "}
                          {version.changedByAgent ? "agent" : "you"}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={restoreVersion.isPending}
                        onClick={() => void handleRestore(version.id, version.versionNumber)}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        Restore
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No earlier versions yet. Every edit to the title, content or summary saves one.
                </p>
              )}
            </BrainPanel>
          </div>

          <div className="space-y-5">
            <BrainPanel icon={Archive} title="Details">
              <dl className="space-y-3 text-sm">
                <Detail label="Type">
                  <MemoryTypeBadge type={memory.type} />
                </Detail>
                <Detail label="Scores">
                  <span className="flex flex-wrap items-center gap-3">
                    <ScoreMeter label="imp" value={memory.importance} tone="accent" />
                    <ScoreMeter label="conf" value={memory.confidence} tone="warning" />
                  </span>
                </Detail>
                <Detail label="Project">
                  {project ? (
                    <Link href="/brain/projects" className="text-accent-ink hover:underline">
                      {project.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </Detail>
                <Detail label="Tags">
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
                    <span className="text-muted-foreground">none</span>
                  )}
                </Detail>
                <Detail label="Source">
                  <span className="text-muted-foreground">
                    {memory.sourceType}
                    {memory.createdByAgent ? " (agent)" : ""}
                  </span>
                </Detail>
                <Detail label="Version">
                  <span className="text-muted-foreground">v{memory.version}</span>
                </Detail>
                <Detail label="Created">
                  <span className="text-muted-foreground">
                    {formatDate(memory.createdAt, "medium")}
                  </span>
                </Detail>
                <Detail label="Updated">
                  <span className="text-muted-foreground">
                    {formatDate(memory.updatedAt, "medium")}
                  </span>
                </Detail>
              </dl>
            </BrainPanel>

            <BrainPanel icon={Trash2} title="Lifecycle">
              <p className="text-sm text-muted-foreground">
                Archiving keeps a memory recoverable and out of recall. Deleting hides it from
                everything, including agents.
              </p>
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
                  {memory.archivedAt ? "Unarchive" : "Archive"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleteMemory.isPending}
                  onClick={() => void handleDelete()}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
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
