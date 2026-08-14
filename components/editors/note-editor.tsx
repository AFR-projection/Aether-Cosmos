"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Check, Loader2, Download, ListTree, FileText, FileDown, FileType,
  ChevronRight, Hash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { File as FileRecord } from "@/lib/db/schema";
import { NoteToolbar } from "./note-toolbar";
import { SlashCommand } from "./slash-command";
import { tiptapToMarkdown } from "@/lib/notes/export";
import { tiptapToPlainText } from "@/lib/search/tiptap-text";

interface NoteEditorProps {
  file: FileRecord;
  onClose: () => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";
type OutlineItem = { level: number; text: string; pos: number };

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, "") || "note";

export function NoteEditor({ file, onClose }: NoteEditorProps) {
  const saveTimeout = useRef<NodeJS.Timeout | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [tick, setTick] = useState(0);
  const [showOutline, setShowOutline] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: "Mulai menulis… atau ketik '/' untuk blok",
      }),
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      Color,
      SlashCommand,
    ],
    content: "",
    editorProps: {
      attributes: {
        class:
          "note-prose prose prose-base dark:prose-invert max-w-none min-h-[55vh] focus:outline-none",
      },
    },
    onSelectionUpdate: () => setTick((t) => t + 1),
    onTransaction: () => setTick((t) => t + 1),
  });

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    apiFetch<{ file: FileRecord; content: { contentJson: unknown } | null }>(
      `/api/files/${file.id}`
    ).then((res) => {
      if (cancelled || !editor || editor.isDestroyed) return;
      if (res.data?.content?.contentJson) {
        editor.commands.setContent(res.data.content.contentJson as Record<string, unknown>);
      }
    });
    return () => { cancelled = true; };
  }, [file.id, editor]);

  const save = useCallback(
    (content: unknown) => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
      setSaveState("saving");
      saveTimeout.current = setTimeout(async () => {
        const res = await apiFetch(`/api/files/${file.id}`, {
          method: "PUT",
          body: JSON.stringify({ content }),
        });
        setSaveState(res.success ? "saved" : "error");
      }, 1200);
    },
    [file.id]
  );

  useEffect(() => {
    if (!editor) return;
    const handler = () => { if (!editor.isDestroyed) save(editor.getJSON()); };
    editor.on("update", handler);
    return () => { editor.off("update", handler); };
  }, [editor, save]);

  useEffect(() => {
    return () => { if (saveTimeout.current) clearTimeout(saveTimeout.current); };
  }, []);

  const { words, chars } = useMemo(() => {
    if (!editor) return { words: 0, chars: 0 };
    const text = editor.getText().trim();
    return {
      words: text ? text.split(/\s+/).length : 0,
      chars: text.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tick]);

  const outline = useMemo<OutlineItem[]>(() => {
    if (!editor) return [];
    const items: OutlineItem[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        items.push({
          level: Number(node.attrs.level) || 1,
          text: node.textContent || "Untitled",
          pos,
        });
      }
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tick]);

  const jumpTo = (pos: number) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection(pos + 1).run();
    const dom = editor.view.domAtPos(pos + 1)?.node as HTMLElement | undefined;
    (dom?.nodeType === 1 ? dom : dom?.parentElement)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const doExport = (kind: "md" | "txt" | "pdf") => {
    if (!editor) return;
    const json = editor.getJSON();
    const name = baseName(file.name);
    if (kind === "md") {
      downloadText(`${name}.md`, tiptapToMarkdown(json), "text/markdown");
    } else if (kind === "txt") {
      downloadText(`${name}.txt`, tiptapToPlainText(json), "text/plain");
    } else {
      printPdf(name, editor);
    }
    setShowExport(false);
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-6 lg:p-10"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="note-editor-shell relative flex w-full max-w-4xl flex-col overflow-hidden"
        style={{ minHeight: "82vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Chrome */}
        <div className="note-editor-chrome flex shrink-0 items-center gap-3 px-4 py-2.5">
          {/* Left: file icon + name */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold">{baseName(file.name)}</h2>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1">
            <SaveBadge state={saveState} />

            <button
              type="button"
              title="Outline"
              onClick={() => setShowOutline((v) => !v)}
              className={cn(
                "note-action-btn",
                showOutline && "note-action-btn--active"
              )}
            >
              <ListTree className="h-4 w-4" />
            </button>

            <div className="relative">
              <button
                type="button"
                title="Export"
                onClick={() => setShowExport((v) => !v)}
                className="note-action-btn"
              >
                <Download className="h-4 w-4" />
              </button>
              <AnimatePresence>
                {showExport && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.94, y: -6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.94, y: -4 }}
                    transition={{ duration: 0.14 }}
                    className="note-export-menu"
                    onMouseLeave={() => setShowExport(false)}
                  >
                    <ExportItem icon={FileType} label="Markdown (.md)" onClick={() => doExport("md")} />
                    <ExportItem icon={FileText} label="Plain text (.txt)" onClick={() => doExport("txt")} />
                    <ExportItem icon={FileDown} label="PDF (print)" onClick={() => doExport("pdf")} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="mx-1 h-4 w-px" style={{ background: "var(--border)" }} />

            <button
              type="button"
              title="Tutup (Esc)"
              onClick={onClose}
              className="note-action-btn note-action-btn--close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        {editor && (
          <div className="note-toolbar-wrap shrink-0 px-5 pb-2 pt-0">
            <NoteToolbar editor={editor} />
          </div>
        )}

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* Editor area */}
          <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6 sm:px-12 sm:py-8">
            <EditorContent editor={editor} />
          </div>

          {/* Outline sidebar */}
          <AnimatePresence>
            {showOutline && (
              <motion.aside
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 220, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 34 }}
                className="note-outline shrink-0 overflow-hidden"
              >
                <div className="w-[220px] overflow-y-auto p-4">
                  <p className="mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest"
                    style={{ color: "var(--accent)" }}>
                    <Hash className="h-3 w-3" /> Outline
                  </p>
                  {outline.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.5 }}>
                      Belum ada heading
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {outline.map((h, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            onClick={() => jumpTo(h.pos)}
                            className="note-outline-item"
                            style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                          >
                            {h.level === 1 && <ChevronRight className="mr-1 h-3 w-3 shrink-0 opacity-40" />}
                            <span className="truncate">{h.text}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="note-footer flex shrink-0 items-center justify-between px-5 py-2">
          <span className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
            {words} kata · {chars} karakter
          </span>
          <span className="hidden text-[11px] sm:inline" style={{ color: "var(--muted-foreground)", opacity: 0.6 }}>
            Ketik <kbd className="note-kbd">/</kbd> untuk menu blok
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <AnimatePresence mode="wait">
      <motion.span
        key={state}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ duration: 0.15 }}
        className={cn(
          "mr-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
          state === "saving" && "bg-muted/40 text-muted-foreground",
          state === "saved" && "text-emerald-500",
          state === "error" && "text-danger"
        )}
      >
        {state === "saving" && <Loader2 className="h-3 w-3 animate-spin" />}
        {state === "saved" && <Check className="h-3 w-3" />}
        {state === "error" && <X className="h-3 w-3" />}
        {state === "saving" ? "Menyimpan…" : state === "saved" ? "Tersimpan" : "Gagal simpan"}
      </motion.span>
    </AnimatePresence>
  );
}

function ExportItem({
  icon: Icon, label, onClick,
}: { icon: typeof FileText; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="note-export-item"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

function printPdf(name: string, editor: Editor) {
  const html = editor.getHTML();
  const win = window.open("", "_blank", "width=800,height=1000");
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#111;line-height:1.7}
      h1{font-size:2rem;font-weight:700;margin:1.5rem 0 .5rem;letter-spacing:-.03em}
      h2{font-size:1.35rem;font-weight:600;margin:1.2rem 0 .4rem}
      h3{font-size:1.1rem;font-weight:600;margin:1rem 0 .3rem}
      pre{background:#f4f4f5;padding:14px 16px;border-radius:10px;overflow:auto;font-size:.85rem}
      code{background:#f4f4f5;padding:2px 5px;border-radius:5px;font-size:.88em}
      blockquote{border-left:3px solid #818cf8;margin:0;padding-left:16px;color:#555;font-style:italic}
      ul[data-type=taskList]{list-style:none;padding-left:0}
      ul[data-type=taskList] li{display:flex;gap:8px;align-items:flex-start}
      mark{padding:1px 3px;border-radius:3px}hr{border:none;border-top:1px solid #e5e7eb;margin:28px 0}
    </style></head><body><h1>${name}</h1>${html}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}
