import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40 select-none",
  {
    variants: {
      variant: {
        default:
          "bg-accent text-on-accent shadow-md shadow-accent/15 hover:bg-accent-dark hover:shadow-lg hover:shadow-accent/25 active:scale-[0.98]",
        secondary:
          "bg-surface border border-border/60 text-foreground hover:bg-surface-hover hover:border-accent/30 active:scale-[0.98]",
        ghost:
          "text-muted-foreground hover:text-foreground hover:bg-accent/5 active:scale-[0.98]",
        destructive:
          "bg-danger/10 text-danger-ink border border-danger/20 hover:bg-danger/20 active:scale-[0.98]",
        outline:
          "border border-accent/30 text-accent-ink hover:bg-accent/5 active:scale-[0.98]",
      },
      size: {
        default: "h-10 px-4 py-2 rounded-xl",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-11 rounded-xl px-6 text-base",
        icon: "h-9 w-9 rounded-xl",
        "icon-sm": "h-7 w-7 rounded-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";
