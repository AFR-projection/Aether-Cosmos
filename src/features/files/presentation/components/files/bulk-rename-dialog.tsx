"use client";

import { useMemo, useState } from "react";
import { ArrowRight, PencilRuler } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Field } from "@/ui/primitives/field";
import { Modal } from "@/ui/primitives/modal";
import { cn } from "@/shared/lib/utils";
import { useFormat, useT } from "@/shared/lib/i18n";

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
  const t = useT();
  const { formatNumber } = useFormat();
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
      title={t("files.bulkRename.title", { count: files.length })}
      description={t("files.bulkRename.description")}
      bodyClassName="flex min-h-0 flex-col overflow-y-hidden p-0"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={changed.length === 0}
            onClick={() => onConfirm(changed.map((c) => ({ id: c.id, name: c.to })))}
          >
            {changed.length === 0
              ? t("common.rename")
              : t("files.bulkRename.submitCount", { count: changed.length })}
          </Button>
        </>
      }
    >
      <div className="shrink-0 space-y-3 border-b border-border/50 px-5 py-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("files.bulkRename.find")}>
            {(field) => (
              <Input
                {...field}
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder={t("files.bulkRename.findPlaceholder")}
                className="h-9"
              />
            )}
          </Field>
          <Field label={t("files.bulkRename.replace")}>
            {(field) => (
              <Input
                {...field}
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder={t("files.bulkRename.replacePlaceholder")}
                className="h-9"
              />
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("files.bulkRename.prefix")}>
            {(field) => (
              <Input
                {...field}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder={t("files.bulkRename.prefixPlaceholder")}
                className="h-9"
              />
            )}
          </Field>
          <Field
            label={t("files.bulkRename.startNumber")}
            hint={numbering ? undefined : t("files.bulkRename.startNumberHint")}
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
            {t("files.bulkRename.numbering")}{" "}
            {/* The "{n}" marker travels as a parameter so each language can put
                it wherever the sentence needs it. */}
            <span className="text-muted-foreground">
              {t("files.bulkRename.numberingHint", { token: "{n}" })}
            </span>
          </span>
        </label>
      </div>

      {/* Focusable and named: the preview is a scroll container, and a list of 50
          renames is unreachable with a keyboard if nothing in it can take focus. */}
      <div
        className="min-h-[6rem] flex-1 overflow-y-auto px-5 py-3"
        role="region"
        aria-label={t("files.bulkRename.previewLabel")}
        tabIndex={0}
      >
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {t("files.bulkRename.previewSummary", {
            changed: formatNumber(changed.length),
            total: formatNumber(files.length),
          })}
          {blocked > 0 && (
            <span className="text-danger-ink">
              {" "}
              {t("files.bulkRename.previewSkipped", { count: blocked })}
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
                {/* The separating space stays in JSX: inside a dictionary value a
                    leading space is invisible and easily lost. */}
                {p.emptied ? (
                  <span className="sr-only"> {t("files.bulkRename.srSkipped")}</span>
                ) : (
                  !p.willChange && <span className="sr-only"> {t("files.bulkRename.srUnchanged")}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
