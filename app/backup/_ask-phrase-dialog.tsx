"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Field } from "@/ui/primitives/field";
import { useT } from "@/shared/lib/i18n";

interface AskPhraseDialogProps {
  open: boolean;
  /**
   * A previous attempt's refusal, already localised by the caller.
   *
   * Deliberately the one generic sentence for every cause — wrong phrase, wrong account,
   * truncated file. Telling those apart would tell an attacker which half to keep trying.
   */
  error: string | null;
  onSubmit: (phrase: string) => void;
  onClose: () => void;
}

export function AskPhraseDialog({ open, error, onSubmit, onClose }: AskPhraseDialogProps) {
  const t = useT();
  const [phrase, setPhrase] = useState("");
  const [reveal, setReveal] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Collapse the whitespace here rather than trusting the paste. The server normalises the
    // same way before deriving the key, so this changes no outcome — but the phrase travels
    // as an HTTP header, and a header value holding the newline from a two-line note makes
    // the browser refuse to send the request at all.
    const cleaned = phrase.trim().replace(/\s+/g, " ");
    if (cleaned.length > 0) {
      onSubmit(cleaned);
      setPhrase("");
      setReveal(false);
    }
  };

  const handleClose = () => {
    setPhrase("");
    setReveal(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      icon={KeyRound}
      title={t("backup.ask.title")}
      description={t("backup.ask.body")}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={handleClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="backupAskPhraseForm" disabled={phrase.trim().length === 0}>
            {t("backup.ask.submit")}
          </Button>
        </>
      }
    >
      <form id="backupAskPhraseForm" onSubmit={handleSubmit}>
        <Field label={t("backup.ask.label")} error={error ?? undefined}>
          {(field) => (
            <div className="relative">
              <Input
                {...field}
                type={reveal ? "text" : "password"}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t("backup.ask.placeholder")}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setReveal(!reveal)}
                aria-label={t(reveal ? "backup.ask.hide" : "backup.ask.show")}
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
