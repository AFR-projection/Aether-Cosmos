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
  if (minutes < 60) return `${minutes} menit`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} jam`;
  return `${Math.round(minutes / 1440)} hari`;
}

export function ShareDialog({ fileId, fileName, fileType, isNote = false, onClose }: ShareDialogProps) {
  const [step, setStep] = useState<Step>("configure");
  const [duration, setDuration] = useState<number | null>(60);
  const [maxAccess, setMaxAccess] = useState<number | null>(5);
  const [customAccess, setCustomAccess] = useState("");
  const [showCustomAccess, setShowCustomAccess] = useState(false);
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  const timelinePct = useMemo(() => {
    if (duration === null) return 100;
    const max = 10080;
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
          initial={{ scale: 0.94, opacity: 0, y: 16 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.94, opacity: 0, y: 16 }}
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
          className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border shadow-[0_32px_80px_rgba(0,0,0,0.35)]"
          style={{ background: "var(--surface-elevated)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Accent top stripe */}
          <div className="absolute top-0 inset-x-0 h-0.5 bg-gradient-to-r from-violet-500 via-accent to-cyan-400" />

          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3.5 right-3.5 z-20 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>

          <AnimatePresence mode="wait">
            {step === "configure" ? (
              <motion.div
                key="configure"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: -16 }}
              >
                {/* ── Header ── */}
                <div className="relative overflow-hidden px-6 pb-5 pt-6">
                  <div className="absolute inset-0 bg-gradient-to-br from-accent/8 via-transparent to-violet-500/5" />
                  <div className="relative flex items-center gap-3.5 pr-8">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10">
                      <FileIconDisplay mime={fileType} className="h-5 w-5 text-accent" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold tracking-tight">Buat Link Share</h3>
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-accent">Secure</span>
                      </div>
                      <p className="mt-0.5 max-w-[260px] truncate text-[11px] text-muted-foreground">{fileName}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-1 px-6 pb-6">
                  {/* ── Permission ── */}
                  <div className="rounded-xl border border-border bg-muted/30 p-4">
                    <label className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                      <Shield className="h-3.5 w-3.5" />
                      Permission
                    </label>
                    {isNote ? (
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { value: "view" as const, label: "View Only", desc: "Recipient can only view", icon: Eye },
                          { value: "edit" as const, label: "Can Edit", desc: "Recipient can modify", icon: Pencil },
                        ].map(({ value, label, desc, icon: Icon }) => (
                          <button
                            key={value}
                            onClick={() => setPermission(value)}
                            className={cn(
                              "flex items-center gap-2.5 rounded-lg border p-3 text-left transition-all",
                              permission === value
                                ? "border-accent bg-accent/10 shadow-sm"
                                : "border-border/50 bg-background hover:border-accent/40 hover:bg-accent/5"
                            )}
                          >
                            <div className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                              permission === value ? "bg-accent text-white" : "bg-muted text-muted-foreground"
                            )}>
                              <Icon className="h-3.5 w-3.5" />
                            </div>
                            <div>
                              <p className={cn("text-xs font-semibold", permission === value ? "text-accent" : "text-foreground")}>
                                {label}
                              </p>
                              <p className="text-[10px] text-muted-foreground">{desc}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-background p-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Eye className="h-3.5 w-3.5" />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-foreground">View Only</p>
                          <p className="text-[10px] text-muted-foreground">Tipe file ini hanya mendukung view</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── Link Expiry ── */}
                  <div className="rounded-xl border border-border bg-muted/30 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Link Expiry
                      </label>
                      <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                        {duration === null ? "∞ Tak terbatas" : getRelativeTime(duration)}
                      </span>
                    </div>

                    {/* Timeline bar */}
                    <div className="relative mb-3.5 h-1.5 rounded-full bg-muted">
                      <motion.div
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-violet-500"
                        animate={{ width: `${timelinePct}%` }}
                        transition={{ duration: 0.25 }}
                      />
                      <motion.div
                        className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-surface-elevated bg-accent shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                        animate={{ left: `calc(${timelinePct}% - 7px)` }}
                        transition={{ duration: 0.25 }}
                      />
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {DURATION_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => setDuration(preset.minutes)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all",
                            duration === preset.minutes
                              ? "border-accent bg-accent text-white shadow-sm"
                              : "border-border/60 bg-background text-muted-foreground hover:border-accent/40 hover:text-foreground"
                          )}
                        >
                          <preset.icon className="h-3 w-3" />
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* ── Access Limit ── */}
                  <div className="rounded-xl border border-border bg-muted/30 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <label className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <Eye className="h-3.5 w-3.5" />
                        Access Limit
                      </label>
                      <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                        {maxAccess === null ? "∞ Unlimited" : `${maxAccess}x views`}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {ACCESS_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => { setMaxAccess(preset.value); setShowCustomAccess(false); }}
                          className={cn(
                            "rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all",
                            !showCustomAccess && maxAccess === preset.value
                              ? "border-accent bg-accent text-white shadow-sm"
                              : "border-border/60 bg-background text-muted-foreground hover:border-accent/40 hover:text-foreground"
                          )}
                        >
                          {preset.label}
                        </button>
                      ))}
                      <button
                        onClick={() => { setShowCustomAccess(true); setMaxAccess(null); }}
                        className={cn(
                          "rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all",
                          showCustomAccess
                            ? "border-accent bg-accent text-white shadow-sm"
                            : "border-border/60 bg-background text-muted-foreground hover:border-accent/40 hover:text-foreground"
                        )}
                      >
                        Custom
                      </button>
                    </div>
                    {showCustomAccess && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        className="mt-2.5 flex items-center gap-2"
                      >
                        <Input
                          type="number"
                          min={1}
                          max={999}
                          placeholder="Jumlah akses maksimal..."
                          value={customAccess}
                          onChange={(e) => setCustomAccess(e.target.value)}
                          className="h-8 text-xs"
                        />
                        <Button size="sm" className="h-8 shrink-0 text-xs" onClick={() => {
                          const val = parseInt(customAccess);
                          if (val > 0) setMaxAccess(val);
                        }}>
                          Apply
                        </Button>
                      </motion.div>
                    )}
                  </div>

                  {/* ── Summary ── */}
                  <div className="rounded-xl border border-accent/20 bg-accent/[0.06] p-3.5">
                    <div className="mb-2.5 flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-accent" />
                      <span className="text-[11px] font-semibold text-foreground/80">Link Summary</span>
                    </div>
                    <div className="flex items-center gap-5 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Shield className="h-3 w-3 text-accent/60" />
                        <span className="capitalize">{effectivePermission}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-accent/60" />
                        <span>{duration === null ? "No expiry" : getRelativeTime(duration)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Eye className="h-3 w-3 text-accent/60" />
                        <span>{maxAccess === null ? "Unlimited" : `${maxAccess} views`}</span>
                      </div>
                    </div>
                  </div>

                  {error && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      className="flex items-center gap-1.5 text-xs text-red-400"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                      {error}
                    </motion.p>
                  )}

                  <Button
                    className="mt-1 w-full gap-2 font-semibold"
                    onClick={handleCreate}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        Membuat link...
                      </>
                    ) : (
                      <>
                        <Link className="h-4 w-4" />
                        Buat Link Share
                      </>
                    )}
                  </Button>
                </div>
              </motion.div>
            ) : (
              /* ════════ CREATED STEP ════════ */
              <motion.div
                key="created"
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="p-6"
              >
                {/* Success Header */}
                <div className="mb-6 pt-2 text-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.1 }}
                    className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10"
                  >
                    <Check className="h-6 w-6 text-emerald-500" />
                  </motion.div>
                  <h3 className="text-base font-bold">Link Berhasil Dibuat!</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Bagikan link ini untuk memberikan akses file
                  </p>
                </div>

                {/* Info card */}
                <div className="mb-4 rounded-xl border border-border bg-muted/30 p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10">
                      <FileIconDisplay mime={fileType} className="h-4 w-4 text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{fileName}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <Globe className="h-3 w-3" />
                        <span>Shared via link</span>
                        <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                        <Lock className="h-3 w-3" />
                        <span className="capitalize">{effectivePermission}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
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
                  <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">Share Link</label>
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 p-1 pl-3">
                    <p className="flex-1 truncate text-[11px] font-mono text-muted-foreground">{shareUrl}</p>
                    <Button
                      variant={copied ? "default" : "secondary"}
                      size="sm"
                      className={cn("h-8 shrink-0 gap-1.5 transition-all", copied && "bg-emerald-500 hover:bg-emerald-600")}
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

                {/* Actions */}
                <div className="flex gap-2">
                  <Button variant="secondary" className="h-10 flex-1 gap-1.5 text-sm" onClick={handleCopy}>
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied!" : "Salin Link"}
                  </Button>
                  <Button className="h-10 flex-1 gap-1.5 text-sm" onClick={() => window.open(shareUrl, "_blank")}>
                    <ExternalLink className="h-4 w-4" />
                    Buka Link
                  </Button>
                </div>

                <button
                  onClick={() => { setStep("configure"); setShareUrl(""); setCopied(false); }}
                  className="mt-4 w-full text-center text-xs text-muted-foreground/50 transition-colors hover:text-foreground/70"
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
