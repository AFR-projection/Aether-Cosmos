"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Crosshair, EyeOff, ExternalLink, GitFork, Link2 } from "lucide-react";
import { memoryHref } from "@/lib/brain/graph/links";
import type { GraphModel } from "@/lib/brain/graph/types";
import { cn } from "@/lib/utils";

/**
 * Right-click menu for one node.
 *
 * Portalled to the body and positioned in viewport coordinates, so it is never
 * clipped by the canvas box or by the sidebar's transform. The item list is built
 * from the node itself: "Open memory" only exists for a memory, because entities
 * have no page in this app and a row that greys out or does nothing would be a lie.
 *
 * Keyboard: the menu takes focus on open, arrows move, Enter activates, Escape
 * closes and returns focus to the canvas — the same contract as a native menu.
 */

export type GraphContextMenuAction =
  | "open-note"
  | "open-local"
  | "focus"
  | "copy-link"
  | "hide";

export type GraphContextMenuProps = {
  model: GraphModel;
  modelIndex: number;
  x: number;
  y: number;
  /** True when this node is already the local graph's centre. */
  isFocal: boolean;
  onAction: (action: GraphContextMenuAction, modelIndex: number) => void;
  onClose: () => void;
};

type Item = {
  action: GraphContextMenuAction;
  icon: typeof ExternalLink;
  label: string;
  danger?: boolean;
};

const MENU_WIDTH = 196;
/** Rough height per row plus the header, used only to decide flip direction. */
const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 46;
const EDGE_GAP = 8;

export function GraphContextMenu({
  model,
  modelIndex,
  x,
  y,
  isFocal,
  onAction,
  onClose,
}: GraphContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    // A resize or a window switch moves the anchor out from under the menu, and a
    // stale menu floating over the graph is worse than a closed one.
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const node = model.nodes[modelIndex];
  if (!node) return null;

  const items: Item[] = [];
  if (memoryHref(node)) {
    items.push({ action: "open-note", icon: ExternalLink, label: "Open memory" });
  }
  items.push({
    action: "open-local",
    icon: GitFork,
    label: isFocal ? "Refit local graph" : "Local graph from here",
  });
  items.push({ action: "focus", icon: Crosshair, label: "Centre on node" });
  items.push({ action: "copy-link", icon: Link2, label: "Copy link" });
  items.push({ action: "hide", icon: EyeOff, label: "Hide node", danger: true });

  const run = (index: number) => {
    const item = items[index];
    if (!item) return;
    onAction(item.action, modelIndex);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "Escape":
      case "Tab":
        onClose();
        break;
      case "ArrowDown":
        setActive((index) => (index + 1) % items.length);
        break;
      case "ArrowUp":
        setActive((index) => (index - 1 + items.length) % items.length);
        break;
      case "Home":
        setActive(0);
        break;
      case "End":
        setActive(items.length - 1);
        break;
      case "Enter":
      case " ":
        run(active);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // Flip rather than overflow: a menu opened near the right or bottom edge stays
  // fully on screen instead of pushing a scrollbar onto the page.
  const height = HEADER_HEIGHT + items.length * ROW_HEIGHT;
  const viewportWidth = typeof window === "undefined" ? MENU_WIDTH : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? height : window.innerHeight;
  const left = Math.max(
    EDGE_GAP,
    x + MENU_WIDTH + EDGE_GAP > viewportWidth ? x - MENU_WIDTH : x
  );
  const top = Math.max(
    EDGE_GAP,
    y + height + EDGE_GAP > viewportHeight ? y - height : y
  );

  if (typeof document === "undefined") return null;

  // While the graph is fullscreen only the fullscreen element paints, so a menu
  // portalled to the body would be mounted but invisible. Positioning is viewport
  // fixed either way, so the host swap costs nothing.
  const host = document.fullscreenElement ?? document.body;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={`Actions for ${node.label}`}
      aria-activedescendant={`graph-menu-item-${active}`}
      onKeyDown={onKeyDown}
      style={{ position: "fixed", left, top, width: MENU_WIDTH, zIndex: 60 }}
      className="overflow-hidden rounded-xl border border-border/60 bg-surface-elevated shadow-lg outline-none"
    >
      <div className="border-b border-border/40 px-3 py-2">
        <p className="truncate text-xs font-medium text-foreground" title={node.label}>
          {node.label}
        </p>
        <p className="truncate text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          {node.kind} · {node.type}
        </p>
      </div>
      <div className="py-1">
        {items.map((item, index) => (
          <button
            key={item.action}
            id={`graph-menu-item-${index}`}
            role="menuitem"
            type="button"
            tabIndex={-1}
            onMouseEnter={() => setActive(index)}
            onClick={() => run(index)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors",
              item.danger ? "text-danger" : "text-foreground",
              index === active &&
                (item.danger ? "bg-danger/10" : "bg-accent/10 text-accent")
            )}
          >
            <item.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    host
  );
}
