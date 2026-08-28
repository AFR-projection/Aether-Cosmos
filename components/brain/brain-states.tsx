"use client";

import type { LucideIcon } from "lucide-react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Skeleton rows for a brain list while its query is in flight. */
export function BrainLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="brain-surface h-20 overflow-hidden">
          <span className="skeleton block h-full w-full rounded-[1.35rem]" />
        </div>
      ))}
    </div>
  );
}

export function BrainErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-[1.35rem] border border-danger/25 bg-danger/5 p-6 text-sm text-foreground"
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="h-4 w-4 shrink-0 text-danger-ink" aria-hidden="true" />
        {message}
      </p>
      {onRetry && (
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}

/** Section card used across the brain pages so panels stay visually identical. */
export function BrainPanel({
  icon: Icon,
  title,
  action,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("brain-surface p-5", className)}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10">
            <Icon className="h-3.5 w-3.5 text-accent-ink" aria-hidden="true" />
          </span>
          <span className="truncate">{title}</span>
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
