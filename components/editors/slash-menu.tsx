"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
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
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => setSelected(0), [items]);

    // The menu is 320px tall and the block list is longer than that, so arrowing down
    // used to move the highlight to an item nobody could see.
    useEffect(() => {
      const node = listRef.current?.querySelectorAll<HTMLElement>("[data-slash-item]")[selected];
      node?.scrollIntoView({ block: "nearest" });
    }, [selected]);

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
          <p className="px-3 py-2 text-xs text-muted-foreground">No matching block</p>
        </div>
      );
    }

    return (
      <div className="note-slash-menu" ref={listRef}>
        <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-widest text-accent-ink">
          Blocks
        </p>
        {items.map((item, i) => {
          const Icon = ICONS[item.icon];
          const active = i === selected;
          return (
            <button
              key={item.title}
              type="button"
              data-slash-item
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => { e.preventDefault(); command(item); }}
              className={cn("note-slash-item", active && "note-slash-item--active")}
            >
              <span className={cn("note-slash-icon", active && "note-slash-icon--active")}>
                <Icon aria-hidden className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-tight text-foreground">
                  {item.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{item.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }
);
