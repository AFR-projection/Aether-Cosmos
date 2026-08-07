"use client";

import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Copy, Check, Link, Clock, Eye, Shield, Infinity,
  Globe, Lock, Sparkles, Timer, ExternalLink,
  FileText, Image, Film, Music, File, Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface ShareDialogProps {
  fileId: string;
  fileName: string;
  fileType?: string;
  /**
   * Whether the shared file is a note. Only notes have an editor, so only notes
   * can honor an "edit" share — for any other file type the Can Edit option is
   * hidden and the share is forced to view-only.
   */
  isNote?: boolean;
  onClose: () => void;
}

type Step = "configure" | "created";

interface DurationPreset {
  label: string;
  minutes: number | null;
  icon: typeof Clock;
}

const DURATION_PRESETS: DurationPreset[] = [
  { label: "1 menit", minutes: 1, icon: Timer },
  { label: "5 menit", minutes: 5, icon: Timer },
  { label: "30 menit", minutes: 30, icon: Timer },
  { label: "1 jam", minutes: 60, icon: Clock },
  { label: "24 jam", minutes: 1440, icon: Clock },
  { label: "7 hari", minutes: 10080, icon: Clock },
  { label: "Tak terbatas", minutes: null, icon: Infinity },
];

const ACCESS_PRESETS = [
  { value: 1, label: "1x" },
  { value: 3, label: "3x" },
  { value: 5, label: "5x" },
  { value: 10, label: "10x" },
  { value: 25, label: "25x" },
  { value: 50, label: "50x" },
  { value: null, label: "Unlimited" },
];

function getFileIcon(mime?: string) {
  if (!mime) return File;
  if (mime.startsWith("image/")) return Image;
  if (mime.startsWith("video/")) return Film;
  if (mime.startsWith("audio/")) return Music;
  if (mime.includes("pdf")) return FileText;
  return File;
}

function FileIconDisplay({ mime, className }: { mime?: string; className?: string }) {
  const Icon = getFileIcon(mime);
  return <Icon className={className} />;
}

function formatExpiry(minutes: number | null): string {
  if (minutes === null) return "Tidak pernah kadaluarsa";
  if (minutes < 60) return `Kadaluarsa dalam ${minutes} menit`;
  if (minutes < 1440) return `Kadaluarsa dalam ${Math.floor(minutes / 60)} jam`;
  return `Kadaluarsa dalam ${Math.floor(minutes / 1440)} hari`;
}

function getRelativeTime(minutes: number): string {
  const now = Date.now();
  const expiry = now + minutes * 60000;
  const diff = expiry - now;
  if (diff < 3600000) return `${Math.round(diff / 60000)} menit`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} jam`;
  return `${Math.round(diff / 86400000)} hari`;
}

export function ShareDialog({ fileId, fileName, fileType, isNote = false, onClose }: ShareDialogProps) {
  const [step, setStep] = useState<Step>("configure");
  const [duration, setDuration] = useState<number | null>(60);
  const [maxAccess, setMaxAccess] = useState<number | null>(5);
  const [customAccess, setCustomAccess] = useState("");
  const [showCustomAccess, setShowCustomAccess] = useState(false);
  // Only notes are editable, so only notes can carry an "edit" permission.
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Guard against a stale "edit" selection if a non-note ever reuses this
  // dialog — the server would ignore it, but we never want to send it.
  const effectivePermission = isNote ? permission : "view";

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError("");
    const body: Record<string, unknown> = { fileId, permission: effectivePermission };
    if (duration !== null) body.expiresInMinutes = duration;
    if (maxAccess !== null) body.maxAccessCount = maxAccess;
    const res = await apiFetch<{ shareUrl: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.data?.shareUrl) {
      setShareUrl(res.data.shareUrl);
      setStep("created");
    } else {
      setError(res.error ?? "Gagal membuat link share");
    }
    setLoading(false);
  }, [fileId, effectivePermission, duration, maxAccess]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [shareUrl]);

  // Calculate visual timeline position
  const timelinePct = useMemo(() => {
    if (duration === null) return 100;
    const max = 10080; // 7 days
    return Math.min((duration / max) * 100, 100);
  }, [duration]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="scrim fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.92, opacity: 0, y: 20 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          className="relative w-full max-w-lg rounded-2xl border border-border/50 bg-card shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Gradient top bar */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-violet-500 via-accent to-cyan-500" />

          {/* Close */}
          <Button variant="ghost" size="icon" className="absolute top-3 right-3 h-8 w-8 z-10" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>

          <AnimatePresence mode="wait">
            {step === "configure" ? (
              /* ════════ CONFIGURE STEP ════════ */
              <motion.div
                key="configure"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: -20 }}
                className="p-6"
              >
                {/* Header */}
                <div className="flex items-center gap-3 mb-6 pr-8">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-accent/20 border border-accent/20">
                    <FileIconDisplay mime={fileType} className="h-5 w-5 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-base font-bold tracking-tight">Buat Link Share</h3>
                    <p className="text-xs text-muted-foreground/70 truncate">{fileName}</p>
                  </div>
                </div>

                {/* Permission Toggle */}
                <div className="mb-5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2.5">
                    <Shield className="h-3.5 w-3.5" />
                    Permission
                  </label>
                  {isNote ? (
                    <div className="flex gap-2">
                      {[
                        { value: "view" as const, label: "View Only", desc: "Recipient can only view", icon: Eye },
                        { value: "edit" as const, label: "Can Edit", desc: "Recipient can modify", icon: Pencil },
                      ].map(({ value, label, desc, icon: Icon }) => (
                        <button
                          key={value}
                          onClick={() => setPermission(value)}
                          className={cn(
                            "flex-1 flex items-center gap-2.5 rounded-xl border p-3 transition-all",
                            permission === value
                              ? "border-accent bg-accent/10"
                              : "border-border/40 hover:border-border/70 hover:bg-accent/5"
                          )}
                        >
                          <div className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                            permission === value ? "bg-accent text-white" : "bg-muted/30 text-muted-foreground"
                          )}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="text-left">
                            <p className={cn("text-xs font-semibold", permission === value ? "text-accent" : "text-foreground")}>
                              {label}
                            </p>
                            <p className="text-[10px] text-muted-foreground/50">{desc}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    /* Non-notes have no editor — editing isn't possible, so we
                       show a fixed view-only state instead of a dead toggle. */
                    <div className="flex items-center gap-2.5 rounded-xl border border-border/40 bg-muted/20 p-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground">
                        <Eye className="h-4 w-4" />
                      </div>
                      <div className="text-left">
                        <p className="text-xs font-semibold text-foreground">View Only</p>
                        <p className="text-[10px] text-muted-foreground/60">
                          Tipe file ini tidak bisa diedit — hanya note yang mendukung Can Edit
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Duration */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2.5">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      Link Expiry
                    </label>
                    <span className="text-[11px] font-mono text-muted-foreground/60">
                      {duration === null ? "∞" : getRelativeTime(duration)}
                    </span>
                  </div>

                  {/* Visual timeline */}
                  <div className="relative h-2 rounded-full bg-muted/50 mb-3">
                    <motion.div
                      className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-violet-500"
                      initial={{ width: "50%" }}
                      animate={{ width: `${timelinePct}%` }}
                      transition={{ duration: 0.3 }}
                    />
                    <motion.div
                      className="absolute top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-accent shadow-lg shadow-accent/30 border-2 border-white dark:border-card"
                      initial={{ left: "50%" }}
                      animate={{ left: `calc(${timelinePct}% - 8px)` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {DURATION_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => setDuration(preset.minutes)}
                        className={cn(
                          "inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-lg border transition-all",
                          duration === preset.minutes
                            ? "border-accent bg-accent/10 text-accent font-semibold shadow-sm"
                            : "border-border/40 text-muted-foreground hover:border-border/70 hover:text-foreground"
                        )}
                      >
                        <preset.icon className="h-3 w-3" />
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Access Limit */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2.5">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Eye className="h-3.5 w-3.5" />
                      Access Limit
                    </label>
                    <span className="text-[11px] font-mono text-muted-foreground/60">
                      {maxAccess === null ? "∞" : `${maxAccess}x`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ACCESS_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => { setMaxAccess(preset.value); setShowCustomAccess(false); }}
                        className={cn(
                          "px-2.5 py-1.5 text-[11px] rounded-lg border transition-all",
                          !showCustomAccess && maxAccess === preset.value
                            ? "border-accent bg-accent/10 text-accent font-semibold shadow-sm"
                            : "border-border/40 text-muted-foreground hover:border-border/70 hover:text-foreground"
                        )}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      onClick={() => { setShowCustomAccess(true); setMaxAccess(null); }}
                      className={cn(
                        "px-2.5 py-1.5 text-[11px] rounded-lg border transition-all",
                        showCustomAccess
                          ? "border-accent bg-accent/10 text-accent font-semibold shadow-sm"
                          : "border-border/40 text-muted-foreground hover:border-border/70 hover:text-foreground"
                      )}
                    >
                      Custom
                    </button>
                  </div>
                  {showCustomAccess && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="mt-2 flex items-center gap-2"
                    >
                      <Input
                        type="number"
                        min={1}
                        max={999}
                        placeholder="Enter max views..."
                        value={customAccess}
                        onChange={(e) => setCustomAccess(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <Button size="sm" className="h-8 text-xs shrink-0" onClick={() => {
                        const val = parseInt(customAccess);
                        if (val > 0) setMaxAccess(val);
                      }}>
                        Apply
                      </Button>
                    </motion.div>
                  )}
                </div>

                {/* Summary */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-5 rounded-xl bg-gradient-to-br from-accent/5 to-violet-500/5 border border-accent/10 p-3"
                >
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 mb-2">
                    <Sparkles className="h-3 w-3 text-accent" />
                    <span className="font-medium text-foreground/80">Link Summary</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <div className="flex items-center gap-1.5">
                      <Shield className="h-3 w-3 text-accent/70" />
                      <span className="capitalize">{effectivePermission}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3 text-accent/70" />
                      <span>{duration === null ? "No expiry" : getRelativeTime(duration)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Eye className="h-3 w-3 text-accent/70" />
                      <span>{maxAccess === null ? "Unlimited" : `${maxAccess} views`}</span>
                    </div>
                  </div>
                </motion.div>

                {error && (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="text-xs text-red-500 mb-3 flex items-center gap-1"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    {error}
                  </motion.p>
                )}

                <Button
                  variant="default"
                  className="w-full h-11 gap-2 text-sm font-semibold"
                  onClick={handleCreate}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Link className="h-4 w-4" />
                      Buat Link Share
                    </>
                  )}
                </Button>
              </motion.div>
            ) : (
              /* ════════ CREATED STEP ════════ */
              <motion.div
                key="created"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="p-6"
              >
                {/* Success Header */}
                <div className="text-center mb-6 pt-2">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.1 }}
                    className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30"
                  >
                    <Check className="h-6 w-6 text-emerald-500" />
                  </motion.div>
                  <h3 className="text-base font-bold">Link Berhasil Dibuat!</h3>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Bagikan link ini untuk memberikan akses file
                  </p>
                </div>

                {/* Preview Card - how recipient will see it */}
                <div className="mb-4 rounded-xl border border-border/50 bg-gradient-to-br from-muted/30 to-accent/5 p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                      <FileIconDisplay mime={fileType} className="h-4 w-4 text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{fileName}</p>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
                        <Globe className="h-3 w-3" />
                        <span>Shared via link</span>
                        <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                        <Lock className="h-3 w-3" />
                        <span className="capitalize">{effectivePermission}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60 px-0.5">
                    <div className="flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      {formatExpiry(duration)}
                    </div>
                    <div className="flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      {maxAccess === null ? "No limit" : `Max ${maxAccess}x`}
                    </div>
                  </div>
                </div>

                {/* Share URL */}
                <div className="mb-4">
                  <label className="block text-[11px] font-medium text-muted-foreground/60 mb-1.5">Share Link</label>
                  <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-muted/20 p-1 pr-1.5">
                    <div className="flex-1 px-3 py-2 text-xs font-mono text-muted-foreground truncate">
                      {shareUrl}
                    </div>
                    <Button
                      variant={copied ? "default" : "secondary"}
                      size="sm"
                      className={cn("h-8 gap-1.5 shrink-0 transition-all", copied && "bg-emerald-500 hover:bg-emerald-600")}
                      onClick={handleCopy}
                    >
                      {copied ? (
                        <><Check className="h-3.5 w-3.5" /> Copied!</>
                      ) : (
                        <><Copy className="h-3.5 w-3.5" /> Copy</>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" className="flex-1 h-10 gap-1.5"
                    onClick={() => { handleCopy(); }}
                  >
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied!" : "Salin Link"}
                  </Button>
                  <Button variant="default" size="sm" className="flex-1 h-10 gap-1.5"
                    onClick={() => window.open(shareUrl, "_blank")}
                  >
                    <ExternalLink className="h-4 w-4" />
                    Buka Link
                  </Button>
                </div>

                {/* Back to configure */}
                <button
                  onClick={() => { setStep("configure"); setShareUrl(""); setCopied(false); }}
                  className="mt-4 w-full text-center text-xs text-muted-foreground/50 hover:text-foreground/70 transition-colors"
                >
                  Buat link baru dengan pengaturan berbeda
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}


