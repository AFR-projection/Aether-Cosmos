"use client";

import { useState } from "react";
import { Archive, Download, Loader2, Plus, Save, Settings2 } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainLoading, BrainPanel } from "@brain/presentation/components/brain-states";
import { EmbeddingSettingsCard } from "@brain/presentation/components/embedding-settings-card";
import { notify } from "@/shared/lib/system/notify-store";
import { apiFetch } from "@/shared/api/client";
import { useFormat, useT } from "@/shared/lib/i18n";
import { useActiveBrain, useCreateBrain, useUpdateBrain } from "@brain/presentation/hooks/use-brain";

export default function BrainSettingsPage() {
  const { brain, brains, select } = useActiveBrain();
  const updateBrain = useUpdateBrain(brain?.id);
  const createBrain = useCreateBrain();
  const t = useT();
  const { formatDate, formatNumber } = useFormat();

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
        onSuccess: () => notify({ title: t("brain.settings.updated"), tone: "success" }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.settings.updateFailed"),
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
            title: archiving
              ? t("brain.settings.archivedNotice")
              : t("brain.settings.reactivated"),
            tone: "success",
          }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.settings.statusChangeFailed"),
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
        throw new Error(res.error ?? t("brain.settings.exportFailed"));
      }
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      // The filename stays ASCII and locale-free: it has to survive every OS.
      const slug = brain.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      link.href = url;
      link.download = `${slug || "brain"}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      notify({ title: t("brain.settings.exported"), tone: "success" });
    } catch (error) {
      notify({
        title: error instanceof Error ? error.message : t("brain.settings.exportFailed"),
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
          notify({
            title: t("brain.settings.created", { name: data.brain.name }),
            tone: "success",
          });
          setNewName("");
          select(data.brain.id);
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.settings.createFailed"),
            tone: "error",
          }),
      }
    );
  }

  if (!brain) {
    return (
      <BrainShell title={t("brain.settings.title")}>
        <BrainLoading label={t("brain.settings.loading")} />
      </BrainShell>
    );
  }

  return (
    <BrainShell
      title={t("brain.settings.title")}
      description={t("brain.settings.description")}
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <BrainPanel icon={Settings2} title={t("brain.settings.thisBrain")}>
          <form onSubmit={handleSave} className="space-y-3">
            <div>
              <label htmlFor="brain-name" className="mb-1.5 block text-xs font-medium text-foreground">
                {t("brain.settings.name")}
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
                {t("brain.settings.descriptionLabel")}
              </label>
              <Input
                id="brain-description"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("brain.settings.descriptionPlaceholder")}
              />
            </div>
            <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="brain-chip brain-chip--mono" data-tone={brain.status === "active" ? "success" : "muted"}>
                {brain.status === "active"
                  ? t("brain.settings.statusActive")
                  : t("brain.settings.statusArchived")}
              </span>
              {brain.isDefault && (
                <span className="brain-chip brain-chip--mono" data-tone="accent">
                  {t("brain.settings.defaultChip")}
                </span>
              )}
              {t("brain.settings.createdOn", { date: formatDate(brain.createdAt, "medium") })}
            </p>
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!name.trim() || updateBrain.isPending}>
                {updateBrain.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                <Save className="h-4 w-4" aria-hidden="true" />
                {t("common.save")}
              </Button>
            </div>
          </form>
        </BrainPanel>

        <div className="space-y-5">
          <BrainPanel icon={Download} title={t("brain.settings.exportTitle")}>
            <p className="text-sm text-muted-foreground">{t("brain.settings.exportBody")}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("brain.settings.exportNote")}
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
              {t("brain.settings.exportAction")}
            </Button>
          </BrainPanel>

          <BrainPanel icon={Archive} title={t("brain.settings.statusTitle")}>
            <p className="text-sm text-muted-foreground">
              {brain.status === "active"
                ? t("brain.settings.statusActiveBody")
                : t("brain.settings.statusArchivedBody")}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={updateBrain.isPending}
              onClick={handleArchiveToggle}
            >
              <Archive className="h-4 w-4" aria-hidden="true" />
              {brain.status === "active"
                ? t("brain.settings.archiveAction")
                : t("brain.settings.reactivateAction")}
            </Button>
          </BrainPanel>

          <BrainPanel
            icon={Plus}
            title={t("brain.settings.yourBrains", { count: formatNumber(brains.length) })}
          >
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
                        {t("brain.settings.defaultChip")}
                      </span>
                    )}
                    {option.id === brain.id && (
                      <span className="brain-chip brain-chip--mono shrink-0">
                        {t("brain.settings.currentChip")}
                      </span>
                    )}
                  </span>
                  {option.id !== brain.id && (
                    <Button variant="ghost" size="sm" onClick={() => select(option.id)}>
                      {t("brain.settings.switch")}
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
                placeholder={t("brain.settings.newBrainPlaceholder")}
                aria-label={t("brain.settings.newBrainPlaceholder")}
              />
              <Button type="submit" size="sm" disabled={!newName.trim() || createBrain.isPending}>
                {createBrain.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {t("brain.settings.add")}
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
