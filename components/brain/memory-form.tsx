"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { MEMORY_TYPE_OPTIONS } from "@/lib/brain/ui-constants";
import type { BrainProject, MemoryDraft } from "@/hooks/use-brain";

export type MemoryFormValues = MemoryDraft & { changeReason?: string };

/**
 * Create/edit form for a memory. Used by both the list page (create) and the
 * detail page (edit), so the field set and validation stay identical.
 */
export function MemoryForm({
  initial,
  projects,
  submitLabel,
  showChangeReason,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<MemoryFormValues>;
  projects: BrainProject[];
  submitLabel: string;
  showChangeReason?: boolean;
  pending: boolean;
  error?: string | null;
  onSubmit: (values: MemoryFormValues) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [type, setType] = useState(initial?.type ?? "fact");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [importance, setImportance] = useState(initial?.importance ?? 0.5);
  const [confidence, setConfidence] = useState(initial?.confidence ?? 0.9);
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(", "));
  const [changeReason, setChangeReason] = useState("");

  const canSubmit = title.trim().length > 0 && content.trim().length > 0 && !pending;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      title: title.trim(),
      content,
      type,
      summary: summary.trim() || undefined,
      importance,
      confidence,
      projectId: projectId || null,
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      ...(showChangeReason && changeReason.trim() ? { changeReason: changeReason.trim() } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="memory-title" className="mb-1.5 block text-xs font-medium text-foreground">
          Title
        </label>
        <Input
          id="memory-title"
          value={title}
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Production deployment requires Redis"
          autoFocus
        />
      </div>

      <div>
        <label htmlFor="memory-content" className="mb-1.5 block text-xs font-medium text-foreground">
          Content
        </label>
        <textarea
          id="memory-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={7}
          placeholder="What should be remembered, and why it matters."
          className="w-full rounded-xl border border-border/60 bg-surface px-3 py-2 text-base text-foreground transition-all placeholder:text-muted-foreground/50 focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15 sm:text-sm"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="memory-type" className="mb-1.5 block text-xs font-medium text-foreground">
            Type
          </label>
          <select
            id="memory-type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="h-10 w-full rounded-xl border border-border/60 bg-surface px-3 text-sm text-foreground focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
          >
            {MEMORY_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="memory-project"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            Project
          </label>
          <select
            id="memory-project"
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value)}
            className="h-10 w-full rounded-xl border border-border/60 bg-surface px-3 text-sm text-foreground focus-visible:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="memory-summary" className="mb-1.5 block text-xs font-medium text-foreground">
          Summary <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="memory-summary"
          value={summary}
          maxLength={1000}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="One line an agent can read instead of the full content"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SliderField
          id="memory-importance"
          label="Importance"
          hint="How aggressively should this be recalled?"
          value={importance}
          onChange={setImportance}
        />
        <SliderField
          id="memory-confidence"
          label="Confidence"
          hint="How sure are we this is true?"
          value={confidence}
          onChange={setConfidence}
        />
      </div>

      <div>
        <label htmlFor="memory-tags" className="mb-1.5 block text-xs font-medium text-foreground">
          Tags <span className="font-normal text-muted-foreground">(comma separated)</span>
        </label>
        <Input
          id="memory-tags"
          value={tagsText}
          onChange={(event) => setTagsText(event.target.value)}
          placeholder="deployment, redis"
        />
      </div>

      {showChangeReason && (
        <div>
          <label
            htmlFor="memory-reason"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            Why are you changing this?{" "}
            <span className="font-normal text-muted-foreground">(saved with the version)</span>
          </label>
          <Input
            id="memory-reason"
            value={changeReason}
            maxLength={300}
            onChange={(event) => setChangeReason(event.target.value)}
            placeholder="Corrected after checking the deploy script"
          />
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <X className="h-4 w-4" aria-hidden="true" />
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function SliderField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={cn("w-full accent-[var(--accent)]")}
      />
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
