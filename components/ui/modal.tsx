"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Layer scale ───────────────────────────────────────────────────────────
   One place decides what floats above what. Every value below is already in
   use somewhere in the app; naming them stops the next dialog from inventing
   a number and landing under the thing it was supposed to cover.

     30   page chrome (sidebar rail, sticky headers)
     40   mobile bottom nav / drawer scrim
     50   full-screen surfaces (file preview, upload panel)
     60   floating progress (downloads widget)
     70   the draggable Activity Center window (non-modal)
     80   dialogs                          ← Modal, level="base"
     85   a dialog opened from a dialog    ← Modal, level="nested"
     90   floating menus (must clear both dialog levels)
    100   command palette
    120   toasts, connection-status pill
    130   route progress bar (a 2px strip; nothing should hide it)
    200   offline overlay

   Dialogs deliberately sit below menus: a row menu opened inside a dialog has
   to paint over the panel that owns it. */
const LAYER = { base: "z-[80]", nested: "z-[85]" } as const;

const SIZE = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
} as const;

const TONE = {
  neutral: "bg-muted text-muted-foreground",
  accent: "bg-accent/10 text-accent-ink",
  success: "bg-success/10 text-success-ink",
  warning: "bg-warning/10 text-warning-ink",
  danger: "bg-danger/10 text-danger-ink",
} as const;

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/* Nested dialogs share one scroll lock: the innermost one closing must not
   hand scrolling back while its parent is still up. */
let scrollLocks = 0;
let restoreOverflow = "";

function lockBodyScroll() {
  if (scrollLocks === 0) {
    restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
}

function unlockBodyScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = restoreOverflow;
}

/* Escape belongs to the topmost dialog only, otherwise one keypress closes the
   whole stack. */
const openStack: string[] = [];

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Read out as the dialog's accessible name. Required — never omit it. */
  title: string;
  /** Optional sub-line under the title; also becomes aria-describedby. */
  description?: React.ReactNode;
  icon?: LucideIcon;
  tone?: keyof typeof TONE;
  size?: keyof typeof SIZE;
  level?: keyof typeof LAYER;
  /** false while a request is in flight: no scrim click, no Escape, no ✕. */
  dismissible?: boolean;
  footer?: React.ReactNode;
  /** Focused on open instead of the first focusable node. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  bodyClassName?: string;
  /** Omit for a confirm-style dialog whose whole message is the description. */
  children?: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = "accent",
  size = "md",
  level = "base",
  dismissible = true,
  footer,
  initialFocusRef,
  className,
  bodyClassName,
  children,
}: ModalProps) {
  const uid = React.useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  // Stack registration, scroll lock and focus restore share one lifetime.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    openStack.push(uid);
    lockBodyScroll();
    return () => {
      const at = openStack.lastIndexOf(uid);
      if (at >= 0) openStack.splice(at, 1);
      unlockBodyScroll();
      // Send focus back where it came from so the keyboard user does not
      // restart at the top of the page.
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open, uid]);

  React.useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, initialFocusRef]);

  React.useEffect(() => {
    if (!open || !dismissible) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (openStack[openStack.length - 1] !== uid) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, dismissible, onClose, uid]);

  function trapTab(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn("scrim fixed inset-0 flex items-center justify-center p-4", LAYER[level])}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          onMouseDown={(event) => {
            if (dismissible && event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            onKeyDown={trapTab}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "flex max-h-[min(90dvh,44rem)] w-full flex-col overflow-hidden rounded-2xl",
              "border border-border bg-surface-elevated shadow-xl",
              SIZE[size],
              className
            )}
          >
            <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
              {Icon && (
                <span
                  className={cn(
                    "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    TONE[tone]
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-sm font-semibold leading-tight text-foreground">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                )}
              </div>
              {dismissible && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close dialog"
                  className={cn(
                    "-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    "text-muted-foreground transition-colors duration-150",
                    "hover:bg-surface-hover hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  )}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {children && (
              <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>
                {children}
              </div>
            )}

            {footer && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-background/40 px-5 py-3">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
