"use client";

import { useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Unlock, Loader2, Eye, EyeOff, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveDecryptedFile } from "@/lib/download/download-actions";
import {
  getPendingEncryptedDownload,
  subscribePendingEncryptedDownload,
  clearPendingEncryptedDownload,
} from "@/lib/download/encrypted-download-store";

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
        err instanceof Error ? err.message : "Gagal mendekripsi — passphrase salah?"
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="scrim fixed inset-0 z-[60] flex items-center justify-center p-4"
          onClick={close}
        >
          <motion.div
            initial={{ scale: 0.97, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: 8 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="relative w-full max-w-sm rounded-2xl border border-border/40 bg-card p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={close}
              disabled={working}
              className="absolute right-3 top-3 rounded-lg p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
              aria-label="Tutup"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="mb-3 flex flex-col items-center text-center">
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/20">
                <Lock className="h-7 w-7 text-amber-500" />
              </div>
              <p className="text-sm font-semibold">Download file terenkripsi</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Masukin passphrase buat mendekripsi dan menyimpan
                <span className="mx-1 font-medium text-foreground">
                  {pending.fileName}
                </span>
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-2">
              <div className="relative">
                <Input
                  type={showPassphrase ? "text" : "password"}
                  placeholder="Passphrase"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoFocus
                  disabled={working}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassphrase((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassphrase ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {error && (
                <p className="flex items-center justify-center gap-1 text-xs text-danger">
                  <ShieldAlert className="h-3.5 w-3.5" /> {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={working || !passphrase}
              >
                {working ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Unlock className="mr-2 h-4 w-4" />
                )}
                {working ? "Mendekripsi…" : "Download"}
              </Button>
            </form>

            <p className="mt-3 text-center text-[10px] text-muted-foreground/70">
              Passphrase diproses di browser dan tidak pernah dikirim ke server.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
