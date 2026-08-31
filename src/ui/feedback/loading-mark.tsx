"use client";

import { cn } from "@/shared/lib/utils";

type LoadingMarkProps = {
  label?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
};

/**
 * Branded full-view loader: a breathing glow halo behind a conic dual-ring, an
 * orbiting spark, and a pulsing core. Pure CSS (transform/opacity), no Lottie /
 * SVG animation — stays light even full-screen. Respects reduced-motion.
 */
export function LoadingMark({
  label = "Loading…",
  className,
  size = "md",
}: LoadingMarkProps) {
  const dim =
    size === "sm" ? "h-8 w-8" : size === "lg" ? "h-14 w-14" : "h-10 w-10";
  const thickness = size === "sm" ? "2px" : size === "lg" ? "3.5px" : "2.5px";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3.5 text-muted-foreground",
        className
      )}
      role="status"
      aria-live="polite"
      // Every visual part of this loader is aria-hidden, so with `label=""` the
      // live region would announce nothing at all.
      aria-label={label || "Loading"}
    >
      <div className={cn("relative grid place-items-center", dim)}>
        {/* Breathing glow halo */}
        <span
          className="loading-halo absolute inset-[-30%] rounded-full blur-md"
          style={{
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--accent) 45%, transparent) 0%, transparent 68%)",
          }}
          aria-hidden
        />
        {/* Conic dual-ring */}
        <span
          className={cn("spinner-ring absolute inset-0")}
          style={{ ["--spinner-thickness" as string]: thickness }}
          aria-hidden
        />
        {/* Orbiting spark */}
        <span className="loading-orbit-spin absolute inset-0" aria-hidden>
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_10px_2px_var(--accent)]" />
        </span>
        {/* Pulsing core */}
        <span className="loading-core h-1/3 w-1/3 rounded-full bg-accent/80 shadow-[0_0_10px_var(--accent)]" aria-hidden />
      </div>
      {label && (
        <p className="text-sm font-medium tracking-wide">
          <span className="loading-text-shimmer">{label}</span>
        </p>
      )}
    </div>
  );
}
