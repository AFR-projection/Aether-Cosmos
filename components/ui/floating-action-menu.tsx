"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export type FloatingMenuItem = {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  danger?: boolean;
  shortcut?: string;
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

const MENU_MIN_W = 188;
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
    const frame = requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, ready]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
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
      {open && (
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
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: ready ? 1 : 0, scale: ready ? 1 : 0.96, y: ready ? 0 : 6 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              visibility: ready ? "visible" : "hidden",
            }}
            className="z-[100] max-h-[calc(100dvh-16px)] w-[min(calc(100vw-16px),240px)] overflow-y-auto rounded-xl border border-border/60 bg-surface-elevated/95 py-1 shadow-2xl backdrop-blur-xl overscroll-contain"
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
              <div className="border-b border-border/40 px-3.5 pb-2.5 pt-2">
                <p className="truncate text-[12px] font-semibold text-foreground">{header.title}</p>
                {header.subtitle && <p className="mt-0.5 truncate text-[10px] text-muted-foreground/65">{header.subtitle}</p>}
              </div>
            )}
            {items.map((item, i) => {
              const Icon = item.icon;
              const showDivider = item.danger && i > 0 && !items[i - 1]?.danger;

              return (
                <div key={item.id}>
                  {showDivider && <div className="my-1 mx-2 border-t border-border/40" />}
                  <button
                    ref={(element) => { itemRefs.current[i] = element; }}
                    role="menuitem"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      item.onClick();
                      onClose();
                    }}
                    className={cn(
                      "flex min-h-10 w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] font-medium transition-colors focus-visible:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                      item.danger
                        ? "text-danger hover:bg-danger/10"
                        : "text-foreground hover:bg-accent/10"
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", item.danger ? "opacity-90" : "opacity-60")} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.shortcut && <kbd className="ml-2 shrink-0 text-[10px] font-medium text-muted-foreground/50">{item.shortcut}</kbd>}
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
