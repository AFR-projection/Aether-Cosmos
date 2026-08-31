"use client";

import * as React from "react";
import { AlertTriangle, Pencil } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Field } from "@/ui/primitives/field";
import { Modal } from "@/ui/primitives/modal";
import { useT } from "@/shared/lib/i18n";

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

/** Remounts per request, so the input state starts from `initialValue` without
 *  a reset-in-effect. */
function PromptForm({ state }: { state: PromptState }) {
  const t = useT();
  const [value, setValue] = React.useState(state.initialValue ?? "");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    // Runs after the modal has moved focus here (child effects fire first).
    const raf = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const initial = state.initialValue ?? "";
      // A rename keeps the extension: pre-select the stem only.
      if (state.selectStem && initial.includes(".")) {
        el.setSelectionRange(0, initial.lastIndexOf("."));
      } else {
        el.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [state.initialValue, state.selectStem]);

  const trimmed = value.trim();

  function submit() {
    if (!trimmed) return;
    state.resolve(trimmed);
  }

  return (
    <Modal
      open
      onClose={() => state.resolve(null)}
      title={state.title}
      icon={Pencil}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => state.resolve(null)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!trimmed} onClick={submit}>
            {state.confirmText ?? t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={state.label ?? t("common.name")}>
        {(field) => (
          <Input
            {...field}
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={state.placeholder}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
      </Field>
    </Modal>
  );
}

export function PromptDialog({ state }: { state: PromptState | null }) {
  if (!state) return null;
  return <PromptForm state={state} />;
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

function ConfirmPanel({ state }: { state: ConfirmState }) {
  const t = useT();
  // Focus lands on the confirm button, so Enter still confirms — without a
  // window-wide Enter listener that could fire from anywhere on the page.
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);

  return (
    <Modal
      open
      onClose={() => state.resolve(false)}
      title={state.title}
      description={state.message}
      icon={AlertTriangle}
      tone={state.danger ? "danger" : "accent"}
      size="sm"
      initialFocusRef={confirmRef}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => state.resolve(false)}>
            {state.cancelText ?? t("common.cancel")}
          </Button>
          <Button
            ref={confirmRef}
            size="sm"
            variant={state.danger ? "destructive" : "default"}
            onClick={() => state.resolve(true)}
          >
            {state.confirmText ?? t("common.confirm")}
          </Button>
        </>
      }
    />
  );
}

export function ConfirmDialog({ state }: { state: ConfirmState | null }) {
  if (!state) return null;
  return <ConfirmPanel state={state} />;
}

// ── Hook: imperative prompt()/confirm() replacements ─────────────────────────

export function useDialogs() {
  const [prompt, setPrompt] = React.useState<PromptState | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmState | null>(null);

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
