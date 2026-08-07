"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ── Prompt (text input) ──────────────────────────────────────────────────────

export type PromptRequest = {
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  /** Select the filename stem (before the last dot) instead of the whole value. */
  selectStem?: boolean;
};

type PromptState = PromptRequest & {
  resolve: (value: string | null) => void;
};

export function PromptDialog({ state }: { state: PromptState | null }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state) return;
    setValue(state.initialValue ?? "");
    // Focus + smart-select on open (stem for filenames, so the extension stays).
    const id = window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const v = state.initialValue ?? "";
      if (state.selectStem && v.includes(".")) {
        el.setSelectionRange(0, v.lastIndexOf("."));
      } else {
        el.select();
      }
    }, 40);
    return () => window.clearTimeout(id);
  }, [state]);

  if (!state) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    state.resolve(trimmed);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="scrim fixed inset-0 z-[80] flex items-center justify-center p-4"
        onClick={() => state.resolve(null)}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.18 }}
          className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative border-b border-border bg-gradient-to-br from-accent/10 to-transparent px-5 py-4">
            <button
              onClick={() => state.resolve(null)}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15">
                <Pencil className="h-4 w-4 text-accent" />
              </div>
              <h2 className="text-sm font-semibold">{state.title}</h2>
            </div>
          </div>

          <div className="px-5 py-4">
            {state.label && (
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {state.label}
              </label>
            )}
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") { e.preventDefault(); state.resolve(null); }
              }}
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button variant="ghost" size="sm" onClick={() => state.resolve(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!value.trim()} onClick={submit}>
              {state.confirmText ?? "Save"}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── Confirm (destructive / yes-no) ───────────────────────────────────────────

export type ConfirmRequest = {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type ConfirmState = ConfirmRequest & {
  resolve: (ok: boolean) => void;
};

export function ConfirmDialog({ state }: { state: ConfirmState | null }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!state) return;
    const id = window.setTimeout(() => confirmRef.current?.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") state.resolve(false);
      if (e.key === "Enter") state.resolve(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [state]);

  if (!state) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="scrim fixed inset-0 z-[80] flex items-center justify-center p-4"
        onClick={() => state.resolve(false)}
      >
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.18 }}
          className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 pt-5">
            <div className="flex gap-3">
              <div
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                  state.danger ? "bg-red-500/15 text-red-500" : "bg-accent/15 text-accent"
                )}
              >
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <h2 className="text-sm font-semibold">{state.title}</h2>
                {state.message && (
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {state.message}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button variant="ghost" size="sm" onClick={() => state.resolve(false)}>
              {state.cancelText ?? "Cancel"}
            </Button>
            <Button
              ref={confirmRef}
              size="sm"
              variant={state.danger ? "destructive" : "default"}
              onClick={() => state.resolve(true)}
            >
              {state.confirmText ?? "Confirm"}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── Hook: imperative prompt()/confirm() replacements ─────────────────────────

export function useDialogs() {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const askPrompt = (req: PromptRequest) =>
    new Promise<string | null>((resolve) => {
      setPrompt({
        ...req,
        resolve: (v) => {
          setPrompt(null);
          resolve(v);
        },
      });
    });

  const askConfirm = (req: ConfirmRequest) =>
    new Promise<boolean>((resolve) => {
      setConfirm({
        ...req,
        resolve: (ok) => {
          setConfirm(null);
          resolve(ok);
        },
      });
    });

  const dialogs = (
    <>
      <PromptDialog state={prompt} />
      <ConfirmDialog state={confirm} />
    </>
  );

  return { askPrompt, askConfirm, dialogs };
}
