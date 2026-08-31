"use client";

import { useState, useSyncExternalStore } from "react";
import { Lock, Unlock, Loader2, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Field } from "@/ui/primitives/field";
import { Modal } from "@/ui/primitives/modal";
import { saveDecryptedFile } from "@files/application/commands/download-actions";
import { errorCodeMessage, hasKey, useT } from "@/shared/lib/i18n";
import {
  getPendingEncryptedDownload,
  subscribePendingEncryptedDownload,
  clearPendingEncryptedDownload,
} from "@files/application/commands/encrypted-download-store";

const FORM_ID = "encrypted-download-form";

/**
 * Globally-mounted dialog that asks for a passphrase before downloading an
 * end-to-end encrypted file, then decrypts in the browser and saves the real
 * plaintext. Driven by encrypted-download-store; mounted once in Providers.
 */
export function EncryptedDownloadDialog() {
  const t = useT();
  const pending = useSyncExternalStore(
    subscribePendingEncryptedDownload,
    getPendingEncryptedDownload,
    () => null
  );

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (working) return;
    setPassphrase("");
    setShowPassphrase(false);
    setError(null);
    clearPendingEncryptedDownload();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pending || !passphrase.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await saveDecryptedFile(
        pending.fileId,
        pending.fileName,
        pending.mimeType,
        pending.meta,
        passphrase
      );
      // Success — reset and close.
      setPassphrase("");
      setShowPassphrase(false);
      clearPendingEncryptedDownload();
    } catch (err) {
      // `saveDecryptedFile` throws a stable code for the failures it owns; a
      // wrong passphrase surfaces as a Web Crypto exception whose message is
      // browser prose. Only a code becomes a sentence — everything else is the
      // one thing that is true either way, said in the reader's language.
      const code = err instanceof Error ? err.message : "";
      setError(
        hasKey(`errors.code.${code}`)
          ? errorCodeMessage(code, t)
          : t("files.preview.unlockFailed")
      );
    } finally {
      setWorking(false);
    }
  }

  if (!pending) return null;

  return (
    <Modal
      open
      onClose={close}
      dismissible={!working}
      icon={Lock}
      tone="warning"
      size="sm"
      title={t("files.decrypt.title")}
      description={t("files.decrypt.description", { name: pending.fileName })}
      footer={
        <Button type="submit" form={FORM_ID} className="w-full" disabled={working || !passphrase}>
          {working ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Unlock className="h-4 w-4" aria-hidden="true" />
          )}
          {t(working ? "files.preview.decrypting" : "files.decrypt.submit")}
        </Button>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit}>
        <Field
          label={t("files.preview.passphrase")}
          error={error}
          hint={t("files.decrypt.hint")}
        >
          {(field) => (
            <div className="relative">
              <Input
                {...field}
                type={showPassphrase ? "text" : "password"}
                placeholder={t("files.decrypt.passphrasePlaceholder")}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoFocus
                autoComplete="off"
                disabled={working}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassphrase((v) => !v)}
                aria-label={t(
                  showPassphrase ? "files.preview.hidePassphrase" : "files.preview.showPassphrase"
                )}
                aria-pressed={showPassphrase}
                className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {showPassphrase ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          )}
        </Field>
        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-danger-ink" aria-hidden="true" />
            {t("files.decrypt.untouched")}
          </p>
        )}
      </form>
    </Modal>
  );
}
