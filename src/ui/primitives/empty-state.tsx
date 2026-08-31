import { cn } from "@/shared/lib/utils";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16 text-center", className)}>
      <div className="relative mb-5">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-border/40 bg-gradient-to-br from-surface to-muted/30 shadow-sm">
          <Icon className="h-9 w-9 text-muted-foreground/20" />
        </div>
      </div>
      <div className="max-w-sm">
        <p className="font-medium text-foreground/80">{title}</p>
        {description && (
          <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
