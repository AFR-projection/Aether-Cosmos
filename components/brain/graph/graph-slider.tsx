"use client";

import { cn } from "@/lib/utils";

/**
 * A labelled range input. Native `<input type="range">` on purpose: the UI kit has
 * no Slider primitive, and a native range is keyboard- and screen-reader-accessible
 * for free — which matters more here than a custom thumb.
 */
export function GraphSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  className?: string;
}) {
  const id = `graph-slider-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
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
