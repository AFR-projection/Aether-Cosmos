"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import type { Editor, Range } from "@tiptap/core";
import {
  Type, Heading1, Heading2, Heading3, List, ListOrdered,
  ListChecks, Quote, Code2, Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS = {
  Type, Heading1, Heading2, Heading3, List, ListOrdered,
  ListChecks, Quote, Code2, Minus,
} as const;

export type SlashItem = {
  title: string;
  desc: string;
  icon: keyof typeof ICONS;
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
};

export type SlashMenuRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type SlashMenuProps = {
  items: SlashItem[];
  command: (item: SlashItem) => void;
};

export const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(
  function SlashMenu({ items, command }, ref) {
    const [selected, setSelected] = useState(0);

    useEffect(() => setSelected(0), [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowUp") {
          setSelected((s) => (s + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="note-slash-menu">
          <p className="px-3 py-2 text-xs" style={{ color: "var(--muted-foreground)" }}>
            Tidak ada blok yang cocok
          </p>
        </div>
      );
    }

    return (
      <div className="note-slash-menu">
        <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: "var(--accent)" }}>
          Blok
        </p>
        {items.map((item, i) => {
          const Icon = ICONS[item.icon];
          const active = i === selected;
          return (
            <button
              key={item.title}
              type="button"
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => { e.preventDefault(); command(item); }}
              className={cn("note-slash-item", active && "note-slash-item--active")}
            >
              <span className={cn("note-slash-icon", active && "note-slash-icon--active")}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-tight" style={{ color: "var(--foreground)" }}>
                  {item.title}
                </span>
                <span className="block truncate text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                  {item.desc}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }
);
