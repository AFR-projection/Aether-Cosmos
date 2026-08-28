"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Lock, Pencil, Save } from "lucide-react";
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

type SaveState = "clean" | "dirty" | "saving" | "error";

interface SharedNoteViewProps {
  token: string;
  content: unknown;
  /** When true the note is editable and edits are saved back via the token. */
  canEdit: boolean;
}

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

const DRAFT_THROTTLE_MS = 700;

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Renders a shared note's Tiptap body. Read-only for "view" shares; for "edit" shares it is
 * editable and saved back with an explicit Save button or Ctrl/Cmd+S (PUT
 * /api/shared/[token]) — never automatically. Autosave used to cancel its own pending write
 * when the page went away, which silently dropped whatever had just been typed; edits now
 * also survive a crash as a local draft that is never uploaded on its own. Uses the same
 * extension set as the owner's editor so content round-trips faithfully.
 */
export function SharedNoteView({ token, content, canEdit }: SharedNoteViewProps) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [draftOffer, setDraftOffer] = useState<NoteDraft | null>(null);
  const [isMac] = useState(isMacPlatform);

  const draftId = `shared:${token}`;
  const baselineRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const latestJsonRef = useRef<unknown>(undefined);
  const lastDraftWrite = useRef(0);

  const editor = useEditor({
    immediatelyRender: false,
    editable: canEdit,
    extensions: [
      StarterKit.configure({ link: { openOnClick: true } }),
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      Color,
    ],
    content: (content as Record<string, unknown>) ?? "",
    editorProps: {
      attributes: {
        // dvh, not vh: on a phone `vh` counts the browser's own chrome, so the reserved
        // height pushed the note's last lines under the address bar.
        class: "prose prose-sm dark:prose-invert max-w-none min-h-[60dvh] focus:outline-none",
      },
    },
    // Seeding the baseline here — rather than in an effect — means the very first `update`
    // already has something correct to compare against.
    onCreate: ({ editor: created }) => {
      const json = created.getJSON();
      baselineRef.current = serializeDoc(json);
      latestJsonRef.current = json;
      if (!canEdit) return;
      const storage = getStorage();
      const draft = storage ? readDraft(storage, draftId) : null;
      if (!storage || !draft) return;
      if (shouldOfferDraft(draft, json)) setDraftOffer(draft);
      else clearDraft(storage, draftId);
    },
  });

  // Keep editability in sync if the prop ever changes.
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  useEffect(() => {
    if (!editor || !canEdit) return;
    const handler = () => {
      if (editor.isDestroyed) return;
      const json = editor.getJSON();
      const changed = serializeDoc(json) !== baselineRef.current;
      latestJsonRef.current = json;
      dirtyRef.current = changed;
      setDirty(changed);
      setSaveError(null);

      const storage = getStorage();
      if (!storage) return;
      if (!changed) {
        clearDraft(storage, draftId);
        return;
      }
      const now = Date.now();
      if (now - lastDraftWrite.current < DRAFT_THROTTLE_MS) return;
      lastDraftWrite.current = now;
      writeDraft(storage, draftId, json, now);
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, canEdit, draftId]);

  // Unsaved work must not vanish with the page: warn, and leave a local draft behind.
  useEffect(() => {
    if (!canEdit) return;
    const flush = () => {
      const storage = getStorage();
      if (!storage || !dirtyRef.current || latestJsonRef.current === undefined) return;
      writeDraft(storage, draftId, latestJsonRef.current);
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
      flush();
    };
  }, [canEdit, draftId]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!editor || editor.isDestroyed || !canEdit) return false;
    if (savingRef.current) return false;
    const json = editor.getJSON();
    const snapshot = serializeDoc(json);
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/shared/${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: json }),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || body.success === false) {
        setSaveError(body.error ?? "Couldn't save.");
        return false;
      }
      baselineRef.current = snapshot;
      setLastSavedAt(Date.now());
      const current = editor.isDestroyed ? json : editor.getJSON();
      const stillDirty = serializeDoc(current) !== snapshot;
      dirtyRef.current = stillDirty;
      setDirty(stillDirty);
      const storage = getStorage();
      if (storage) {
        if (stillDirty) writeDraft(storage, draftId, current);
        else clearDraft(storage, draftId);
      }
      return true;
    } catch {
      setSaveError("Couldn't save. Check your connection.");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [editor, token, draftId, canEdit]);

  useEffect(() => {
    if (!canEdit) return;
    const handler = (e: KeyboardEvent) => {
      if (!isSaveShortcut(e)) return;
      e.preventDefault();
      void saveNow();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNow, canEdit]);

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
    if (storage) clearDraft(storage, draftId);
    setDraftOffer(null);
  }, [draftId]);

  const saveState: SaveState = saving ? "saving" : saveError ? "error" : dirty ? "dirty" : "clean";

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
      {canEdit && draftOffer && (
        <div className="note-banner note-banner--card mb-4" data-tone="warning" role="status">
          <AlertTriangle aria-hidden className="note-banner__icon h-4 w-4" />
          <span className="min-w-0 flex-1">
            Unsaved local changes from <strong>{formatClock(draftOffer.savedAt)}</strong> were found
            in this browser. Restore them?
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

      <div className="mb-4 flex flex-wrap items-center justify-end gap-2 text-xs">
        {canEdit ? (
          <>
            {/* Reinforcement only — the status line beside it says so in words, and the
                Save button reads "Save" rather than "Saved". */}
            {dirty && <span className="note-dirty-dot" title="Unsaved changes" aria-hidden />}
            {/* Nothing autosaves here, so this line is the only account of whether the
                work reached the server: it has to be announced, not just drawn. */}
            <span
              role="status"
              aria-live="polite"
              className="mr-auto text-xs text-muted-foreground"
            >
              {saveError
                ? saveError
                : dirty
                  ? `Unsaved · press ${isMac ? "⌘S" : "Ctrl+S"}`
                  : lastSavedAt
                    ? `Saved at ${formatClock(lastSavedAt)}`
                    : "No changes"}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 font-medium text-accent-ink">
              <Pencil aria-hidden className="h-3 w-3" /> Editable
            </span>
            <button
              type="button"
              data-state={saveState}
              className="note-save-btn"
              onClick={() => void saveNow()}
              disabled={saveState === "clean" || saveState === "saving"}
              aria-busy={saveState === "saving"}
              title={`Save (${isMac ? "⌘" : "Ctrl+"}S)`}
            >
              {saveState === "saving" ? (
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
              ) : saveState === "clean" ? (
                <Check aria-hidden className="h-3.5 w-3.5" />
              ) : saveState === "error" ? (
                <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
              ) : (
                <Save aria-hidden className="h-3.5 w-3.5" />
              )}
              {saveState === "saving"
                ? "Saving…"
                : saveState === "error"
                  ? "Retry save"
                  : saveState === "clean"
                    ? "Saved"
                    : "Save"}
              {saveState === "dirty" && (
                <kbd className="note-save-kbd">{isMac ? "⌘S" : "Ctrl+S"}</kbd>
              )}
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/20 px-2 py-0.5 font-medium text-muted-foreground">
            <Lock aria-hidden className="h-3 w-3" /> Read-only
          </span>
        )}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
