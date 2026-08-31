"use client";

import { cn } from "@/shared/lib/utils";

type SpinnerSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<SpinnerSize, { box: string; thickness: string }> = {
  xs: { box: "h-3.5 w-3.5", thickness: "1.5px" },
  sm: { box: "h-5 w-5", thickness: "2px" },
  md: { box: "h-8 w-8", thickness: "2.5px" },
  lg: { box: "h-12 w-12", thickness: "3.5px" },
};

/**
 * Lightweight dual-ring conic spinner. Pure CSS (transform/opacity only, one
 * masked element — no SVG, no JS ticker), so it's cheap to render many of.
 * Colour follows `--accent`; override via `style={{ ['--accent']: ... }}` or a
 * wrapping `text-*` when using `currentColor` variants.
 */
export function Spinner({
  size = "md",
  className,
  style,
}: {
  size?: SpinnerSize;
  className?: string;
  style?: React.CSSProperties;
}) {
  const s = SIZES[size];
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("spinner-ring inline-block", s.box, className)}
      style={{ ["--spinner-thickness" as string]: s.thickness, ...style }}
    />
  );
}
