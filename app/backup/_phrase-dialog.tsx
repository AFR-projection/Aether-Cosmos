"use client";

import { useState } from "react";
import { Copy, Check, KeyRound } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";

interface PhraseDialogProps {
  open: boolean;
  phrase: string;
  onClose: () => void;
}

/**
 * The one dialog on this page that cannot be reopened.
 *
 * Only the sealed wrapping key is stored, so nothing on the server can produce these words a
 * second time. That is why the dialog is not dismissible: Escape, the scrim and the ✕ are all
 * off, and the only way out is the button behind the acknowledgement — a stray keypress must
 * not be able to cost the account its independent recovery path.
 */
export function PhraseDialog({ open, phrase, onClose }: PhraseDialogProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const words = phrase.length === 0 ? [] : phrase.split(" ");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A denied clipboard permission or a non-secure origin. The words are on screen and the
      // checkbox below is what actually gates the dialog, so leaving the button in its idle
      // state is the whole report needed: it says "that did not happen".
      setCopied(false);
    }
  };

  const handleClose = () => {
    setAcknowledged(false);
    setCopied(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      dismissible={false}
      size="lg"
      icon={KeyRound}
      tone="warning"
      title={t("backup.phrase.title")}
      description={t("backup.phrase.lead", { count: words.length })}
      footer={
        <Button onClick={handleClose} disabled={!acknowledged}>
          {t("backup.phrase.done")}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
          <h3 className="mb-1 text-sm font-semibold text-warning-ink">
            {t("backup.phrase.warnTitle")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("backup.phrase.warnBody")}
          </p>
        </div>

        <div className="rounded-xl border border-border/60 bg-surface p-4">
          <ol className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {words.map((word, i) => (
              <li key={`${i}-${word}`} className="flex items-baseline gap-2">
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="font-mono text-sm text-foreground">{word}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex justify-end border-t border-border/60 pt-3">
            <Button onClick={handleCopy} size="sm" variant="ghost">
              {copied ? (
                <Check className="h-4 w-4 text-success-ink" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? t("common.copied") : t("backup.phrase.copy")}
            </Button>
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          <span className="text-sm leading-relaxed text-foreground">
            {t("backup.phrase.ack")}
          </span>
        </label>
      </div>
    </Modal>
  );
}
