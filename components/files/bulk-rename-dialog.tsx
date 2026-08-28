"use client";

import { useMemo, useState } from "react";
import { ArrowRight, PencilRuler } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

export type BulkRenameTarget = { id: string; name: string };

type BulkRenameDialogProps = {
  files: BulkRenameTarget[];
  onCancel: () => void;
  /** Receives [{ id, name }] only for files whose name actually changed. */
  onConfirm: (renames: { id: string; name: string }[]) => void;
};

function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Compute the new name for one file given the rename options.
 * Order: find/replace on stem → prefix → optional "{n}" numbering → keep ext.
 *
 * Returns the parts, not just the joined name: the caller has to know whether the
 * *stem* survived, and once the extension is back on, a wiped stem reads as the
 * perfectly non-empty ".pdf" to every string test.
 */
function buildName(
  original: string,
  index: number,
  opts: { find: string; replace: string; prefix: string; numbering: boolean; start: number; width: number }
): { stem: string; ext: string; name: string } {
  const { stem, ext } = splitExt(original);
  let out = stem;
  if (opts.find) {
    // Literal (not regex) find/replace — safe for arbitrary filenames.
    out = out.split(opts.find).join(opts.replace);
  }
  if (opts.prefix) out = `${opts.prefix}${out}`;
  if (opts.numbering) {
    const num = pad(opts.start + index, opts.width);
    out = out.includes("{n}") ? out.split("{n}").join(num) : `${out} ${num}`;
  }
  return { stem: out, ext, name: `${out}${ext}` };
}

export function BulkRenameDialog({ files, onCancel, onConfirm }: BulkRenameDialogProps) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [prefix, setPrefix] = useState("");
  const [numbering, setNumbering] = useState(false);
  const [start, setStart] = useState(1);

  const width = useMemo(() => String(start + files.length - 1).length, [start, files.length]);

  const preview = useMemo(
    () =>
      files.map((f, i) => {
        const next = buildName(f.name, i, { find, replace, prefix, numbering, start, width });
        // Emptying the stem is a rule the file cannot be renamed under, not a
        // rename to ".pdf" — it is called out in the preview and left out of the
        // batch rather than silently passing as "unchanged".
        const emptied = next.stem.trim().length === 0;
        return {
          id: f.id,
          from: f.name,
          to: next.name,
          emptied,
          willChange: !emptied && next.name !== f.name,
        };
      }),
    [files, find, replace, prefix, numbering, start, width]
  );

  const changed = preview.filter((p) => p.willChange);
  const blocked = preview.filter((p) => p.emptied).length;

  return (
    <Modal
      open
      onClose={onCancel}
      icon={PencilRuler}
      size="lg"
      title={`Bulk rename ${files.length} file${files.length === 1 ? "" : "s"}`}
      description="Extensions are always preserved."
      bodyClassName="flex min-h-0 flex-col overflow-y-hidden p-0"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={changed.length === 0}
            onClick={() => onConfirm(changed.map((c) => ({ id: c.id, name: c.to })))}
          >
            {changed.length === 0
              ? "Rename"
              : `Rename ${changed.length} file${changed.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="shrink-0 space-y-3 border-b border-border/50 px-5 py-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Find">
            {(field) => (
              <Input
                {...field}
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="text to replace"
                className="h-9"
              />
            )}
          </Field>
          <Field label="Replace with">
            {(field) => (
              <Input
                {...field}
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder="new text"
                className="h-9"
              />
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Prefix">
            {(field) => (
              <Input
                {...field}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="e.g. 2026_"
                className="h-9"
              />
            )}
          </Field>
          <Field
            label="Start number"
            hint={numbering ? undefined : "Enable numbering to use this"}
          >
            {(field) => (
              <Input
                {...field}
                type="number"
                value={start}
                min={0}
                onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                disabled={!numbering}
                className="h-9"
              />
            )}
          </Field>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 py-1">
          <input
            type="checkbox"
            checked={numbering}
            onChange={(e) => setNumbering(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
          />
          <span className="text-xs leading-relaxed">
            Append sequential numbers{" "}
            <span className="text-muted-foreground">
              (or place <code className="font-mono">{"{n}"}</code> inside the prefix)
            </span>
          </span>
        </label>
      </div>

      {/* Focusable and named: the preview is a scroll container, and a list of 50
          renames is unreachable with a keyboard if nothing in it can take focus. */}
      <div
        className="min-h-[6rem] flex-1 overflow-y-auto px-5 py-3"
        role="region"
        aria-label="Rename preview"
        tabIndex={0}
      >
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Preview · {changed.length} of {files.length} will change
          {blocked > 0 && (
            <span className="text-danger-ink">
              {" "}
              · {blocked} skipped, name would be empty
            </span>
          )}
        </p>
        <ul className="space-y-1">
          {preview.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.from}</span>
              <ArrowRight
                className={cn(
                  "h-3 w-3 shrink-0",
                  p.emptied ? "text-danger-ink" : p.willChange ? "text-accent-ink" : "text-muted-foreground"
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-medium",
                  p.emptied ? "text-danger-ink" : p.willChange ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {p.to}
                {p.emptied ? (
                  <span className="sr-only"> (skipped, name would be empty)</span>
                ) : (
                  !p.willChange && <span className="sr-only"> (unchanged)</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
