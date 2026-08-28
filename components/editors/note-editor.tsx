"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Underline from "@tiptap/extension-underline";
import { useEffect, useCallback, useId, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  X, Check, Loader2, Download, ListTree, FileText, FileDown, FileType,
  ChevronRight, Hash, Save, AlertTriangle, RotateCcw, Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { File as FileRecord } from "@/lib/db/schema";
import { NoteToolbar } from "./note-toolbar";
import { SlashCommand } from "./slash-command";
import { tiptapToMarkdown } from "@/lib/notes/export";
import { tiptapToPlainText } from "@/lib/search/tiptap-text";
import {
  clearDraft,
  isSaveShortcut,
  readDraft,
  serializeDoc,
  shouldOfferDraft,
  writeDraft,
  type DraftStorage,
  type NoteDraft,
} from "@/lib/notes/note-draft";

interface NoteEditorProps {
  file: FileRecord;
  onClose: () => void;
}

/** What the Save button is showing. `locked` = the note could not be read, so writing is off. */
type SaveState = "clean" | "dirty" | "saving" | "error" | "locked";
type OutlineItem = { level: number; text: string; pos: number };

/** Local drafts are best-effort: a blocked or absent storage must not break the editor. */
function getStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
}

/** At most one local draft write per this many ms of typing. */
const DRAFT_THROTTLE_MS = 700;

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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

/* The editor covers the whole listing, so Tab has to stay inside it — the same selector
   the shared Modal uses, plus the ProseMirror surface, which is focusable through
   `contenteditable` rather than a tabindex. */
const FOCUSABLE = [
  "a[href]",
  // The formatting toolbar is a roving-tabindex toolbar: only one of its buttons is a
  // real tab stop at a time, so the `-1` ones must not count as the boundary here.
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function NoteEditor({ file, onClose }: NoteEditorProps) {
  const [tick, setTick] = useState(0);
  const [showOutline, setShowOutline] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [draftOffer, setDraftOffer] = useState<NoteDraft | null>(null);
  const [closePrompt, setClosePrompt] = useState(false);
  const [isMac] = useState(isMacPlatform);
  // Only framer's JS animations need this: the global `prefers-reduced-motion` block in
  // globals.css already flattens every CSS animation.
  const reduceMotion = useReducedMotion();

  /** The panel itself — the boundary the Tab trap works against. */
  const shellRef = useRef<HTMLDivElement | null>(null);
  /** The unsaved-changes prompt takes over as that boundary while it is up. */
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /** The document exactly as the server last confirmed it — the yardstick for "unsaved". */
  const baselineRef = useRef("");
  /** True only after a successful load; nothing may be written before that. */
  const loadedRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const latestJsonRef = useRef<unknown>(undefined);
  const lastDraftWrite = useRef(0);

  const editor = useEditor({
    immediatelyRender: false,
    // Read-only until the note is on screen: a keystroke into a not-yet-loaded editor is how
    // an empty document used to end up saved over a real note.
    editable: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: "Start writing… or type '/' for blocks",
      }),
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      Color,
      Underline,
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

  // ── Load ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;

    const run = async () => {
      try {
        const res = await apiFetch<{ file: FileRecord; content: { contentJson: unknown } | null }>(
          `/api/files/${file.id}`
        );
        if (cancelled || editor.isDestroyed) return;
        if (!res.success) {
          setLoadError(res.error ?? "Couldn't load this note.");
          return;
        }
        const serverJson = res.data?.content?.contentJson ?? null;
        if (serverJson) {
          editor.commands.setContent(serverJson as Record<string, unknown>);
        }
        const current = editor.getJSON();
        baselineRef.current = serializeDoc(current);
        latestJsonRef.current = current;
        dirtyRef.current = false;
        setDirty(false);
        setLoaded(true);
        editor.setEditable(true);

        // Only now may drafts be touched: doing it earlier would let `setContent` above
        // overwrite the very draft we are trying to recover.
        const storage = getStorage();
        const draft = storage ? readDraft(storage, file.id) : null;
        if (storage && draft) {
          if (shouldOfferDraft(draft, current)) setDraftOffer(draft);
          else clearDraft(storage, file.id);
        }
        loadedRef.current = true;
      } catch {
        if (!cancelled) setLoadError("Couldn't load this note. Check your connection.");
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [file.id, editor, reloadNonce]);

  // ── Track changes + keep a local draft as the crash net ──────────────────────
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      if (editor.isDestroyed || !loadedRef.current) return;
      const json = editor.getJSON();
      const changed = serializeDoc(json) !== baselineRef.current;
      latestJsonRef.current = json;
      dirtyRef.current = changed;
      setDirty(changed);
      setSaveError(null);

      const storage = getStorage();
      if (!storage) return;
      if (!changed) {
        clearDraft(storage, file.id);
        return;
      }
      const now = Date.now();
      if (now - lastDraftWrite.current < DRAFT_THROTTLE_MS) return;
      lastDraftWrite.current = now;
      writeDraft(storage, file.id, json, now);
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, file.id]);

  // ── Flush the draft on close / tab hide / reload ─────────────────────────────
  useEffect(() => {
    const flush = () => {
      const storage = getStorage();
      if (!storage || !loadedRef.current || !dirtyRef.current) return;
      if (latestJsonRef.current === undefined) return;
      writeDraft(storage, file.id, latestJsonRef.current);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flush();
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      // The old editor cleared a pending save here and lost the text; this does the
      // opposite — the last keystrokes are put on disk before the editor goes away.
      flush();
    };
  }, [file.id]);

  // ── Save, only when asked ───────────────────────────────────────────────────
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!editor || editor.isDestroyed) return false;
    // Never write over a note we failed to read, and never run two saves at once.
    if (!loaded || loadError) return false;
    if (savingRef.current) return false;

    const json = editor.getJSON();
    const snapshot = serializeDoc(json);
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/files/${file.id}`, {
        method: "PUT",
        body: JSON.stringify({ content: json }),
      });
      if (!res.success) {
        setSaveError(res.error ?? "Couldn't save.");
        return false;
      }
      baselineRef.current = snapshot;
      setLastSavedAt(Date.now());

      // Anything typed while the request was in flight is still unsaved, so it keeps both
      // its dirty flag and its draft.
      const current = editor.isDestroyed ? json : editor.getJSON();
      const stillDirty = serializeDoc(current) !== snapshot;
      dirtyRef.current = stillDirty;
      setDirty(stillDirty);
      const storage = getStorage();
      if (storage) {
        if (stillDirty) writeDraft(storage, file.id, current);
        else clearDraft(storage, file.id);
      }
      return true;
    } catch {
      setSaveError("Couldn't save. Check your connection.");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [editor, file.id, loaded, loadError]);

  const requestClose = useCallback(() => {
    if (savingRef.current) return; // let the save the author asked for land first
    if (dirtyRef.current) {
      setClosePrompt(true);
      return;
    }
    onClose();
  }, [onClose]);

  const discardAndClose = useCallback(() => {
    const storage = getStorage();
    if (storage) clearDraft(storage, file.id);
    dirtyRef.current = false;
    onClose();
  }, [file.id, onClose]);

  const saveAndClose = useCallback(async () => {
    if (await saveNow()) onClose();
    else setClosePrompt(false); // the error is shown on the button; stay in the editor
  }, [saveNow, onClose]);

  const restoreDraft = useCallback(() => {
    if (!editor || editor.isDestroyed || !draftOffer) return;
    editor.commands.setContent(draftOffer.json as Record<string, unknown>);
    const json = editor.getJSON();
    latestJsonRef.current = json;
    const changed = serializeDoc(json) !== baselineRef.current;
    dirtyRef.current = changed;
    setDirty(changed);
    setDraftOffer(null);
    editor.commands.focus("end");
  }, [editor, draftOffer]);

  const dismissDraft = useCallback(() => {
    const storage = getStorage();
    if (storage) clearDraft(storage, file.id);
    setDraftOffer(null);
  }, [file.id]);

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

  // ── Keyboard: Ctrl/Cmd+S saves, Escape steps back one layer at a time ────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isSaveShortcut(e)) {
        // Always swallow it, even when there is nothing to save, so the browser's own
        // "save page" dialog never appears over the note.
        e.preventDefault();
        void saveNow();
        return;
      }
      if (e.key !== "Escape") return;
      if (closePrompt) {
        setClosePrompt(false);
        return;
      }
      if (showExport) {
        setShowExport(false);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNow, requestClose, closePrompt, showExport]);

  // ── Modal plumbing ──────────────────────────────────────────────────────────
  /**
   * The editor covers the whole page, so the page behind it must not scroll, and the
   * row that opened it must get its focus back on close — otherwise a keyboard author
   * is dropped at the top of the listing and has to walk down to where they were.
   */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = restoreOverflow;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  // Focus enters the panel itself rather than its first button: it announces the note's
  // name, and it does not raise a phone's on-screen keyboard over the text.
  useEffect(() => {
    const raf = requestAnimationFrame(() => shellRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  // Once the note is readable the caret moves into it, so an author who came here to
  // write can simply write. Skipped on touch (the keyboard would cover the note) and
  // whenever focus has already been placed somewhere deliberately.
  useEffect(() => {
    if (!loaded || !editor || editor.isDestroyed) return;
    if (document.activeElement !== shellRef.current) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    editor.commands.focus();
  }, [loaded, editor]);

  /**
   * Tab stays inside the editor. While the unsaved-changes prompt is up it becomes the
   * boundary instead: it is a dialog over a dialog, so tabbing back to the text behind
   * it would mean stepping past a question that still has to be answered.
   */
  function trapTab(event: React.KeyboardEvent<HTMLDivElement>) {
    // ProseMirror owns Tab inside the text (list indent) and marks it handled.
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const root = (closePrompt ? confirmRef.current : shellRef.current) ?? shellRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (active === root || !root.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const saveState: SaveState =
    !loaded || loadError ? "locked" : saving ? "saving" : saveError ? "error" : dirty ? "dirty" : "clean";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18 }}
      // z-50 is the documented tier for full-screen surfaces — see the LAYER scale in
      // components/ui/modal.tsx. `scrim` is the shared backdrop, so this dims the page
      // exactly like the file preview does and follows the lite theme with it.
      className="scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6 lg:p-10"
      // Mousedown, not click: selecting text from inside the note and releasing over the
      // margin lands the click on this element, which used to close the editor mid-drag.
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <motion.div
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
        className={cn(
          "note-editor-shell relative flex w-full max-w-4xl flex-col overflow-hidden",
          // dvh, not vh: on a phone the mobile browser's own chrome is part of vh, so the
          // footer sat below the fold on exactly the screens with least room to spare.
          "min-h-[82dvh] focus-visible:outline-none"
        )}
      >
        {/* Chrome */}
        <div className="note-editor-chrome flex shrink-0 items-center gap-3 px-4 py-2.5">
          {/* Left: file icon + name */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 id={titleId} className="truncate text-sm font-semibold">
              {baseName(file.name)}
            </h2>
            {/* Reinforcement only, never the sole signal: the Save button reads "Save"
                instead of "Saved" and the footer says so in words, both of which a
                screen reader already announces. */}
            {dirty && <span className="note-dirty-dot" title="Unsaved changes" aria-hidden />}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1">
            <SaveButton
              state={saveState}
              isMac={isMac}
              onClick={() => void saveNow()}
            />

            <button
              type="button"
              title="Outline"
              // Icon-only: without a name a screen reader announces just "button".
              aria-label="Toggle outline"
              aria-pressed={showOutline}
              onClick={() => setShowOutline((v) => !v)}
              className={cn(
                "note-action-btn",
                showOutline && "note-action-btn--active"
              )}
            >
              <ListTree aria-hidden className="h-4 w-4" />
            </button>

            <div
              className="relative"
              // Tabbing past the last item closed nothing before, leaving the menu open
              // over the note with focus already back in the text.
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShowExport(false);
              }}
            >
              <button
                type="button"
                title="Export"
                aria-label="Export note"
                aria-expanded={showExport}
                onClick={() => setShowExport((v) => !v)}
                className="note-action-btn"
              >
                <Download aria-hidden className="h-4 w-4" />
              </button>
              <AnimatePresence>
                {showExport && (
                  <motion.div
                    role="group"
                    aria-label="Export format"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }}
                    animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -4 }}
                    transition={{ duration: reduceMotion ? 0 : 0.14 }}
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

            <div aria-hidden className="mx-1 h-4 w-px bg-border" />

            <button
              type="button"
              title="Close (Esc)"
              aria-label="Close note"
              onClick={requestClose}
              className="note-action-btn note-action-btn--close"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* A note that could not be read is never overwritten — the editor stays read-only. */}
        {loadError && (
          <div className="note-banner" data-tone="danger" role="alert">
            <AlertTriangle aria-hidden className="note-banner__icon h-4 w-4" />
            <span className="min-w-0 flex-1">
              {loadError} Editing is locked so the original can&apos;t be overwritten.
            </span>
            <button
              type="button"
              className="note-banner-btn"
              onClick={() => {
                setLoadError(null);
                setReloadNonce((n) => n + 1);
              }}
            >
              <RotateCcw aria-hidden className="mr-1 inline h-3 w-3" />
              Try again
            </button>
          </div>
        )}

        {/* Work found in this browser that never reached the server. */}
        {draftOffer && (
          <div className="note-banner" data-tone="warning" role="status">
            <AlertTriangle aria-hidden className="note-banner__icon h-4 w-4" />
            <span className="min-w-0 flex-1">
              Unsaved local changes from <strong>{formatClock(draftOffer.savedAt)}</strong> were
              found in this browser. Restore them?
            </span>
            <button type="button" className="note-banner-btn" onClick={restoreDraft}>
              Restore
            </button>
            <button
              type="button"
              className="note-banner-btn note-banner-btn--ghost"
              onClick={dismissDraft}
            >
              Discard
            </button>
          </div>
        )}

        {/* Toolbar — inert until the note is loaded, so formatting cannot edit a document
            that is still a placeholder. `inert` rather than `aria-hidden`: hiding a
            subtree that still holds focusable buttons is what makes a screen reader
            announce nothing while the keyboard walks straight into it. */}
        {editor && (
          <div
            className={cn("note-toolbar-wrap shrink-0 px-5 pb-2 pt-0", !loaded && "opacity-50")}
            inert={!loaded}
          >
            <NoteToolbar editor={editor} />
          </div>
        )}

        {/* Body */}
        <div className="relative flex min-h-0 flex-1">
          {/* Editor area */}
          <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6 sm:px-12 sm:py-8">
            <EditorContent editor={editor} />
          </div>

          {/* Outline sidebar */}
          <AnimatePresence>
            {showOutline && (
              <motion.aside
                aria-label="Note outline"
                // Opacity and a small slide, never `width`: animating the width re-wrapped
                // every line of prose on each frame. On a phone it floats over the text
                // instead of taking a column, which at 375px left nothing to write in.
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
                className={cn(
                  "note-outline w-[220px] shrink-0 overflow-hidden",
                  "absolute inset-y-0 right-0 z-10 shadow-2xl sm:static sm:z-auto sm:shadow-none"
                )}
              >
                <div className="h-full w-[220px] overflow-y-auto p-4">
                  <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-accent-ink">
                    <Hash aria-hidden className="h-3 w-3" /> Outline
                  </p>
                  {outline.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No headings yet</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {outline.map((h, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            onClick={() => jumpTo(h.pos)}
                            className="note-outline-item"
                            title={h.text}
                            style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                          >
                            {h.level === 1 && (
                              <ChevronRight aria-hidden className="mr-1 h-3 w-3 shrink-0 opacity-60" />
                            )}
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
        <div className="note-footer flex shrink-0 items-center justify-between gap-3 px-5 py-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {words} {words === 1 ? "word" : "words"} · {chars}{" "}
            {chars === 1 ? "character" : "characters"}
          </span>
          {/* There is no autosave, so this line is the only place the author is told
              whether their work reached the server — it has to be announced, not just
              rendered. */}
          <span
            role="status"
            aria-live="polite"
            className="truncate text-xs text-muted-foreground"
          >
            {saveError
              ? saveError
              : dirty
                ? `Unsaved · press ${isMac ? "⌘S" : "Ctrl+S"}`
                : lastSavedAt
                  ? `Saved at ${formatClock(lastSavedAt)}`
                  : loaded
                    ? "No changes yet"
                    : "Loading note…"}
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Type <kbd className="note-kbd">/</kbd> for blocks
          </span>
        </div>

        {/* Closing with unsaved work is always a deliberate choice, never a silent discard. */}
        <AnimatePresence>
          {closePrompt && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.14 }}
              className="note-confirm-backdrop"
              onMouseDown={(e) => { if (e.target === e.currentTarget) setClosePrompt(false); }}
            >
              <motion.div
                ref={confirmRef}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 4 }}
                transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
                className="note-confirm"
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${titleId}-confirm`}
                aria-describedby={`${titleId}-confirm-body`}
              >
                <p className="note-confirm__title" id={`${titleId}-confirm`}>
                  <AlertTriangle aria-hidden className="h-4 w-4 text-warning-ink" />
                  You have unsaved changes
                </p>
                <p className="note-confirm__body" id={`${titleId}-confirm-body`}>
                  This note is only stored once you save it. Your last edits are still kept
                  in this browser as a draft, but they haven&apos;t reached the server.
                </p>
                <div className="note-confirm__actions">
                  <button
                    type="button"
                    className="note-confirm-btn note-confirm-btn--primary"
                    onClick={() => void saveAndClose()}
                    disabled={saving}
                    autoFocus
                  >
                    {saving
                      ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                      : <Save aria-hidden className="h-3.5 w-3.5" />}
                    Save &amp; close
                  </button>
                  <button type="button" className="note-confirm-btn" onClick={() => setClosePrompt(false)}>
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="note-confirm-btn note-confirm-btn--danger"
                    onClick={discardAndClose}
                  >
                    <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    Discard changes
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/**
 * The Save control doubles as the save-status display: there is no autosave, so the author
 * must be able to tell at a glance whether their work is on the server.
 */
function SaveButton({
  state, isMac, onClick,
}: { state: SaveState; isMac: boolean; onClick: () => void }) {
  const label =
    state === "saving"
      ? "Saving…"
      : state === "error"
        ? "Retry save"
        : state === "clean"
          ? "Saved"
          : state === "locked"
            ? "Locked"
            : "Save";

  return (
    <button
      type="button"
      data-state={state}
      className="note-save-btn mr-1"
      onClick={onClick}
      disabled={state === "clean" || state === "saving" || state === "locked"}
      aria-busy={state === "saving"}
      title={
        state === "locked"
          ? "This note hasn't loaded yet, so it can't be saved"
          : `Save (${isMac ? "⌘" : "Ctrl+"}S)`
      }
    >
      {state === "saving" ? (
        <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
      ) : state === "clean" ? (
        <Check aria-hidden className="h-3.5 w-3.5" />
      ) : state === "error" ? (
        <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
      ) : (
        <Save aria-hidden className="h-3.5 w-3.5" />
      )}
      {label}
      {state === "dirty" && <kbd className="note-save-kbd">{isMac ? "⌘S" : "Ctrl+S"}</kbd>}
    </button>
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
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

/* Print styling for the export window. Static, so it can stay in the template. */
const PRINT_CSS = `
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
`;

function printPdf(name: string, editor: Editor) {
  const html = editor.getHTML();
  const win = window.open("", "_blank", "width=800,height=1000");
  if (!win) return;
  // The template below is fixed text — nothing from the note is interpolated into it.
  // A file named `</title><script>…` used to be written straight into this document and
  // run in it, and the window is same-origin, so that script could read this app's page.
  // The name goes in through the DOM instead, where it can only ever become text.
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title></title>` +
      `<style>${PRINT_CSS}</style></head><body><h1></h1></body></html>`
  );
  win.document.close();
  win.document.title = name;
  const heading = win.document.querySelector("h1");
  if (heading) heading.textContent = name;
  // The body markup is ProseMirror's own serialisation of the document: its schema only
  // emits the nodes and marks the editor knows about, so there is no script to inject.
  win.document.body.insertAdjacentHTML("beforeend", html);
  win.focus();
  setTimeout(() => win.print(), 300);
}
