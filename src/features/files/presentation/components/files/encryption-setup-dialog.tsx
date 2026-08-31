"use client";

import { useMemo, useState } from "react";
import {
  Lock, Eye, EyeOff, ShieldCheck,
  AlertTriangle, Check, Copy, Sparkles,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Field } from "@/ui/primitives/field";
import { Modal } from "@/ui/primitives/modal";
import { cn } from "@/shared/lib/utils";
import { passwordStrengthKey, useT } from "@/shared/lib/i18n";
import { validatePasswordStrength } from "@/shared/lib/security/password-policy";

interface EncryptionSetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the confirmed passphrase when the user enables encryption. */
  onConfirm: (passphrase: string) => void;
}

const STRENGTH_BARS = [0, 1, 2, 3];

/** Semantic tones only — the label next to the meter carries the same meaning
 *  for anyone who cannot separate the colours. */
const STRENGTH_TONE: Record<number, string> = {
  0: "bg-danger",
  1: "bg-danger",
  2: "bg-warning",
  3: "bg-success",
  4: "bg-success",
};

/** Generate a strong random passphrase (base64url, ~24 chars ≈ 144 bits). */
function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Professional passphrase setup for client-side (AES-GCM) upload encryption.
 * Guards the two ways users lose data: a weak passphrase, and a mistyped one
 * (confirmation field). Makes the "forget it = files gone forever" reality
 * explicit, and offers a strong generated passphrase as an escape hatch.
 */
export function EncryptionSetupDialog({ open, onClose, onConfirm }: EncryptionSetupDialogProps) {
  // Mounted per opening, so every field starts empty without a reset effect —
  // a half-remembered passphrase must never survive a cancel.
  if (!open) return null;
  return <EncryptionSetupForm onClose={onClose} onConfirm={onConfirm} />;
}

function EncryptionSetupForm({
  onClose,
  onConfirm,
}: Omit<EncryptionSetupDialogProps, "open">) {
  const t = useT();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const strength = useMemo(
    () => (passphrase ? validatePasswordStrength(passphrase) : null),
    [passphrase]
  );

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const canSubmit = passphrase.length >= 8 && confirm === passphrase && acknowledged;

  function handleGenerate() {
    const p = generatePassphrase();
    setPassphrase(p);
    setConfirm(p);
    setShow(true);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(passphrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value is on screen while show is on */
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;
    onConfirm(passphrase);
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      icon={Lock}
      title={t("files.encrypt.title")}
      description={t("files.encrypt.description")}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> {t("files.encrypt.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label={t("files.encrypt.passphrase")}
          error={tooShort ? t("files.encrypt.tooShort") : undefined}
        >
          {(field) => (
            <div className="relative">
              <Input
                {...field}
                type={show ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("files.encrypt.passphrasePlaceholder")}
                autoComplete="new-password"
                autoFocus
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? t("files.encrypt.hidePassphrase") : t("files.encrypt.showPassphrase")}
                aria-pressed={show}
                className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {show ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          )}
        </Field>

        {strength && (
          <div className="space-y-1.5">
            <div className="flex gap-1" aria-hidden="true">
              {STRENGTH_BARS.map((i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-200",
                    i < strength.score ? STRENGTH_TONE[strength.score] : "bg-muted"
                  )}
                />
              ))}
            </div>
            {/* One interpolated sentence rather than a bolded level after a
                label: the colon and the word order belong to each language. */}
            <p className="text-xs text-muted-foreground" role="status">
              {t("common.passwordStrength.summary", {
                level: t(passwordStrengthKey(strength.score)),
              })}
            </p>
          </div>
        )}

        <Field
          label={t("files.encrypt.confirm")}
          error={mismatch ? t("files.encrypt.mismatch") : undefined}
          hint={
            confirm.length > 0 && !mismatch ? (
              <span className="flex items-center gap-1 text-success-ink">
                <Check className="h-3 w-3" aria-hidden="true" /> {t("files.encrypt.match")}
              </span>
            ) : undefined
          }
        >
          {(field) => (
            <Input
              {...field}
              type={show ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t("files.encrypt.confirmPlaceholder")}
              autoComplete="new-password"
              className={cn(mismatch && "border-danger/60 focus-visible:ring-danger/25")}
            />
          )}
        </Field>

        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={handleGenerate}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> {t("files.encrypt.generate")}
          </Button>
          {passphrase && (
            <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
              {copied ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          )}
        </div>

        <div className="rounded-xl border border-warning/30 bg-warning/5 p-3">
          <div className="flex gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-ink" aria-hidden="true" />
            <div className="space-y-2">
              {/* One sentence: "cannot recover it" was a bolded clause, and that
                  emphasis cannot survive a sentence that reorders per language. */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("files.encrypt.warning")}
              </p>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                />
                <span className="text-xs leading-relaxed text-foreground">
                  {t("files.encrypt.acknowledge")}
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
