"use client";

import * as React from "react";
import { AlertTriangle, Download, RefreshCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/system/spinner";
import { cn } from "@/lib/utils";

/* Every viewer shares this chrome so a spreadsheet, an archive and a video all
   report their name, their state and their download the same way. */

const TONE = {
  neutral: "text-muted-foreground",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
} as const;

export type ViewerTone = keyof typeof TONE;

interface ViewerBarProps {
  icon: LucideIcon;
  fileName: string;
  tone?: ViewerTone;
  /** Badges or counts describing the content (sheet count, rows, pages). */
  meta?: React.ReactNode;
  /** Icon buttons, right aligned. */
  children?: React.ReactNode;
  className?: string;
}

export function ViewerBar({
  icon: Icon,
  fileName,
  tone = "neutral",
  meta,
  children,
  className,
}: ViewerBarProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-border/40 bg-surface/70 px-4 py-2",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-4 w-4 shrink-0", TONE[tone])} aria-hidden="true" />
        <span className="truncate text-xs font-medium text-foreground" title={fileName}>
          {fileName}
        </span>
        {meta}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/** Download affordance shared by every viewer bar. */
export function ViewerDownloadButton({ onDownload }: { onDownload: () => void }) {
  return (
    <Button variant="ghost" size="icon" aria-label="Download file" onClick={onDownload}>
      <Download className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}

export function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-3">
        <Spinner size="lg" />
        <p role="status" className="text-xs text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  );
}

interface ViewerMessageProps {
  icon?: LucideIcon;
  title: string;
  /** The cause, in one line. Empty states must say why they are empty. */
  hint?: string;
  tone?: ViewerTone;
  onRetry?: () => void;
  onDownload?: () => void;
}

/** Error and empty states: cause first, then the one action that resolves it. */
export function ViewerMessage({
  icon: Icon = AlertTriangle,
  title,
  hint,
  tone = "neutral",
  onRetry,
  onDownload,
}: ViewerMessageProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
      <span
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-2xl bg-muted",
          TONE[tone]
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {hint && <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {(onRetry || onDownload) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          )}
          {onDownload && (
            <Button size="sm" onClick={onDownload}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * True when a keystroke belongs to something the user is typing into. Media
 * viewers bind bare keys (space, arrows, m, f) on the window, which would
 * otherwise hijack every search box and rename field on the page.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}
