"use client";

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef } from "react";
import {
  Bold, Italic, Strikethrough, Underline as UnderlineIcon, Code,
  Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, Code2, Minus, Highlighter, Link2, Link2Off, Undo2, Redo2,
} from "lucide-react";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { useT, type TranslationKey } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";
import { cn } from "@/shared/lib/utils";

function TBtn({
  onClick, active, disabled, title, children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Marks this as one of the toolbar's own controls. The roving tabindex below
      // collects them by this attribute rather than by tag, so it can never reach
      // into anything else that happens to render a button.
      data-tbtn
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "note-tbtn",
        active && "note-tbtn--active",
        disabled && "note-tbtn--disabled"
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-1 block h-4 w-px shrink-0 rounded-full bg-border" aria-hidden="true" />;
}

/* These hex values are the colour being written into the document, not theming:
   a note keeps its highlight when the app theme changes, so they cannot come
   from a theme token. The name beside each one is a dictionary key — it goes into
   "Highlight {color}", which every language builds its own way. */
const HIGHLIGHT_COLORS: readonly { color: string; labelKey: TranslationKey }[] = [
  { color: "#fde68a", labelKey: "files.note.toolbar.color.yellow" },
  { color: "#bbf7d0", labelKey: "files.note.toolbar.color.green" },
  { color: "#bfdbfe", labelKey: "files.note.toolbar.color.blue" },
  { color: "#fbcfe8", labelKey: "files.note.toolbar.color.pink" },
  { color: "#ddd6fe", labelKey: "files.note.toolbar.color.purple" },
];

const TEXT_COLORS: readonly { color: string; labelKey: TranslationKey }[] = [
  { color: "#f87171", labelKey: "files.note.toolbar.color.red" },
  { color: "#fb923c", labelKey: "files.note.toolbar.color.orange" },
  { color: "#facc15", labelKey: "files.note.toolbar.color.yellow" },
  { color: "#34d399", labelKey: "files.note.toolbar.color.green" },
  { color: "#60a5fa", labelKey: "files.note.toolbar.color.blue" },
  { color: "#a78bfa", labelKey: "files.note.toolbar.color.purple" },
];

/** TipTap accepts a bare "example.com" as a path, which would then resolve
 *  against the current route. Anything already carrying a scheme, an anchor or
 *  an absolute path is left exactly as typed. */
function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("#")) {
    return value;
  }
  return `https://${value}`;
}

export function NoteToolbar({ editor }: { editor: Editor }) {
  const t = useT();
  const { askPrompt, dialogs } = useDialogs();
  const hasLink = editor.isActive("link");

  const barRef = useRef<HTMLDivElement | null>(null);
  /** Which control currently owns the toolbar's single tab stop. */
  const activeIdx = useRef(0);

  const controls = useCallback(
    () =>
      Array.from(
        barRef.current?.querySelectorAll<HTMLButtonElement>("[data-tbtn]") ?? []
      ).filter((node) => !node.disabled),
    []
  );

  /**
   * Roving tabindex, the ARIA toolbar pattern: the whole bar is one tab stop and the
   * arrow keys move between its thirty-odd controls. Tabbing used to walk through every
   * one of them before reaching the note, which is a long way to travel to start typing.
   * Re-applied after each render because which controls are enabled changes with the
   * selection — undo, redo and "remove link" come and go.
   */
  useEffect(() => {
    const nodes = controls();
    if (nodes.length === 0) return;
    if (activeIdx.current >= nodes.length) activeIdx.current = 0;
    nodes.forEach((node, i) => {
      node.tabIndex = i === activeIdx.current ? 0 : -1;
    });
  });

  function onToolbarKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const { key } = e;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") {
      return;
    }
    const nodes = controls();
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;
    e.preventDefault();
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? nodes.length - 1
          : key === "ArrowRight"
            ? (current + 1) % nodes.length
            : (current - 1 + nodes.length) % nodes.length;
    nodes[current].tabIndex = -1;
    nodes[next].tabIndex = 0;
    activeIdx.current = next;
    nodes[next].focus();
  }

  // Keeps the tab stop wherever the author last was, so leaving the toolbar and coming
  // back does not send them to the far left again.
  function onToolbarFocus() {
    const nodes = controls();
    const idx = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1 || idx === activeIdx.current) return;
    const previous = nodes[activeIdx.current];
    if (previous) previous.tabIndex = -1;
    activeIdx.current = idx;
    nodes[idx].tabIndex = 0;
  }

  async function setLink() {
    const previous = editor.getAttributes("link").href as string | undefined;
    const answer = await askPrompt({
      title: t(previous ? "files.note.toolbar.editLink" : "files.note.toolbar.addLink"),
      label: t("files.note.toolbar.linkLabel"),
      initialValue: previous ?? "",
      placeholder: "https://example.com",
      confirmText: t("files.note.toolbar.linkApply"),
    });
    if (answer === null) return;
    const href = normalizeUrl(answer);
    const applied = editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    if (!applied) {
      // setLink refuses anything outside its scheme allow-list (javascript:,
      // data:, …) and returns false without touching the document — silently,
      // which reads as a dead button.
      notify({
        title: t("files.note.toolbar.linkRefused"),
        description: t("files.note.toolbar.linkRefusedBody"),
        tone: "warning",
        duration: 4000,
      });
    }
  }

  return (
    <div
      ref={barRef}
      // role="toolbar" is the promise that the arrow keys work — see the roving
      // tabindex above. It was role="group", which makes no such promise and left
      // every button in the tab order.
      role="toolbar"
      aria-label={t("files.note.toolbar.label")}
      aria-orientation="horizontal"
      onKeyDown={onToolbarKeyDown}
      onFocus={onToolbarFocus}
      className="note-toolbar"
    >
      {/* Undo / Redo */}
      <TBtn title={t("files.note.toolbar.undo")} onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
        <Undo2 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.redo")} onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
        <Redo2 className="h-3.5 w-3.5" />
      </TBtn>

      <Sep />

      {/* Headings */}
      <TBtn title={t("files.note.block.heading1")} active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.block.heading2")} active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.block.heading3")} active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="h-3.5 w-3.5" />
      </TBtn>

      <Sep />

      {/* Inline marks */}
      <TBtn title={t("files.note.toolbar.bold")} active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.italic")} active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.underline")} active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.strikethrough")} active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.inlineCode")} active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.link")} active={hasLink} onClick={() => void setLink()}>
        <Link2 className="h-3.5 w-3.5" />
      </TBtn>
      {/* Kept mounted rather than swapped in when a link is selected: a control
          that appears and disappears shifts every button beside it. */}
      <TBtn
        title={t("files.note.toolbar.removeLink")}
        disabled={!hasLink}
        onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
      >
        <Link2Off className="h-3.5 w-3.5" />
      </TBtn>

      <Sep />

      {/* Highlights */}
      <div className="flex items-center gap-0.5" role="group" aria-label={t("files.note.toolbar.highlightGroup")}>
        <Highlighter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="ml-1 flex items-center gap-0.5">
          {HIGHLIGHT_COLORS.map(({ color, labelKey }) => (
            <button
              key={color}
              type="button"
              data-tbtn
              title={t("files.note.toolbar.highlightSwatch", { color: t(labelKey) })}
              aria-label={t("files.note.toolbar.highlightSwatch", { color: t(labelKey) })}
              aria-pressed={editor.isActive("highlight", { color })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().toggleHighlight({ color }).run()}
              className="note-color-swatch"
            >
              <span className="note-color-swatch__dot" style={{ backgroundColor: color }} />
            </button>
          ))}
        </div>
      </div>

      <Sep />

      {/* Text colors */}
      <div className="flex items-center gap-0.5" role="group" aria-label={t("files.note.toolbar.textGroup")}>
        <span aria-hidden="true" className="select-none text-xs font-bold text-muted-foreground">
          A
        </span>
        <div className="ml-1 flex items-center gap-0.5">
          {TEXT_COLORS.map(({ color, labelKey }) => (
            <button
              key={color}
              type="button"
              data-tbtn
              title={t("files.note.toolbar.textSwatch", { color: t(labelKey) })}
              aria-label={t("files.note.toolbar.textSwatchLabel", { color: t(labelKey) })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().setColor(color).run()}
              className="note-color-swatch"
            >
              <span className="note-color-swatch__dot" style={{ backgroundColor: color }} />
            </button>
          ))}
        </div>
        <button
          type="button"
          data-tbtn
          title={t("files.note.toolbar.resetTextColor")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().unsetColor().run()}
          className="note-reset-btn ml-1"
        >
          {t("files.edit.reset")}
        </button>
      </div>

      <Sep />

      {/* Lists + blocks */}
      <TBtn title={t("files.note.block.bulletList")} active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.block.numberedList")} active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.block.todoList")} active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListChecks className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.toolbar.blockquote")} active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.block.codeBlock")} active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code2 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title={t("files.note.block.divider")} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        <Minus className="h-3.5 w-3.5" />
      </TBtn>
      {dialogs}
    </div>
  );
}
