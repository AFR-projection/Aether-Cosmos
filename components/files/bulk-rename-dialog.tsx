"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, PencilRuler, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
 */
function buildName(
  original: string,
  index: number,
  opts: { find: string; replace: string; prefix: string; numbering: boolean; start: number; width: number }
): string {
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
  return `${out}${ext}`;
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
      files.map((f, i) => ({
        id: f.id,
        from: f.name,
        to: buildName(f.name, i, { find, replace, prefix, numbering, start, width }),
      })),
    [files, find, replace, prefix, numbering, start, width]
  );

  const changed = preview.filter((p) => p.to !== p.from && p.to.trim().length > 0);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="scrim fixed inset-0 z-[80] flex items-center justify-center p-4"
        onClick={onCancel}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.18 }}
          className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative border-b border-border bg-gradient-to-br from-accent/10 to-transparent px-5 py-4">
            <button
              onClick={onCancel}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15">
                <PencilRuler className="h-4 w-4 text-accent" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Bulk rename {files.length} files</h2>
                <p className="text-[11px] text-muted-foreground">Extensions are always preserved</p>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="space-y-3 border-b border-border/50 px-5 py-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Find</label>
                <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="text to replace" className="h-9" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Replace with</label>
                <Input value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="new text" className="h-9" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Prefix</label>
                <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. 2026_" className="h-9" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Start number</label>
                <Input
                  type="number"
                  value={start}
                  min={0}
                  onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                  disabled={!numbering}
                  className="h-9"
                />
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={numbering}
                onChange={(e) => setNumbering(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span className="text-[12px]">
                Append sequential numbers{" "}
                <span className="text-muted-foreground">(or place <code>{"{n}"}</code> in the prefix)</span>
              </span>
            </label>
          </div>

          {/* Live preview */}
          <div className="min-h-[6rem] flex-1 overflow-y-auto px-5 py-3">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">
              Preview · {changed.length} will change
            </p>
            <ul className="space-y-1">
              {preview.map((p) => {
                const willChange = p.to !== p.from && p.to.trim().length > 0;
                return (
                  <li key={p.id} className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{p.from}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-medium",
                        willChange ? "text-foreground" : "text-muted-foreground/40"
                      )}
                    >
                      {p.to}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={changed.length === 0}
              onClick={() => onConfirm(changed.map((c) => ({ id: c.id, name: c.to })))}
            >
              Rename {changed.length || ""}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
