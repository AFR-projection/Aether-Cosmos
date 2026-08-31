import * as React from "react";
import { cn } from "@/shared/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        // 16px on mobile (text-base) prevents iOS Safari from auto-zooming the
        // page on focus; drop to 14px (text-sm) from sm+ where that's not a risk.
        "flex h-10 w-full rounded-xl border border-border/60 bg-surface px-3 py-2 text-base sm:text-sm text-foreground placeholder:text-muted-foreground/50 transition-all duration-200",
        "focus-visible:outline-none focus-visible:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/15",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = "Input";