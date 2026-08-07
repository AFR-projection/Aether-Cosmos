"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Upload, FileText, FolderPlus, X } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { emitQuickAction, type QuickAction } from "@/lib/system/quick-actions";

interface QuickActionsSheetProps {
  open: boolean;
  onClose: () => void;
}

const ACTIONS: { key: QuickAction; label: string; desc: string; icon: typeof Upload }[] = [
  { key: "upload", label: "Upload File", desc: "Pilih file dari perangkat", icon: Upload },
  { key: "note", label: "Note Baru", desc: "Tulis catatan cepat", icon: FileText },
  { key: "folder", label: "Folder Baru", desc: "Buat folder kosong", icon: FolderPlus },
];

/**
 * Bottom action sheet for the mobile "+" tab. Each action delegates to the
 * FileBrowser's existing handlers via a window event; if we're not on /files
 * yet, navigate there first and fire the event on the next tick so the freshly
 * mounted browser can catch it.
 */
export function QuickActionsSheet({ open, onClose }: QuickActionsSheetProps) {
  const router = useRouter();
  const pathname = usePathname();

  function run(action: QuickAction) {
    onClose();
    if (pathname === "/files") {
      emitQuickAction(action);
    } else {
      router.push("/files");
      // Give the FileBrowser a moment to mount its listener before firing.
      setTimeout(() => emitQuickAction(action), 350);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="scrim fixed inset-0 z-[60] lg:hidden"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 34, stiffness: 320 }}
            className="chrome-surface fixed inset-x-0 bottom-0 z-[61] rounded-t-3xl border-t border-border/60 pb-safe lg:hidden"
            role="dialog"
            aria-label="Aksi cepat"
          >
            {/* Grabber */}
            <div className="flex justify-center pt-3 pb-1">
              <span className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
            </div>
            <div className="flex items-center justify-between px-5 pb-2 pt-1">
              <h3 className="text-sm font-semibold">Buat Baru</h3>
              <button
                onClick={onClose}
                className="tap flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/40"
                aria-label="Tutup"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-3 pb-4">
              {ACTIONS.map(({ key, label, desc, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => run(key)}
                  className="tap flex w-full items-center gap-3.5 rounded-2xl px-3 py-3 text-left hover:bg-muted/40"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-muted-foreground/70">{desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
