"use client";

import { cn } from "@/shared/lib/utils";

/**
 * A labelled range input. Native `<input type="range">` on purpose: the UI kit has
 * no Slider primitive, and a native range is keyboard- and screen-reader-accessible
 * for free — which matters more here than a custom thumb.
 */
export function GraphSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  className,
}: {
  /**
   * Explicit and locale-independent. Deriving it from the label used to work in
   * English only: `label.toLowerCase().replace(/[^a-z0-9]+/g, "-")` collapses a
   * Chinese or any non-ASCII label to the same empty stem, so every slider on the
   * panel ended up sharing one id and each `<label for>` pointed at the first one.
   */
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-accent"
      />
    </div>
  );
}
