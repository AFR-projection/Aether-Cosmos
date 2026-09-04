"use client";

import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Field } from "@/ui/primitives/field";
import { useT } from "@/shared/lib/i18n";

/**
 * Mirrors `STEP_CODE_MAX_LENGTH`, copied rather than imported: the security module that owns
 * the constant also owns the hashing, and pulling it into a client component would drag
 * `node:crypto` into the browser bundle. `account-security-sections.tsx` copies it for the
 * same reason.
 */
const STEP_CODE_MAX = 10;

interface StepCodeDialogProps {
  open: boolean;
  /**
   * Attempts left, or `null` before the server has counted any.
   *
   * The first ask genuinely does not know: the counter only travels on a denial. Showing
   * a guessed number would be a promise the lockout may not keep.
   */
  remaining: number | null;
  /** A previous attempt's refusal, already localised by the caller. */
  error: string | null;
  onSubmit: (code: string) => void;
  onClose: () => void;
}

export function StepCodeDialog({
  open,
  remaining,
  error,
  onSubmit,
  onClose,
}: StepCodeDialogProps) {
  const t = useT();
  const [code, setCode] = useState("");
  const [reveal, setReveal] = useState(false);

  // The count never arrives on its own — the server reports it only while refusing — so it
  // rides along with the refusal instead of claiming a line that would sit empty until then.
  const fieldError =
    error === null
      ? undefined
      : [error, remaining === null ? null : t("backup.stepCode.remaining", { count: remaining })]
          .filter((part): part is string => part !== null)
          .join(" ");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim()) {
      onSubmit(code.trim());
      setCode("");
      setReveal(false);
    }
  };

  const handleClose = () => {
    setCode("");
    setReveal(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      icon={ShieldCheck}
      tone="danger"
      title={t("backup.stepCode.title")}
      description={t("backup.stepCode.body")}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={handleClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="backupStepCodeForm" disabled={code.length === 0}>
            {t("backup.stepCode.submit")}
          </Button>
        </>
      }
    >
      <form id="backupStepCodeForm" onSubmit={handleSubmit}>
        <Field label={t("backup.stepCode.label")} error={fieldError}>
          {(field) => (
            <div className="relative">
              <Input
                {...field}
                type={reveal ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                maxLength={STEP_CODE_MAX}
                placeholder={t("backup.stepCode.placeholder")}
                value={code}
                // Digits only on the way in, so the field can never hold a value the
                // server is certain to reject — and a typo cannot cost an attempt.
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="pr-10 font-mono tracking-[0.3em]"
              />
              <button
                type="button"
                onClick={() => setReveal(!reveal)}
                aria-label={t(reveal ? "backup.stepCode.hide" : "backup.stepCode.show")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {reveal ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          )}
        </Field>
      </form>
    </Modal>
  );
}
