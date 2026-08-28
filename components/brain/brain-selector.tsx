"use client";

import Link from "next/link";
import { useState } from "react";
import { Brain as BrainIcon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Brain } from "@/hooks/use-brain";

/**
 * Switches which brain every /brain page reads.
 *
 * The choice lives in lib/brain/active-brain (localStorage + an external store),
 * so it survives navigation and stays in sync across tabs rather than resetting
 * on each mount.
 */
export function BrainSelector({
  brain,
  brains,
  onSelect,
}: {
  brain: Brain | undefined;
  brains: Brain[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!brain) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-xl border border-border/60 bg-surface px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent/30 hover:bg-surface-hover"
      >
        <BrainIcon className="h-4 w-4 text-accent-ink" aria-hidden="true" />
        <span className="max-w-[12rem] truncate">{brain.name}</span>
        {brain.status === "archived" && (
          <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning-ink">
            archived
          </span>
        )}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <ul
            role="listbox"
            aria-label="Choose a brain"
            className="absolute left-0 z-20 mt-2 w-72 overflow-hidden rounded-xl border border-border/50 bg-surface-elevated p-1 shadow-2xl shadow-black/20"
          >
            {brains.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === brain.id}
                  onClick={() => {
                    onSelect(option.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/5",
                    option.id === brain.id && "bg-accent/10"
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {option.name}
                    {option.isDefault && (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent-ink">
                        default
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </button>
              </li>
            ))}
            <li className="mt-1 border-t border-border/40 pt-1">
              <Link
                href="/brain/settings"
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/5 hover:text-foreground"
              >
                Manage brains
              </Link>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
