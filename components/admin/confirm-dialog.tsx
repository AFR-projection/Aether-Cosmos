"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, shows a text input; its value is passed to onConfirm. */
  reason?: { label: string; placeholder?: string; defaultValue?: string };
}

/**
 * A professional confirmation modal that replaces window.confirm/prompt across
 * the admin panel. Supply `reason` to collect a short text (e.g. a suspension
 * reason). `onConfirm` may be async — the dialog shows a spinner and stays open
 * until it resolves, then closes.
 */
export function ConfirmDialog({
  open,
  options,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  options: ConfirmOptions | null;
  onConfirm: (reason?: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset the reason field whenever a new dialog opens.
  useEffect(() => {
    if (open) {
      setReason(options?.reason?.defaultValue ?? "");
      setBusy(false);
    }
  }, [open, options]);

  // Allow Escape to cancel while not mid-submit.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm(options?.reason ? reason.trim() : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      {open && options && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="scrim fixed inset-0 z-[60] flex items-center justify-center p-4"
          onClick={() => !busy && onCancel()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            className="w-full max-w-md rounded-2xl border border-border/50 bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border/40 px-6 py-4">
              <div className="flex items-center gap-3">
                {options.danger && (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                )}
                <h2 className="text-lg font-semibold">{options.title}</h2>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={onCancel}
                disabled={busy}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-4 px-6 py-5">
              <p className="text-sm text-muted-foreground">{options.message}</p>

              {options.reason && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                    {options.reason.label}
                  </label>
                  <Input
                    autoFocus
                    value={reason}
                    placeholder={options.reason.placeholder}
                    onChange={(e) => setReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !busy) handleConfirm();
                    }}
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border/40 px-6 py-4">
              <Button variant="secondary" onClick={onCancel} disabled={busy}>
                {options.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={options.danger ? "destructive" : "default"}
                onClick={handleConfirm}
                disabled={busy}
              >
                {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {options.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Hook that manages a single ConfirmDialog instance imperatively:
 *
 *   const confirm = useConfirm();
 *   ...
 *   confirm.open({ title, message, danger: true }, async (reason) => { ... });
 *   ...
 *   return <>{confirm.element}</>;
 */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [handler, setHandler] = useState<{ fn: (reason?: string) => void | Promise<void> }>({
    fn: () => {},
  });

  function openDialog(opts: ConfirmOptions, onConfirm: (reason?: string) => void | Promise<void>) {
    setOptions(opts);
    setHandler({ fn: onConfirm });
    setOpen(true);
  }

  async function confirm(reason?: string) {
    await handler.fn(reason);
    setOpen(false);
  }

  const element = (
    <ConfirmDialog
      open={open}
      options={options}
      onConfirm={confirm}
      onCancel={() => setOpen(false)}
    />
  );

  return { open: openDialog, element };
}
