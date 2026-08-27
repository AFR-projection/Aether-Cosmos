"use client";

import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import type { Editor, Range } from "@tiptap/core";
import { SlashMenu, type SlashItem, type SlashMenuRef } from "./slash-menu";

/**
 * Notion-style "/" slash command. Typing "/" opens a filterable block menu;
 * picking an item runs the matching editor command. Built on Tiptap's Suggestion
 * utility + a React-rendered popup positioned at the caret. No tippy/popper
 * dependency — a lightweight fixed-position wrapper keeps the bundle small.
 */

/* Descriptions are shown to the author, so they follow the rest of the app's copy. The
   keywords are invisible search aliases, kept in English for the same reason: one
   language throughout, so there is no second spelling to remember or maintain. */
export const SLASH_ITEMS: SlashItem[] = [
  { title: "Text", desc: "Plain paragraph", icon: "Type", keywords: ["paragraph", "text", "body"],
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { title: "Heading 1", desc: "Large section title", icon: "Heading1", keywords: ["h1", "title", "heading"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 1 }).run() },
  { title: "Heading 2", desc: "Subsection title", icon: "Heading2", keywords: ["h2", "subheading", "heading"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run() },
  { title: "Heading 3", desc: "Smallest title", icon: "Heading3", keywords: ["h3", "heading"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run() },
  { title: "Bullet List", desc: "Unordered list", icon: "List", keywords: ["ul", "bullet", "list", "unordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: "Numbered List", desc: "Ordered list", icon: "ListOrdered", keywords: ["ol", "number", "numbered", "ordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: "To-do List", desc: "Task checklist", icon: "ListChecks", keywords: ["todo", "task", "check", "checklist"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: "Quote", desc: "Quoted passage", icon: "Quote", keywords: ["blockquote", "quote", "citation"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: "Code Block", desc: "Preformatted code", icon: "Code2", keywords: ["code", "snippet", "pre"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: "Divider", desc: "Horizontal rule", icon: "Minus", keywords: ["hr", "divider", "rule", "separator"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.includes(q))
  );
}

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          props.run(editor, range);
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }) => filterItems(query),
        render: () => {
          let component: ReactRenderer<SlashMenuRef> | null = null;
          let wrapper: HTMLDivElement | null = null;
          let raf = 0;
          let dismissed = false;

          const teardown = () => {
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            wrapper?.remove();
            component?.destroy();
            wrapper = null;
            component = null;
          };

          const position = (rect: DOMRect | null) => {
            if (!wrapper || !rect) return;
            /* Fixed to the viewport. The menu is measured rather than assumed: the old
               version treated it as always 320px tall (its max-height) so a short filtered
               list flipped above the caret while there was still room below, and it never
               clamped `left`, so typing "/" near the right edge — or anywhere on a phone —
               put the menu partly off-screen. Falls back to the CSS box while React is
               still painting the first frame. */
            const menu = wrapper.firstElementChild as HTMLElement | null;
            const menuH = menu?.offsetHeight || 320;
            const menuW = menu?.offsetWidth || 252;
            const gap = 6;
            const edge = 8;
            const fitsBelow = rect.bottom + gap + menuH <= window.innerHeight - edge;
            const top = fitsBelow
              ? rect.bottom + gap
              : Math.max(edge, rect.top - gap - menuH);
            wrapper.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - menuW - edge))}px`;
            wrapper.style.top = `${top}px`;
          };

          return {
            onStart: (props) => {
              dismissed = false;
              component = new ReactRenderer(SlashMenu, {
                props,
                editor: props.editor,
              });
              wrapper = document.createElement("div");
              wrapper.style.position = "fixed";
              // 90 is the floating-menu tier in the LAYER scale (components/ui/modal.tsx),
              // the same one the note editor's export menu uses. It used to sit at 80,
              // which is the dialog tier.
              wrapper.style.zIndex = "90";
              wrapper.appendChild(component.element);
              document.body.appendChild(wrapper);
              position(props.clientRect?.() ?? null);
              // React has not painted the menu yet, so the first pass positions a
              // zero-height box. Measure again on the next frame.
              raf = requestAnimationFrame(() => {
                raf = 0;
                position(props.clientRect?.() ?? null);
              });
            },
            onUpdate: (props) => {
              if (dismissed) return;
              component?.updateProps(props);
              position(props.clientRect?.() ?? null);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                /* Escape only takes the menu away: the suggestion itself stays active as
                   long as the caret sits after the "/", so from here on every key has to
                   fall through to the editor. Without the flag the torn-down menu still
                   owned Enter, and pressing it for a new line applied whichever block was
                   highlighted when the menu was dismissed. */
                dismissed = true;
                teardown();
                return true;
              }
              if (dismissed) return false;
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              teardown();
              // render() runs once per editor, so this closure outlives a single "/" —
              // the next one starts with the menu allowed again.
              dismissed = false;
            },
          };
        },
      }),
    ];
  },
});
