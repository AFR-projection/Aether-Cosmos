"use client";

import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Lock, Eye, EyeOff, ShieldCheck,
  AlertTriangle, Check, Copy, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  validatePasswordStrength,
  getPasswordStrengthLabel,
} from "@/lib/security/password-policy";

interface EncryptionSetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the confirmed passphrase when the user enables encryption. */
  onConfirm: (passphrase: string) => void;
}

const STRENGTH_BARS = [0, 1, 2, 3];

const STRENGTH_COLOR: Record<number, string> = {
  0: "bg-red-500",
  1: "bg-orange-500",
  2: "bg-yellow-500",
  3: "bg-emerald-500",
  4: "bg-green-500",
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
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset all state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setPassphrase("");
      setConfirm("");
      setShow(false);
      setAcknowledged(false);
      setCopied(false);
    }
  }, [open]);

  const strength = useMemo(
    () => (passphrase ? validatePasswordStrength(passphrase) : null),
    [passphrase]
  );

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const canSubmit =
    passphrase.length >= 8 &&
    confirm === passphrase &&
    acknowledged;

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
      /* clipboard unavailable — user can read it since show is on after generate */
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;
    onConfirm(passphrase);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="scrim fixed inset-0 z-[70] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="relative border-b border-border bg-gradient-to-br from-accent/10 to-transparent px-6 py-5">
              <button
                onClick={onClose}
                className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15">
                  <Lock className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <h2 className="text-base font-semibold">Encrypt uploads</h2>
                  <p className="text-xs text-muted-foreground">
                    End-to-end AES-256 · encrypted in your browser
                  </p>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="space-y-4 px-6 py-5">
              {/* Passphrase */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Passphrase
                </label>
                <div className="relative">
                  <Input
                    type={show ? "text" : "password"}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="At least 8 characters"
                    autoFocus
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                {/* Strength meter */}
                {strength && (
                  <div className="space-y-1 pt-1">
                    <div className="flex gap-1">
                      {STRENGTH_BARS.map((i) => (
                        <div
                          key={i}
                          className={cn(
                            "h-1 flex-1 rounded-full transition-colors",
                            i < strength.score ? STRENGTH_COLOR[strength.score] : "bg-muted"
                          )}
                        />
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Strength: <span className="font-medium">{getPasswordStrengthLabel(strength.score)}</span>
                    </p>
                  </div>
                )}
                {tooShort && (
                  <p className="text-[11px] text-orange-500">Use at least 8 characters.</p>
                )}
              </div>

              {/* Confirm */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Confirm passphrase
                </label>
                <Input
                  type={show ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter to confirm"
                  className={cn(mismatch && "border-red-500/60 focus-visible:ring-red-500/30")}
                />
                {mismatch && (
                  <p className="text-[11px] text-red-500">Passphrases don&apos;t match.</p>
                )}
                {confirm.length > 0 && !mismatch && (
                  <p className="flex items-center gap-1 text-[11px] text-emerald-500">
                    <Check className="h-3 w-3" /> Passphrases match
                  </p>
                )}
              </div>

              {/* Generate / copy row */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={handleGenerate}
                >
                  <Sparkles className="h-3.5 w-3.5" /> Generate strong
                </Button>
                {passphrase && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={handleCopy}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </div>

              {/* Warning + acknowledgement */}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="flex gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="space-y-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Your passphrase never leaves this device. We <span className="font-semibold text-foreground">cannot recover it</span>.
                      If you lose it, the encrypted files are gone forever.
                    </p>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 accent-accent"
                      />
                      <span className="text-[11px] text-foreground">
                        I&apos;ve saved my passphrase somewhere safe.
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" className="gap-1.5" disabled={!canSubmit} onClick={handleSubmit}>
                <ShieldCheck className="h-4 w-4" /> Enable encryption
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
