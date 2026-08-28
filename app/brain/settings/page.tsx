"use client";

import { useState } from "react";
import { Archive, Download, Loader2, Plus, Save, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { EmbeddingSettingsCard } from "@/components/brain/embedding-settings-card";
import { notify } from "@/lib/system/notify-store";
import { apiFetch } from "@/lib/api/client";
import { formatDate } from "@/lib/utils";
import { useActiveBrain, useCreateBrain, useUpdateBrain } from "@/hooks/use-brain";

export default function BrainSettingsPage() {
  const { brain, brains, select } = useActiveBrain();
  const updateBrain = useUpdateBrain(brain?.id);
  const createBrain = useCreateBrain();

  const [name, setName] = useState(brain?.name ?? "");
  const [description, setDescription] = useState(brain?.description ?? "");
  const [dirtyFor, setDirtyFor] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [exporting, setExporting] = useState(false);

  // Re-seed the form when the selected brain changes, without an effect: the
  // brain id we last seeded from is the state that matters.
  if (brain && dirtyFor !== brain.id) {
    setDirtyFor(brain.id);
    setName(brain.name);
    setDescription(brain.description ?? "");
  }

  function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!brain || !name.trim()) return;
    updateBrain.mutate(
      { name: name.trim(), description: description.trim() || null },
      {
        onSuccess: () => notify({ title: "Brain updated", tone: "success" }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not update brain",
            tone: "error",
          }),
      }
    );
  }

  function handleArchiveToggle() {
    if (!brain) return;
    const archiving = brain.status === "active";
    updateBrain.mutate(
      { status: archiving ? "archived" : "active" },
      {
        onSuccess: () =>
          notify({
            title: archiving ? "Brain archived — it is now read-only" : "Brain reactivated",
            tone: "success",
          }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not change status",
            tone: "error",
          }),
      }
    );
  }

  /**
   * Export goes through the same JSON endpoint an agent uses, then is saved
   * client-side so the download carries the brain name and today's date.
   */
  async function handleExport() {
    if (!brain) return;
    setExporting(true);
    try {
      const res = await apiFetch<Record<string, unknown>>(`/api/brain/${brain.id}/export`);
      if (!res.success || !res.data) {
        throw new Error(res.error ?? "Export failed");
      }
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const slug = brain.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      link.href = url;
      link.download = `${slug || "brain"}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      notify({ title: "Brain exported", tone: "success" });
    } catch (error) {
      notify({
        title: error instanceof Error ? error.message : "Export failed",
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  }

  function handleCreateBrain(event: React.FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    createBrain.mutate(
      { name: newName.trim() },
      {
        onSuccess: (data) => {
          notify({ title: `Created "${data.brain.name}"`, tone: "success" });
          setNewName("");
          select(data.brain.id);
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not create brain",
            tone: "error",
          }),
      }
    );
  }

  if (!brain) return <BrainShell title="Settings"><BrainLoading label="Loading brain" /></BrainShell>;

  return (
    <BrainShell title="Settings" description="Rename, archive, export, or add another brain.">
      <div className="grid gap-5 lg:grid-cols-2">
        <BrainPanel icon={Settings2} title="This brain">
          <form onSubmit={handleSave} className="space-y-3">
            <div>
              <label htmlFor="brain-name" className="mb-1.5 block text-xs font-medium text-foreground">
                Name
              </label>
              <Input
                id="brain-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="brain-description"
                className="mb-1.5 block text-xs font-medium text-foreground"
              >
                Description
              </label>
              <Input
                id="brain-description"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this brain for?"
              />
            </div>
            <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="brain-chip brain-chip--mono" data-tone={brain.status === "active" ? "success" : "muted"}>
                {brain.status}
              </span>
              {brain.isDefault && (
                <span className="brain-chip brain-chip--mono" data-tone="accent">
                  default
                </span>
              )}
              Created {formatDate(brain.createdAt, "medium")}
            </p>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!name.trim() || updateBrain.isPending}>
                {updateBrain.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                <Save className="h-4 w-4" aria-hidden="true" />
                Save
              </Button>
            </div>
          </form>
        </BrainPanel>

        <div className="space-y-5">
          <BrainPanel icon={Download} title="Export">
            <p className="text-sm text-muted-foreground">
              Downloads this brain as JSON: memories with their tags and provenance, projects, and
              the knowledge graph. No credentials are included.
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Export only. Use this for backups; import is not available.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={exporting}
              onClick={() => void handleExport()}
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
              )}
              Export brain
            </Button>
          </BrainPanel>

          <BrainPanel icon={Archive} title="Status">
            <p className="text-sm text-muted-foreground">
              {brain.status === "active"
                ? "Archiving makes this brain read-only. Nothing is deleted, and agents can still recall from it."
                : "This brain is archived and read-only. Reactivate it to allow writes again."}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={updateBrain.isPending}
              onClick={handleArchiveToggle}
            >
              <Archive className="h-4 w-4" aria-hidden="true" />
              {brain.status === "active" ? "Archive brain" : "Reactivate brain"}
            </Button>
          </BrainPanel>

          <BrainPanel icon={Plus} title={`Your brains (${brains.length})`}>
            <ul className="space-y-1.5">
              {brains.map((option) => (
                <li
                  key={option.id}
                  className="brain-surface--flush flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-sm text-foreground">{option.name}</span>
                    {option.isDefault && (
                      <span className="brain-chip brain-chip--mono shrink-0" data-tone="accent">
                        default
                      </span>
                    )}
                    {option.id === brain.id && (
                      <span className="brain-chip brain-chip--mono shrink-0">current</span>
                    )}
                  </span>
                  {option.id !== brain.id && (
                    <Button variant="ghost" size="sm" onClick={() => select(option.id)}>
                      Switch
                    </Button>
                  )}
                </li>
              ))}
            </ul>

            <form onSubmit={handleCreateBrain} className="mt-3 flex gap-2">
              <Input
                value={newName}
                maxLength={100}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="New brain name"
                aria-label="New brain name"
              />
              <Button type="submit" size="sm" disabled={!newName.trim() || createBrain.isPending}>
                {createBrain.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Add
              </Button>
            </form>
          </BrainPanel>
        </div>
      </div>

      <div className="mt-5">
        <EmbeddingSettingsCard />
      </div>
    </BrainShell>
  );
}
