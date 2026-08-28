"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  AlignLeft,
  Check,
  Copy,
  FileText,
  Pencil,
  Save,
  WrapText,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/system/spinner";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api/client";
import { getLanguage, highlightLine } from "@/lib/viewers/text-highlight";
import { isSaveShortcut } from "@/lib/notes/note-draft";
import {
  TEXT_EDIT_MAX_BYTES,
  clampTextForPreview,
  isTextEditable,
  textByteLength,
} from "@/lib/files/text-edit-limits";
import { ViewerLoading, ViewerMessage } from "./viewer-chrome";

/**
 * Read AND write a stored text or code file.
 *
 * Reading is virtualized and syntax highlighted; writing swaps in a `<textarea>` with a
 * matching line gutter. A textarea rather than a code editor library is a deliberate
 * choice: it brings the browser's own undo stack, IME, spellcheck control, selection
 * and screen-reader support for free, at the cost of highlighting while typing.
 *
 * Two rules hold the data safe:
 * - Saving is EXPLICIT (button or Ctrl/Cmd+S). There is no autosave anywhere in this
 *   app — a timer-based one lost real work in the note editor.
 * - Editing is offered only when the whole file is on screen. `clampTextForPreview`
 *   answers that; saving a truncated view would erase everything past the cut.
 */

interface TextViewerProps {
  src: string;
  fileName: string;
  mimeType: string;
  /** Only where a save is possible — the owner's listing, never a public share link. */
  fileId?: string;
  /** `files.version` as loaded: the token that catches a save from another tab. */
  version?: number;
  canEdit?: boolean;
  /**
   * The draft differs from what the server holds. The surface that owns closing (the
   * preview modal) needs this to stop a backdrop click from throwing the edit away.
   * Pass a STABLE function.
   */
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
}

/** Warn above this size even when nothing was cut — the pane will feel heavy. */
const LARGE_FILE_WARN_BYTES = 100_000;

/** One display row. Edit mode pins the same height so the gutter lines up exactly. */
const ROW_HEIGHT = 21;

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

/**
 * The edit-mode gutter as ONE string of numbers.
 *
 * An element per line is what forced the read pane to virtualize; a textarea cannot be
 * virtualized, so its gutter is a single text node instead — cheap at any line count.
 */
function buildGutter(lineCount: number): string {
  let out = "";
  for (let n = 1; n <= lineCount; n++) out += `${n}\n`;
  return out;
}

type Loaded = {
  /** What is on screen: the whole file, or the clamped head of one too large for it. */
  text: string;
  /** Size of the WHOLE file, which is what the warnings talk about. */
  totalBytes: number;
  truncated: boolean;
  /** Whole file present and small enough to write back. */
  editable: boolean;
};

export function TextViewer({
  src,
  fileName,
  mimeType,
  fileId,
  version,
  canEdit = false,
  onDirtyChange,
  onSaved,
}: TextViewerProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** Bumped by every save, so the next one is checked against the right revision. */
  const [fileVersion, setFileVersion] = useState<number | null>(version ?? null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const language = getLanguage(ext);

  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        const clamped = clampTextForPreview(text);
        setLoaded({
          text: clamped.text,
          totalBytes: textByteLength(text),
          truncated: clamped.truncated,
          editable: clamped.editable,
        });
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setError("This file's contents could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [src, attempt]);

  /**
   * The dirty callback is reached through a ref so that a caller who passes an inline
   * arrow cannot make the unmount cleanup below fire on every render — which would
   * clear the parent's unsaved-changes guard while the edit was still open.
   */
  const dirtyCallbackRef = useRef(onDirtyChange);
  useEffect(() => {
    dirtyCallbackRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => () => dirtyCallbackRef.current?.(false), []);

  const dirty = editing && loaded !== null && draft !== loaded.text;

  /**
   * Report every keystroke, not just entering edit mode: the parent's close guard has to
   * know the draft diverged the moment it does, or the first click outside loses it.
   */
  useEffect(() => {
    dirtyCallbackRef.current?.(dirty);
  }, [dirty]);

  // A reload or a tab close is the one exit this component cannot intercept itself.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const lines = useMemo(() => (loaded ? loaded.text.split("\n") : []), [loaded]);

  // One <div> per line stopped scaling well before the size cap, so only the rows in
  // view are mounted. Heights are measured because wrapped lines are taller than one row.
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  /**
   * Whether Save can be offered at all. The mime gate is the same function the save
   * route applies, so the button cannot appear where the server would refuse it.
   */
  const editable =
    canEdit && !!fileId && !!loaded?.editable && isTextEditable(mimeType, fileName);

  const handleCopy = useCallback(async () => {
    const text = editing ? draft : loaded?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the text stays selectable in the pane */
    }
  }, [editing, draft, loaded]);

  const startEditing = useCallback(() => {
    if (!loaded) return;
    setDraft(loaded.text);
    setSaveError(null);
    setConfirmDiscard(false);
    setEditing(true);
  }, [loaded]);

  const leaveEditing = useCallback(() => {
    setEditing(false);
    setConfirmDiscard(false);
    setSaveError(null);
  }, []);

  /** Escape and the close button both land here: never discard without being told to. */
  const requestLeaveEditing = useCallback(() => {
    if (saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    leaveEditing();
  }, [saving, dirty, leaveEditing]);

  /**
   * Draft size in bytes, memoized: it drives the counter AND the Save gate, and encoding
   * half a megabyte of text on every keystroke is not free.
   */
  const draftBytes = useMemo(() => textByteLength(draft), [draft]);
  const draftOverLimit = draftBytes > TEXT_EDIT_MAX_BYTES;

  const draftLineCount = useMemo(() => countLines(draft), [draft]);
  const gutterText = useMemo(() => buildGutter(draftLineCount), [draftLineCount]);

  const save = useCallback(async () => {
    if (!fileId || saving) return;
    // Ctrl+S with nothing changed is a no-op, not a save: writing identical bytes would
    // still snapshot a version and bump the revision for everyone else.
    if (!dirty) return;
    if (draftOverLimit) {
      setSaveError(
        `This edit is ${formatKb(draftBytes)} — larger than the ${formatKb(
          TEXT_EDIT_MAX_BYTES
        )} that can be saved from the browser. Trim it, or download the file to edit it locally.`
      );
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch<{ sizeBytes: number; version: number; updatedAt: string }>(
        `/api/files/${fileId}/content`,
        {
          method: "PUT",
          headers: {
            // Raw text, so the bytes counted here are the bytes stored. `apiFetch` only
            // defaults this header when it is absent, so the explicit type survives.
            "Content-Type": "text/plain; charset=utf-8",
            ...(fileVersion !== null ? { "x-expected-version": String(fileVersion) } : {}),
          },
          body: draft,
        }
      );

      if (!res.success) {
        setSaveError(res.error ?? "The file couldn't be saved.");
        return;
      }

      // The saved text becomes the baseline, which clears `dirty`, and the version the
      // server returned becomes the token for the NEXT save — otherwise the second save
      // in a row would be rejected as a conflict with the first.
      setLoaded((prev) => (prev ? { ...prev, text: draft, totalBytes: draftBytes } : prev));
      if (res.data?.version) setFileVersion(res.data.version);
      setSavedAt(Date.now());
      setConfirmDiscard(false);
      onSaved?.();
    } catch {
      setSaveError("The file couldn't be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }, [fileId, saving, dirty, draft, draftBytes, draftOverLimit, fileVersion, onSaved]);

  /**
   * Tab inserts a tab instead of moving focus out of the field.
   *
   * `execCommand` is deprecated but it is the only API that writes through the browser's
   * own undo stack, which is the whole reason this editor is a textarea. `setRangeText`
   * is the fallback where it is gone.
   */
  const insertTab = useCallback((el: HTMLTextAreaElement) => {
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, "\t");
    } catch {
      inserted = false;
    }
    if (inserted) return;
    const { selectionStart, selectionEnd } = el;
    el.setRangeText("\t", selectionStart, selectionEnd, "end");
    setDraft(el.value);
  }, []);

  const onEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isSaveShortcut(e)) {
        e.preventDefault();
        void save();
        return;
      }
      if (e.key === "Escape") {
        // The preview modal closes on Escape too. Answering it here first — and stopping
        // it — is what keeps Escape from throwing an unsaved draft away.
        e.preventDefault();
        e.stopPropagation();
        requestLeaveEditing();
        return;
      }
      // Shift+Tab is deliberately left to the browser: it is the keyboard-only way out
      // of a textarea that swallows Tab.
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        insertTab(e.currentTarget);
      }
    },
    [save, requestLeaveEditing, insertTab]
  );

  /**
   * The gutter is one block translated to the textarea's scroll offset, not a second
   * scrollable element: two scrollers drift by a pixel and the numbers stop matching
   * their lines. Written straight to the node so no state churns per frame.
   */
  const onEditorScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const gutter = gutterRef.current;
    if (gutter) gutter.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`;
  }, []);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  if (error) {
    return (
      <ViewerMessage
        title="Preview unavailable"
        hint={error}
        tone="danger"
        onRetry={() => {
          // Clear the message here rather than inside the load effect: retrying has to
          // look like it did something, and an effect that calls setState on entry is
          // exactly the cascade the compiler lint flags.
          setError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  if (!loaded) return <ViewerLoading label="Loading file content…" />;

  const sizeLabel = editing ? formatKb(draftBytes) : formatKb(loaded.totalBytes);
  const lineLabel = editing ? draftLineCount : lines.length;
  const showSizeWarning = !editing && (loaded.truncated || loaded.totalBytes > LARGE_FILE_WARN_BYTES);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 bg-muted/20 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-3.5 w-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
          <Badge tone="accent">{language}</Badge>
          <span className="shrink-0">{lineLabel} lines</span>
          <span className={cn("shrink-0", draftOverLimit && editing && "text-danger-ink")}>
            {sizeLabel}
          </span>
          {!editing && loaded.truncated && (
            <Badge tone="warning">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" /> truncated
            </Badge>
          )}
          {editing && dirty && <Badge tone="warning">Unsaved</Badge>}
          {editing && !dirty && !saving && savedAt !== null && <Badge tone="success">Saved</Badge>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!editing && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setWordWrap((w) => !w)}
              aria-label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            >
              {wordWrap ? (
                <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <AlignLeft className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopy}
            aria-label="Copy contents"
            title="Copy contents"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success-ink" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
          {!editing && editable && (
            <Button variant="secondary" size="sm" onClick={startEditing}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
            </Button>
          )}
          {editing && (
            <>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={saving || !dirty || draftOverLimit}
              >
                {saving ? (
                  <Spinner size="xs" />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {saving ? "Saving" : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={requestLeaveEditing}
                disabled={saving}
                aria-label="Close editor"
                title="Close editor"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </div>

      {showSizeWarning && (
        <div className="flex items-start gap-2 border-b border-warning/10 bg-warning/5 px-4 py-1.5 text-xs text-warning-ink">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            This file is {formatKb(loaded.totalBytes)}.
            {loaded.truncated && ` Showing the first ${formatKb(TEXT_EDIT_MAX_BYTES)}.`}
            {canEdit &&
              !!fileId &&
              !loaded.editable &&
              ` Files over ${formatKb(TEXT_EDIT_MAX_BYTES)} are read-only here — download it to edit it locally.`}
          </span>
        </div>
      )}

      {saveError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-danger/15 bg-danger/5 px-4 py-1.5 text-xs text-danger-ink"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{saveError}</span>
        </div>
      )}

      {confirmDiscard && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/15 bg-warning/5 px-4 py-2 text-xs text-warning-ink">
          <span>This file has unsaved changes.</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" size="sm" onClick={leaveEditing}>
              Discard changes
            </Button>
          </div>
        </div>
      )}

      {editing ? (
        <div className="flex min-h-0 flex-1">
          <div className="relative w-12 shrink-0 select-none overflow-hidden border-r border-border/30 bg-muted/10">
            <div
              ref={gutterRef}
              aria-hidden="true"
              className="whitespace-pre px-2 py-3 text-right font-mono text-[11px] leading-[21px] text-muted-foreground/40"
            >
              {gutterText}
            </div>
          </div>
          <textarea
            ref={editorRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditorKeyDown}
            onScroll={onEditorScroll}
            spellCheck={false}
            /* Off, so one line stays one row and the gutter cannot drift out of step. */
            wrap="off"
            aria-label={`Edit ${fileName}`}
            className="min-w-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-[21px] text-foreground outline-none"
          />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="group absolute left-0 top-0 flex w-full hover:bg-accent/5"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <span className="w-12 shrink-0 select-none pr-4 text-right font-mono text-[11px] leading-[21px] text-muted-foreground/40 group-hover:text-muted-foreground/60">
                  {item.index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 px-4 font-mono text-[13px] leading-[21px]",
                    wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                  )}
                  dangerouslySetInnerHTML={{
                    __html: highlightLine(lines[item.index] ?? "", language) || "&nbsp;",
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
