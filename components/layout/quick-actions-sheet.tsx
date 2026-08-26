"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Upload, FileText, FolderPlus, X } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import { emitQuickAction, type QuickAction } from "@/lib/system/quick-actions";

interface QuickActionsSheetProps {
  open: boolean;
  onClose: () => void;
}

const ACTIONS: { key: QuickAction; label: string; desc: string; icon: typeof Upload }[] = [
  { key: "upload", label: "Upload files", desc: "Pick files from this device", icon: Upload },
  { key: "note", label: "New note", desc: "Write something down quickly", icon: FileText },
  { key: "folder", label: "New folder", desc: "Create an empty folder", icon: FolderPlus },
];

/** Only the sheet's own controls — the focus trap collects by this, not by tag. */
const SHEET_FOCUSABLE = "[data-sheet-focusable]:not([disabled])";

/**
 * Bottom action sheet for the mobile "+" tab. Each action delegates to the
 * FileBrowser's existing handlers via a window event; if we're not on /files
 * yet, navigate there first and fire the event on the next tick so the freshly
 * mounted browser can catch it.
 */
export function QuickActionsSheet({ open, onClose }: QuickActionsSheetProps) {
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  /*
   * Escape, initial focus and focus restore — the three things `role="dialog"` promises
   * and this sheet did not deliver. It could only be dismissed by tapping the scrim, and
   * focus stayed on the "+" button behind it, so the first Tab went into the page
   * underneath instead of into the sheet.
   */
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>(SHEET_FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Back to the "+" that opened it. The bottom bar outlives a route change, so
      // this still lands somewhere real when an action navigated to /files.
      restoreTo.current?.focus();
    };
  }, [open, onClose]);

  /** Keep Tab inside the sheet: `aria-modal` tells a screen reader the rest is inert,
   *  but it does nothing to the tab order. */
  function trapTab(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const nodes = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE) ?? []
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function run(action: QuickAction) {
    onClose();
    if (pathname === "/files") {
      emitQuickAction(action);
    } else {
      router.push("/files");
      // Give the FileBrowser a moment to mount its listener before firing.
      setTimeout(() => emitQuickAction(action), 350);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            /* The dialog tier (80 in the LAYER scale, components/ui/modal.tsx). It used
               to sit at 60/61, which is the downloads-widget tier — the Activity Center
               at 70 drew straight over the top of it. */
            className="scrim fixed inset-0 z-[80] lg:hidden"
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            initial={reduceMotion ? { opacity: 0 } : { y: "100%" }}
            animate={reduceMotion ? { opacity: 1 } : { y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { y: "100%" }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", damping: 34, stiffness: 320 }
            }
            className="chrome-surface fixed inset-x-0 bottom-0 z-[81] rounded-t-3xl border-t border-border/60 pb-safe lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={trapTab}
          >
            {/* Grabber */}
            <div className="flex justify-center pt-3 pb-1">
              <span aria-hidden className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
            </div>
            <div className="flex items-center justify-between px-4 pb-2 pt-1">
              <h2 id={titleId} className="px-1 text-sm font-semibold">
                Create new
              </h2>
              <button
                type="button"
                data-sheet-focusable
                onClick={onClose}
                // 44px: a 32px target is below what a fingertip hits reliably.
                className="tap flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40"
                aria-label="Close"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            <div className="px-3 pb-4">
              {ACTIONS.map(({ key, label, desc, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  data-sheet-focusable
                  onClick={() => run(key)}
                  className="tap flex w-full items-center gap-3.5 rounded-2xl px-3 py-3 text-left hover:bg-muted/40"
                >
                  <span
                    aria-hidden
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-muted-foreground/70">{desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
