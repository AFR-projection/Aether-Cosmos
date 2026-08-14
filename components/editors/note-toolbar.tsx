"use client";

import type { Editor } from "@tiptap/react";
import {
  Bold, Italic, Strikethrough, Underline as UnderlineIcon, Code,
  Heading1, Heading2, Heading3, List, ListOrdered, ListChecks,
  Quote, Code2, Minus, Highlighter, Link2, Undo2, Redo2,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  return (
    <span
      className="mx-1 block h-4 w-px shrink-0 rounded-full"
      style={{ background: "var(--border)" }}
      aria-hidden
    />
  );
}

const HIGHLIGHT_COLORS = [
  { color: "#fde68a", label: "Kuning" },
  { color: "#bbf7d0", label: "Hijau" },
  { color: "#bfdbfe", label: "Biru" },
  { color: "#fbcfe8", label: "Pink" },
  { color: "#ddd6fe", label: "Ungu" },
];

const TEXT_COLORS = [
  { color: "#f87171", label: "Merah" },
  { color: "#fb923c", label: "Oranye" },
  { color: "#facc15", label: "Kuning" },
  { color: "#34d399", label: "Hijau" },
  { color: "#60a5fa", label: "Biru" },
  { color: "#a78bfa", label: "Ungu" },
];

export function NoteToolbar({ editor }: { editor: Editor }) {
  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL tautan:", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className="note-toolbar">
      {/* Undo / Redo */}
      <TBtn title="Undo (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}>
        <Undo2 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Redo (Ctrl+Y)" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}>
        <Redo2 className="h-3.5 w-3.5" />
      </TBtn>

      <Sep />

      {/* Headings */}
      <TBtn title="Heading 1" active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Heading 2" active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Heading 3" active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="h-3.5 w-3.5" />
      </TBtn>

      <Sep />

      {/* Inline marks */}
      <TBtn title="Bold (Ctrl+B)" active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Italic (Ctrl+I)" active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Underline (Ctrl+U)" active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Strikethrough" active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Inline code" active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Tautan" active={editor.isActive("link")} onClick={setLink}>
        <Link2 className="h-3.5 w-3.5" />
      </TBtn>

      <Sep />

      {/* Highlights */}
      <div className="flex items-center gap-0.5">
        <Highlighter className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--muted-foreground)", opacity: 0.7 }} />
        <div className="ml-1 flex items-center gap-1">
          {HIGHLIGHT_COLORS.map(({ color, label }) => (
            <button
              key={color}
              type="button"
              title={`Highlight ${label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().toggleHighlight({ color }).run()}
              className="note-color-swatch"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>

      <Sep />

      {/* Text colors */}
      <div className="flex items-center gap-0.5">
        <span className="select-none text-[11px] font-bold" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>A</span>
        <div className="ml-1 flex items-center gap-1">
          {TEXT_COLORS.map(({ color, label }) => (
            <button
              key={color}
              type="button"
              title={`Warna teks ${label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().setColor(color).run()}
              className="note-color-swatch"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <button
          type="button"
          title="Reset warna teks"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().unsetColor().run()}
          className="note-reset-btn ml-1"
        >
          reset
        </button>
      </div>

      <Sep />

      {/* Lists + blocks */}
      <TBtn title="Bullet list" active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Numbered list" active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="To-do list" active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListChecks className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Blockquote" active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Code block" active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code2 className="h-3.5 w-3.5" />
      </TBtn>
      <TBtn title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        <Minus className="h-3.5 w-3.5" />
      </TBtn>
    </div>
  );
}
