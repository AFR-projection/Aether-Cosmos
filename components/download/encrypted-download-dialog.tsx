"use client";

import { useState, useSyncExternalStore } from "react";
import { Lock, Unlock, Loader2, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { saveDecryptedFile } from "@/lib/download/download-actions";
import {
  getPendingEncryptedDownload,
  subscribePendingEncryptedDownload,
  clearPendingEncryptedDownload,
} from "@/lib/download/encrypted-download-store";

const FORM_ID = "encrypted-download-form";

/**
 * Globally-mounted dialog that asks for a passphrase before downloading an
 * end-to-end encrypted file, then decrypts in the browser and saves the real
 * plaintext. Driven by encrypted-download-store; mounted once in Providers.
 */
export function EncryptedDownloadDialog() {
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
      setError(
        err instanceof Error ? err.message : "Could not decrypt — is the passphrase correct?"
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
      title="Encrypted download"
      description={
        <>
          Enter the passphrase to decrypt and save{" "}
          <span className="font-medium text-foreground">{pending.fileName}</span>.
        </>
      }
      footer={
        <Button type="submit" form={FORM_ID} className="w-full" disabled={working || !passphrase}>
          {working ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Unlock className="h-4 w-4" aria-hidden="true" />
          )}
          {working ? "Decrypting…" : "Decrypt and download"}
        </Button>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit}>
        <Field
          label="Passphrase"
          error={error}
          hint="Processed in your browser — it is never sent to the server."
        >
          {(field) => (
            <div className="relative">
              <Input
                {...field}
                type={showPassphrase ? "text" : "password"}
                placeholder="Your encryption passphrase"
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
                aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
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
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
            Nothing was written to disk — try the passphrase again.
          </p>
        )}
      </form>
    </Modal>
  );
}
