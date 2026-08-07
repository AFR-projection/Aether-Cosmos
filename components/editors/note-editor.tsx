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
import { motion } from "framer-motion";
import {
  X, Check, Loader2, Download, ListTree, FileText, FileDown, FileType,
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

/** Trigger a browser download of a text blob. */
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
  const [tick, setTick] = useState(0); // forces toolbar re-render on selection change
  const [showOutline, setShowOutline] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: "Tulis sesuatu, atau ketik '/' untuk perintah…",
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
          "prose prose-sm dark:prose-invert max-w-none min-h-[45vh] focus:outline-none px-1",
      },
    },
    onSelectionUpdate: () => setTick((t) => t + 1),
    onTransaction: () => setTick((t) => t + 1),
  });

  // Load existing content.
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
    return () => {
      cancelled = true;
    };
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
    const handler = () => {
      if (!editor.isDestroyed) save(editor.getJSON());
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, save]);

  useEffect(() => {
    return () => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
    };
  }, []);

  // Word / character count (depends on tick so it stays live).
  const { words, chars } = useMemo(() => {
    if (!editor) return { words: 0, chars: 0 };
    const text = editor.getText().trim();
    return {
      words: text ? text.split(/\s+/).length : 0,
      chars: text.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tick]);

  // Outline from headings.
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

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="scrim fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-accent" />
            <h2 className="truncate text-sm font-semibold">{baseName(file.name)}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <SaveBadge state={saveState} />
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Outline"
              onClick={() => setShowOutline((v) => !v)}>
              <ListTree className={cn("h-4 w-4", showOutline && "text-accent")} />
            </Button>
            <div className="relative">
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Export / Download"
                onClick={() => setShowExport((v) => !v)}>
                <Download className="h-4 w-4" />
              </Button>
              {showExport && (
                <div
                  className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-xl border border-border/60 bg-card/95 p-1 shadow-2xl backdrop-blur-xl"
                  onMouseLeave={() => setShowExport(false)}
                >
                  <ExportItem icon={FileType} label="Markdown (.md)" onClick={() => doExport("md")} />
                  <ExportItem icon={FileText} label="Teks (.txt)" onClick={() => doExport("txt")} />
                  <ExportItem icon={FileDown} label="PDF (print)" onClick={() => doExport("pdf")} />
                </div>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Tutup (Esc)" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Toolbar */}
        {editor && (
          <div className="border-b border-border/40 px-3 py-2">
            <NoteToolbar editor={editor} />
          </div>
        )}

        {/* Body: editor + optional outline */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8">
            <EditorContent editor={editor} />
          </div>
          {showOutline && (
            <aside className="hidden w-56 shrink-0 overflow-y-auto border-l border-border/50 bg-muted/10 p-3 sm:block">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Outline
              </p>
              {outline.length === 0 ? (
                <p className="text-xs text-muted-foreground/60">Belum ada heading</p>
              ) : (
                <ul className="space-y-0.5">
                  {outline.map((h, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => jumpTo(h.pos)}
                        className="block w-full truncate rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        style={{ paddingLeft: `${(h.level - 1) * 10 + 8}px` }}
                      >
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </div>

        {/* Footer: counts */}
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span>{words} kata · {chars} karakter</span>
          <span className="hidden sm:inline">Ketik <kbd className="rounded bg-muted px-1">/</kbd> untuk menu blok</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const map = {
    saving: { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: "Menyimpan…", cls: "text-muted-foreground" },
    saved: { icon: <Check className="h-3 w-3" />, text: "Tersimpan", cls: "text-emerald-500" },
    error: { icon: <X className="h-3 w-3" />, text: "Gagal simpan", cls: "text-danger" },
  } as const;
  const m = map[state];
  return (
    <span className={cn("mr-1 inline-flex items-center gap-1 text-[11px] font-medium", m.cls)}>
      {m.icon} {m.text}
    </span>
  );
}

function ExportItem({
  icon: Icon, label, onClick,
}: {
  icon: typeof FileText;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

/** Export to PDF via a print window that inherits the rendered HTML. */
function printPdf(name: string, editor: Editor) {
  const html = editor.getHTML();
  const win = window.open("", "_blank", "width=800,height=1000");
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#111;line-height:1.6}
      h1,h2,h3{font-weight:600;margin:1.2em 0 .4em} pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto}
      code{background:#f4f4f5;padding:2px 4px;border-radius:4px} blockquote{border-left:3px solid #ddd;margin:0;padding-left:16px;color:#555}
      ul[data-type=taskList]{list-style:none;padding-left:0} ul[data-type=taskList] li{display:flex;gap:8px;align-items:flex-start}
      mark{padding:0 2px;border-radius:2px} hr{border:none;border-top:1px solid #ddd;margin:24px 0}
    </style></head><body><h1>${name}</h1>${html}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}
