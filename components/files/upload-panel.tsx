"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, CheckCircle2, AlertCircle, Pause, Play, RotateCcw,
  Zap, Clock, Pin, PinOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadQueue, formatSpeed, formatETA, type UploadItem, type UploadStats } from "@/lib/upload-queue";
import { formatBytes, cn } from "@/lib/utils";
import { notify } from "@/lib/system/notify-store";

interface UploadPanelProps {
  queue: UploadQueue;
  onDismiss: () => void;
}

function ProgressRing({ progress, active }: { progress: number; active: boolean }) {
  const size = 36;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (progress / 100) * circumference;

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-muted/30"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className={cn(
          "transition-all duration-300",
          active ? "text-accent" : "text-emerald-500"
        )}
      />
    </svg>
  );
}

function UploadRow({ item, onRetry, onCancel }: {
  item: UploadItem;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      className="group px-3 py-2 rounded-lg hover:bg-muted/30 transition-colors"
    >
      <div className="flex items-center gap-2.5">
        <div className="shrink-0">
          {item.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {item.status === "error" && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
          {item.status === "uploading" && (
            <div className="h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
          )}
          {item.status === "queued" && (
            <div className="h-3.5 w-3.5 rounded-full border border-muted-foreground/20" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium truncate leading-tight">{item.file?.name ?? "Unknown"}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground">{formatBytes(item.file?.size ?? 0)}</span>
            {item.status === "uploading" && (
              <span className="text-[10px] font-mono text-accent">{item.progress}%</span>
            )}
            {item.status === "queued" && (
              <span className="text-[10px] text-muted-foreground/50">Waiting</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {item.status === "error" && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRetry} title="Retry">
              <RotateCcw className="h-3 w-3" />
            </Button>
          )}
          {(item.status === "queued" || item.status === "error") && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onCancel} title="Cancel">
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {item.status === "uploading" && (
        <div className="mt-1.5 h-0.5 rounded-full bg-muted/40 overflow-hidden ml-5">
          <motion.div
            className="h-full rounded-full bg-accent"
            animate={{ width: `${item.progress}%` }}
            transition={{ duration: 0.2 }}
          />
        </div>
      )}
      {item.status === "error" && item.error && (
        <p className="mt-0.5 ml-5 text-[10px] text-red-500/80 truncate">{item.error}</p>
      )}
    </motion.div>
  );
}

export function UploadPanel({ queue, onDismiss }: UploadPanelProps) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [stats, setStats] = useState<UploadStats>({
    total: 0, completed: 0, failed: 0, active: 0, queued: 0,
    totalBytes: 0, loadedBytes: 0, overallProgress: 0, speed: 0, eta: 0,
  });
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [paused, setPaused] = useState(false);
  const notifiedRef = useRef(false);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onChange = (newItems: UploadItem[], newStats: UploadStats) => {
      setItems([...newItems]);
      setStats(newStats);
    };
    queue.on("change", onChange);
    return () => { queue.off("change"); };
  }, [queue]);

  const allDone = stats.completed + stats.failed === stats.total && stats.total > 0;
  const hasActive = stats.active > 0 || stats.queued > 0;

  const smartItems = useMemo(() => {
    const visible = items.filter((i) => i.status !== "cancelled");
    const active = visible.filter((i) => i.status === "uploading" || i.status === "queued");
    const failed = visible.filter((i) => i.status === "error");
    const done = visible.filter((i) => i.status === "done");
    if (expanded) {
      return [...active, ...failed, ...done.slice(-3)];
    }
    const current = active[0] ?? failed[0];
    return current ? [current] : [];
  }, [items, expanded]);

  const handleDismiss = useCallback(() => {
    queue.clearCompleted();
    onDismiss();
  }, [queue, onDismiss]);

  useEffect(() => {
    if (!allDone) {
      notifiedRef.current = false;
      if (autoDismissRef.current) {
        clearTimeout(autoDismissRef.current);
        autoDismissRef.current = null;
      }
      return;
    }

    if (!notifiedRef.current) {
      notifiedRef.current = true;
      notify({
        title: stats.failed > 0 ? "Upload selesai dengan error" : "Upload selesai",
        description: `${stats.completed}/${stats.total} file berhasil${stats.failed > 0 ? ` · ${stats.failed} gagal` : ""}`,
        tone: stats.failed > 0 ? "warning" : "success",
        duration: 4500,
      });
    }

    if (!pinned && !expanded) {
      autoDismissRef.current = setTimeout(handleDismiss, 4000);
    }

    return () => {
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, [allDone, stats.completed, stats.failed, stats.total, pinned, expanded, handleDismiss]);

  // Auto-collapse when idle
  useEffect(() => {
    if (!hasActive && expanded && !pinned) {
      const t = setTimeout(() => setExpanded(false), 2500);
      return () => clearTimeout(t);
    }
  }, [hasActive, expanded, pinned]);

  const statusLabel = stats.active > 0
    ? `Mengupload ${stats.active} file`
    : allDone
    ? stats.failed > 0 ? "Selesai · ada error" : "Semua selesai"
    : stats.queued > 0
    ? "Menunggu antrian"
    : "Upload";

  return (
    <motion.div
      initial={{ y: 24, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 24, opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={cn(
        "fixed z-50 overflow-hidden",
        "bottom-5 right-5 sm:bottom-6 sm:right-6",
        "rounded-2xl border border-border/40 bg-surface/90 backdrop-blur-2xl shadow-xl shadow-black/10",
        expanded ? "w-[min(100vw-2rem,340px)]" : "w-auto max-w-[min(100vw-2rem,320px)]"
      )}
      onMouseEnter={() => { if (hasActive && !pinned) setExpanded(true); }}
      onMouseLeave={() => { if (!pinned && allDone) setExpanded(false); }}
    >
      {/* Compact header — always visible */}
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none",
          expanded && "border-b border-border/30"
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="relative shrink-0">
          <ProgressRing progress={stats.overallProgress} active={hasActive} />
          <div className="absolute inset-0 flex items-center justify-center">
            {allDone && stats.failed === 0 ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            ) : stats.failed > 0 && allDone ? (
              <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <span className="text-[9px] font-bold font-mono text-foreground/80">
                {Math.round(stats.overallProgress)}
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold truncate leading-tight">{statusLabel}</p>
          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
            {stats.completed}/{stats.total} file
            {stats.speed > 0 && hasActive && ` · ${formatSpeed(stats.speed)}`}
            {stats.eta > 0 && hasActive && ` · ${formatETA(stats.eta)}`}
          </p>
        </div>

        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {hasActive && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => { paused ? queue.resume() : queue.pause(); setPaused(!paused); }}
              title={paused ? "Lanjutkan" : "Jeda"}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setPinned((p) => !p)}
            title={pinned ? "Lepas pin" : "Pin panel"}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleDismiss} title="Tutup">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {/* Mini stats bar */}
            <div className="px-3 py-2 border-b border-border/20">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><Zap className="h-3 w-3 text-accent" />{formatSpeed(stats.speed)}</span>
                  {stats.eta > 0 && hasActive && (
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatETA(stats.eta)}</span>
                  )}
                </div>
                <span className="text-[10px] font-mono">{formatBytes(stats.loadedBytes)}/{formatBytes(stats.totalBytes)}</span>
              </div>
              <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                <motion.div
                  className={cn("h-full rounded-full", stats.failed > 0 && !hasActive ? "bg-amber-500" : "bg-accent")}
                  animate={{ width: `${stats.overallProgress}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>

            {/* File rows */}
            <div className="max-h-[200px] overflow-y-auto py-1">
              <AnimatePresence mode="popLayout">
                {smartItems.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground text-center py-4">Tidak ada upload aktif</p>
                ) : (
                  smartItems.map((item) => (
                    <UploadRow
                      key={item.id}
                      item={item}
                      onRetry={() => queue.retryItem(item.id)}
                      onCancel={() => queue.cancelItem(item.id)}
                    />
                  ))
                )}
              </AnimatePresence>
            </div>

            {stats.failed > 0 && (
              <div className="px-3 py-2 border-t border-border/20 flex justify-end">
                <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => queue.retryFailed()}>
                  <RotateCcw className="h-3 w-3 mr-1" /> Ulangi yang gagal
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Collapsed peek — current file name */}
      {!expanded && smartItems[0] && (
        <div className="px-3 pb-2.5 -mt-0.5">
          <p className="text-[10px] text-muted-foreground/70 truncate pl-[48px]">
            {smartItems[0].file?.name}
          </p>
        </div>
      )}
    </motion.div>
  );
}
