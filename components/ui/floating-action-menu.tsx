"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type FloatingMenuItem = {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  shortcut?: string;
  /**
   * Present when the item is one of a set of mutually exclusive choices — e.g. the
   * sort field. Renders a tick and reports the state as `menuitemradio`, so the
   * current choice is announced rather than only coloured.
   */
  checked?: boolean;
  /** Starts a new group. Danger items already get one automatically. */
  separatorBefore?: boolean;
  onClick: () => void;
};

type FloatingActionMenuProps = {
  open: boolean;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  /** Viewport coordinates used by context menus. This avoids transformed or virtualized parents. */
  anchorPoint?: { x: number; y: number } | null;
  items: FloatingMenuItem[];
  align?: "start" | "end" | "center";
  placement?: "anchor" | "context";
  menuLabel?: string;
  header?: { title: string; subtitle?: string };
};

/** Matches the panel's own `w-[min(calc(100vw-16px),240px)]` — used only as the
 *  first estimate on the frame before the menu can be measured. */
const MENU_MIN_W = 240;
const ITEM_H = 40;
const PAD = 8;
const GAP = 6;

function computePosition(
  anchor: DOMRect,
  menuW: number,
  menuH: number,
  align: "start" | "end" | "center"
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = anchor.top - menuH - GAP;
  if (top < PAD) {
    top = anchor.bottom + GAP;
  }
  if (top + menuH > vh - PAD) {
    top = Math.max(PAD, anchor.top - menuH - GAP);
  }

  let left: number;
  if (align === "start") left = anchor.left;
  else if (align === "center") left = anchor.left + anchor.width / 2 - menuW / 2;
  else left = anchor.right - menuW;

  if (left + menuW > vw - PAD) left = vw - menuW - PAD;
  if (left < PAD) left = PAD;

  return { top, left };
}

function computeContextPosition(point: { x: number; y: number }, menuW: number, menuH: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitsRight = point.x + GAP + menuW <= vw - PAD;
  const fitsBelow = point.y + GAP + menuH <= vh - PAD;

  const left = fitsRight ? point.x + GAP : point.x - menuW - GAP;
  const top = fitsBelow ? point.y + GAP : point.y - menuH - GAP;

  return {
    top: Math.min(Math.max(PAD, top), Math.max(PAD, vh - menuH - PAD)),
    left: Math.min(Math.max(PAD, left), Math.max(PAD, vw - menuW - PAD)),
  };
}

export function FloatingActionMenu({
  open,
  onClose,
  anchorRef,
  anchorPoint = null,
  items,
  align = "end",
  placement = "anchor",
  menuLabel = "Actions",
  header,
}: FloatingActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [coords, setCoords] = useState({ top: -9999, left: -9999 });
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open || (placement === "anchor" && !anchorRef?.current) || (placement === "context" && !anchorPoint)) {
      setReady(false);
      return;
    }

    const menuEl = menuRef.current;
    const menuW = menuEl?.offsetWidth ?? MENU_MIN_W;
    const menuH = menuEl?.offsetHeight ?? items.length * ITEM_H + (header ? 58 : 8);

    if (placement === "context" && anchorPoint) {
      setCoords(computeContextPosition(anchorPoint, menuW, menuH));
    } else if (anchorRef?.current) {
      setCoords(computePosition(anchorRef.current.getBoundingClientRect(), menuW, menuH, align));
    }
    setReady(true);
  }, [open, anchorRef, anchorPoint, items, align, placement, header]);

  useEffect(() => {
    if (!open || !ready) return;
    // Remember what opened the menu so focus can go back there on close —
    // otherwise Tab resumes from the top of the document once the menu unmounts.
    const opener = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => {
      cancelAnimationFrame(frame);
      // Only reclaim focus if nothing else has taken it. An item that opened a
      // dialog has already moved focus somewhere better, and the menu's own
      // button is gone by now, so `body` is the tell that focus was orphaned.
      const active = document.activeElement;
      if (!active || active === document.body) opener?.focus();
    };
  }, [open, ready]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Tab would otherwise leave the menu open behind the focus ring.
      if (e.key === "Escape" || e.key === "Tab") onClose();
    };
    // Capture-phase, so a scrolling ancestor closes the menu instead of leaving
    // it stranded next to nothing — but the menu's own overflow scroll is not
    // the page moving underneath it.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {/* An empty `items` is a real case — a trashed file offers nothing to a
          viewer who cannot purge — and a 240px panel with no rows in it reads
          as a broken menu rather than as "no actions here". */}
      {open && items.length > 0 && (
        <>
          <div
            className="fixed inset-0 z-[90]"
            onClick={onClose}
            onContextMenu={(e) => {
              e.preventDefault();
              onClose();
            }}
            aria-hidden
          />
          <motion.div
            ref={menuRef}
            role="menu"
            aria-label={menuLabel}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
            animate={
              reduceMotion
                ? { opacity: ready ? 1 : 0 }
                : { opacity: ready ? 1 : 0, scale: ready ? 1 : 0.96, y: ready ? 0 : 6 }
            }
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              visibility: ready ? "visible" : "hidden",
            }}
            className="z-[90] max-h-[calc(100dvh-16px)] w-[min(calc(100vw-16px),240px)] overflow-y-auto rounded-xl border border-border/60 bg-surface-elevated/95 py-1 shadow-2xl backdrop-blur-xl overscroll-contain"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
              }

              const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
              if (current < 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const next = e.key === "ArrowDown"
                ? (current + 1) % items.length
                : e.key === "ArrowUp"
                  ? (current - 1 + items.length) % items.length
                  : e.key === "Home" ? 0 : items.length - 1;
              itemRefs.current[next]?.focus();
            }}
          >
            {header && (
              /* role="none" keeps the menu's ownership of its items intact — a
                 plain div between `role="menu"` and its `menuitem`s breaks it. */
              <div role="none" className="border-b border-border/40 px-3.5 pb-2.5 pt-2">
                <p className="truncate text-xs font-semibold text-foreground">{header.title}</p>
                {header.subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{header.subtitle}</p>}
              </div>
            )}
            {items.map((item, i) => {
              const Icon = item.icon;
              const showDivider =
                item.separatorBefore || (item.danger && i > 0 && !items[i - 1]?.danger);

              return (
                <div role="none" key={item.id}>
                  {showDivider && i > 0 && <div role="separator" className="my-1 mx-2 border-t border-border/40" />}
                  <button
                    ref={(element) => { itemRefs.current[i] = element; }}
                    role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                    aria-checked={item.checked === undefined ? undefined : item.checked}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      item.onClick();
                      onClose();
                    }}
                    className={cn(
                      "flex min-h-10 w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors focus-visible:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                      item.danger
                        ? "text-danger hover:bg-danger/10"
                        : item.checked
                          ? "text-accent hover:bg-accent/10"
                          : "text-foreground hover:bg-accent/10"
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", item.danger ? "opacity-90" : "opacity-60")} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.shortcut && <kbd className="ml-2 shrink-0 text-xs font-medium text-muted-foreground">{item.shortcut}</kbd>}
                    {item.checked && <Check aria-hidden className="ml-1 h-3.5 w-3.5 shrink-0" />}
                  </button>
                </div>
              );
            })}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

export function useFloatingMenu() {
  const [openId, setOpenId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return {
    openId,
    setOpenId,
    anchorRef,
    isOpen: (id: string) => openId === id,
    toggle: (id: string) => setOpenId((prev) => (prev === id ? null : id)),
    close: () => setOpenId(null),
  };
}
