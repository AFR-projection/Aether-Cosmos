"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Brain as BrainIcon, Check, Plus, Search, X } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@brain/presentation/components/brain-states";
import { MemoryCard } from "@brain/presentation/components/memory-card";
import { MemoryForm } from "@brain/presentation/components/memory-form";
import { notify } from "@/shared/lib/system/notify-store";
import { useDebouncedValue } from "@/ui/hooks/use-debounced-value";
import { useT } from "@/shared/lib/i18n";
import { MEMORY_TYPE_OPTIONS } from "@brain/domain/ui-constants";
import {
  useActiveBrain,
  useBrainTags,
  useCreateMemory,
  useMemories,
  useProjects,
} from "@brain/presentation/hooks/use-brain";

export default function BrainMemoriesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { brain } = useActiveBrain();
  const t = useT();

  const [creating, setCreating] = useState(searchParams.get("new") === "1");
  // The graph view deep-links here as ?q=<label> when a memory node is opened.
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  // Deep links from the projects page arrive as ?project=<id>.
  const [projectId, setProjectId] = useState(searchParams.get("project") ?? "");
  const [archived, setArchived] = useState(false);

  // The raw input drives the field; the debounced value drives the query key.
  const debouncedSearch = useDebouncedValue(search);

  const filters = useMemo(
    () => ({
      q: debouncedSearch,
      type: type || undefined,
      tag: tag || undefined,
      projectId: projectId || undefined,
      archived,
    }),
    [debouncedSearch, type, tag, projectId, archived]
  );

  const memories = useMemories(brain?.id, filters);
  const projects = useProjects(brain?.id);
  const tags = useBrainTags(brain?.id);
  const createMemory = useCreateMemory(brain?.id);

  const hasFilters = !!(search.trim() || type || tag || projectId || archived);

  function clearFilters() {
    setSearch("");
    setType("");
    setTag("");
    setProjectId("");
    setArchived(false);
  }

  function closeForm() {
    setCreating(false);
    // Drop ?new=1 so a refresh does not reopen the form, while keeping ?project.
    if (searchParams.get("new")) {
      const project = searchParams.get("project");
      router.replace(project ? `/brain/memories?project=${project}` : "/brain/memories");
    }
  }

  return (
    <BrainShell
      title={t("brain.memories.title")}
      description={t("brain.memories.description")}
      actions={
        <Button size="sm" onClick={() => setCreating((value) => !value)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("brain.memories.newMemory")}
        </Button>
      }
    >
      <div className="space-y-5">
        {creating && (
          <BrainPanel icon={Plus} title={t("brain.memories.newMemory")}>
            <MemoryForm
              projects={projects.data?.projects ?? []}
              submitLabel={t("brain.memories.saveMemory")}
              pending={createMemory.isPending}
              error={createMemory.error instanceof Error ? createMemory.error.message : null}
              onCancel={closeForm}
              onSubmit={(values) => {
                createMemory.mutate(values, {
                  onSuccess: () => {
                    notify({ title: t("brain.memories.saved"), tone: "success" });
                    closeForm();
                  },
                  onError: (error) =>
                    notify({
                      title:
                        error instanceof Error
                          ? error.message
                          : t("brain.memories.saveFailed"),
                      tone: "error",
                    }),
                });
              }}
            />
          </BrainPanel>
        )}

        <div className="brain-surface p-4">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("brain.memories.searchPlaceholder")}
              aria-label={t("brain.memories.searchLabel")}
              className="h-9 border-0 bg-transparent px-0 focus-visible:border-0 focus-visible:ring-0"
            />
            {hasFilters && (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-4 w-4" aria-hidden="true" />
                {t("brain.memories.clearFilters")}
              </Button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
            <FilterSelect
              label={t("brain.memories.filterType")}
              value={type}
              onChange={setType}
              options={[
                { value: "", label: t("brain.memories.allTypes") },
                ...MEMORY_TYPE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                })),
              ]}
            />
            <FilterSelect
              label={t("brain.memories.filterProject")}
              value={projectId}
              onChange={setProjectId}
              options={[
                { value: "", label: t("brain.memories.allProjects") },
                ...(projects.data?.projects ?? []).map((project) => ({
                  value: project.id,
                  label: project.name,
                })),
              ]}
            />
            <FilterSelect
              label={t("brain.memories.filterTag")}
              value={tag}
              onChange={setTag}
              options={[
                { value: "", label: t("brain.memories.allTags") },
                ...(tags.data?.tags ?? []).map((item) => ({
                  value: item.name,
                  label: item.name,
                })),
              ]}
            />
            <label className="brain-scope brain-scope--inline ml-auto">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              <span className="brain-scope__box" aria-hidden="true">
                <Check />
              </span>
              <span className="brain-scope__label">{t("brain.memories.archivedOnly")}</span>
            </label>
          </div>
        </div>

        {memories.isLoading && <BrainLoading label={t("brain.memories.loading")} rows={4} />}
        {memories.isError && (
          <BrainErrorState
            message={t("brain.memories.loadFailed")}
            onRetry={() => void memories.refetch()}
          />
        )}

        {memories.data &&
          (memories.data.memories.length > 0 ? (
            <div className="space-y-3">
              {memories.data.memories.map((memory) => (
                <MemoryCard key={memory.id} memory={memory} />
              ))}
              {memories.data.nextCursor && (
                <p className="pt-1 text-center text-xs text-muted-foreground">
                  {t("brain.memories.truncated", { count: memories.data.memories.length })}
                </p>
              )}
            </div>
          ) : (
            <div className="brain-empty">
              <span className="brain-empty__icon">
                <BrainIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="brain-empty__title">
                {hasFilters
                  ? t("brain.memories.emptyFilteredTitle")
                  : t("brain.memories.emptyTitle")}
              </p>
              <p className="brain-empty__body">
                {hasFilters
                  ? t("brain.memories.emptyFilteredBody")
                  : t("brain.memories.emptyBody")}
              </p>
              {hasFilters ? (
                <Button size="sm" variant="secondary" className="mt-1" onClick={clearFilters}>
                  <X className="h-4 w-4" aria-hidden="true" />
                  {t("brain.memories.clearFilters")}
                </Button>
              ) : (
                <Button size="sm" className="mt-1" onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("brain.memories.writeMemory")}
                </Button>
              )}
            </div>
          ))}
      </div>
    </BrainShell>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-8 cursor-pointer rounded-lg border border-border/60 bg-surface px-2 text-xs text-foreground transition-colors hover:border-accent/30 focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
