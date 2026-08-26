import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* Tones map to semantic tokens only. A badge is often the only thing carrying
   a state, so it always pairs its tone with text — never colour alone. */
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-md border font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        accent: "border-accent/25 bg-accent/10 text-accent",
        success: "border-success/25 bg-success/10 text-success",
        warning: "border-warning/25 bg-warning/10 text-warning",
        danger: "border-danger/25 bg-danger/10 text-danger",
        info: "border-info/25 bg-info/10 text-info",
      },
      /* Both sizes sit at the 12px floor — the step between them is padding, not
         type size, so a badge never shrinks its label below what the rest of the
         UI uses. */
      size: {
        sm: "px-1.5 py-0.5 text-xs",
        md: "px-2 py-1 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "sm" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size, className }))} {...props} />;
}
