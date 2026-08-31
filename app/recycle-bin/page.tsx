"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { apiFetch } from "@/shared/api/client";
import { Button } from "@/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { getAccentColor, getGradientFallback, getFileTypeIcon } from "@/shared/lib/file-type-utils";
import { apiErrorMessage, useFormat, useT, type TranslationKey, type Translator } from "@/shared/lib/i18n";
import type { File as FileRecord, Folder } from "@/shared/infrastructure/db/schema";
import {
  Trash2, RotateCcw, Search, Folder as FolderIcon,
  CheckSquare, Square, AlertTriangle,
  Clock, Loader2, ChevronDown, ChevronRight,
  Eraser, Info,
} from "lucide-react";

type TrashFile = FileRecord & { _type: "file"; _sortTime: number };
type TrashFolder = Folder & { _type: "folder"; _sortTime: number };
type TrashItem = TrashFile | TrashFolder;

function getRelativeTime(ms: number, t: Translator): { label: string; color: string } {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return { label: t("common.relative.now"), color: "text-red-500" };
  if (mins < 60)
    return { label: t("common.relative.minutes", { count: mins }), color: "text-red-400" };

  const hours = Math.floor(mins / 60);
  if (hours < 24)
    return { label: t("common.relative.hours", { count: hours }), color: "text-orange-400" };

  const days = Math.floor(hours / 24);
  if (days === 1) return { label: t("common.relative.yesterday"), color: "text-amber-400" };
  if (days < 7)
    return { label: t("common.relative.days", { count: days }), color: "text-amber-400" };
  if (days < 30)
    return {
      label: t("common.relative.weeks", { count: Math.floor(days / 7) }),
      color: "text-yellow-600 dark:text-yellow-400",
    };
  return {
    label: t("common.relative.months", { count: Math.floor(days / 30) }),
    color: "text-muted-foreground/60",
  };
}

/**
 * A group id, not a label. The same value keys the expanded-groups set, so it
 * has to stay identical across languages — switching language mid-session must
 * not collapse every group by making the old keys unrecognisable.
 */
type TimeGroup = "today" | "yesterday" | "week" | "month" | "older";

const GROUP_ORDER: TimeGroup[] = ["today", "yesterday", "week", "month", "older"];

const GROUP_LABELS: Record<TimeGroup, TranslationKey> = {
  today: "recycleBin.group.today",
  yesterday: "recycleBin.group.yesterday",
  week: "recycleBin.group.week",
  month: "recycleBin.group.month",
  older: "recycleBin.group.older",
};

function getTimeGroup(timestamp: number): TimeGroup {
  const now = Date.now();
  const diff = now - timestamp;
  const day = 86400000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return "week";
  if (diff < 30 * day) return "month";
  return "older";
}

function getFileIcon(mimeType: string) {
  return getFileTypeIcon(mimeType);
}

function getFileAccent(mimeType: string): string {
  return getAccentColor(mimeType);
}

function getFileGradient(mimeType: string): string {
  return getGradientFallback(mimeType);
}

export default function RecycleBinPage() {
  const t = useT();
  const { formatBytes, formatNumber } = useFormat();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<TimeGroup>>(new Set(GROUP_ORDER));

  const { data, isLoading } = useQuery({
    queryKey: ["recycle-bin"],
    queryFn: async () => {
      const res = await apiFetch<{ files: FileRecord[]; folders: Folder[] }>("/api/recycle-bin");
      return res.data ?? { files: [], folders: [] };
    },
  });

  const items = useMemo(() => {
    const result: TrashItem[] = [];
    for (const f of data?.files ?? []) {
      if (!f.deletedAt) continue;
      result.push({ ...f, _type: "file", _sortTime: new Date(f.deletedAt).getTime() });
    }
    for (const f of data?.folders ?? []) {
      if (!f.deletedAt) continue;
      result.push({ ...f, _type: "folder", _sortTime: new Date(f.deletedAt).getTime() });
    }
    result.sort((a, b) => b._sortTime - a._sortTime);
    return result;
  }, [data]);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, search]);

  const grouped = useMemo(() => {
    const groups = {} as Record<TimeGroup, TrashItem[] | undefined>;
    for (const item of filtered) {
      const grp = getTimeGroup(item._sortTime);
      (groups[grp] ??= []).push(item);
    }
    return GROUP_ORDER.flatMap((id) => {
      const rows = groups[id];
      return rows ? [{ id, items: rows }] : [];
    });
  }, [filtered]);

  const totalSize = useMemo(() => {
    return items.reduce((sum, item) => sum + (item._type === "file" ? Number(item.sizeBytes) : 0), 0);
  }, [items]);

  function showMsg(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(""), 3000);
  }

  async function handleRestore(item: TrashItem) {
    setActionLoading(item.id);
    try {
      const endpoint = item._type === "file" ? "/api/files" : "/api/folders";
      const res = await apiFetch(endpoint, { method: "PATCH", body: JSON.stringify({ id: item.id, action: "restore" }) });
      if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.restoreFailed")); return; }
      showMsg(t("recycleBin.restored", { name: item.name }));
      setSelected((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
      queryClient.invalidateQueries({ queryKey: ["recycle-bin"] });
    } catch { showMsg(t("recycleBin.connectionFailed")); }
    finally { setActionLoading(null); }
  }

  async function handleDelete(item: TrashItem) {
    setActionLoading(item.id);
    try {
      const endpoint = item._type === "file" ? "/api/files" : "/api/folders";
      const res = await apiFetch(endpoint, { method: "DELETE", body: JSON.stringify({ id: item.id, permanent: true }) });
      if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.deleteFailed")); return; }
      showMsg(t("recycleBin.permanentlyDeleted", { name: item.name }));
      setSelected((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
      queryClient.invalidateQueries({ queryKey: ["recycle-bin"] });
    } catch { showMsg(t("recycleBin.connectionFailed")); }
    finally { setActionLoading(null); }
  }

  async function handleBatchRestore() {
    setActionLoading("batch-restore");
    try {
      const fileIds: string[] = [];
      const folderIds: string[] = [];
      for (const id of selected) {
        const item = items.find((i) => i.id === id);
        if (!item) continue;
        if (item._type === "file") fileIds.push(id);
        else folderIds.push(id);
      }
      if (fileIds.length) {
        const res = await apiFetch("/api/files/batch", {
          method: "PATCH",
          body: JSON.stringify({ ids: fileIds, action: "restore" }),
        });
        if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.restoreFilesFailed")); return; }
      }
      if (folderIds.length) {
        const res = await apiFetch("/api/folders/batch", {
          method: "PATCH",
          body: JSON.stringify({ ids: folderIds, action: "restore" }),
        });
        if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.restoreFoldersFailed")); return; }
      }
      showMsg(t("recycleBin.batchRestored", { count: selected.size }));
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["recycle-bin"] });
    } catch { showMsg(t("recycleBin.batchRestoreFailed")); }
    finally { setActionLoading(null); }
  }

  async function handleBatchDelete() {
    setActionLoading("batch-delete");
    try {
      const fileIds: string[] = [];
      const folderIds: string[] = [];
      for (const id of selected) {
        const item = items.find((i) => i.id === id);
        if (!item) continue;
        if (item._type === "file") fileIds.push(id);
        else folderIds.push(id);
      }
      if (fileIds.length) {
        const res = await apiFetch("/api/files/batch", {
          method: "DELETE",
          body: JSON.stringify({ ids: fileIds, permanent: true }),
        });
        if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.deleteFilesFailed")); return; }
      }
      if (folderIds.length) {
        const res = await apiFetch("/api/folders/batch", {
          method: "DELETE",
          body: JSON.stringify({ ids: folderIds, permanent: true }),
        });
        if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.deleteFoldersFailed")); return; }
      }
      showMsg(t("recycleBin.batchDeleted", { count: selected.size }));
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["recycle-bin"] });
    } catch { showMsg(t("recycleBin.batchDeleteFailed")); }
    finally { setActionLoading(null); }
  }

  async function handleEmptyTrash() {
    setActionLoading("empty");
    try {
      const fileIds = items.filter((i) => i._type === "file").map((i) => i.id);
      const folderIds = items.filter((i) => i._type === "folder").map((i) => i.id);
      for (let i = 0; i < fileIds.length; i += 500) {
        const chunk = fileIds.slice(i, i + 500);
        const res = await apiFetch("/api/files/batch", {
          method: "DELETE",
          body: JSON.stringify({ ids: chunk, permanent: true }),
        });
        if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.emptyFailed")); return; }
      }
      for (let i = 0; i < folderIds.length; i += 500) {
        const chunk = folderIds.slice(i, i + 500);
        const res = await apiFetch("/api/folders/batch", {
          method: "DELETE",
          body: JSON.stringify({ ids: chunk, permanent: true }),
        });
        if (!res.success) { showMsg(apiErrorMessage(res, t, "recycleBin.emptyFailed")); return; }
      }
      showMsg(t("recycleBin.emptied"));
      setConfirmEmpty(false);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["recycle-bin"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch { showMsg(t("recycleBin.emptyFailed")); }
    finally { setActionLoading(null); }
  }

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allIds = useMemo(() => filtered.map((i) => i.id), [filtered]);
  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  function toggleSelectAll() {
    if (allSelected) { setSelected(new Set()); return; }
    setSelected(new Set(allIds));
  }

  function toggleGroup(groupId: TimeGroup) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div>
        <PageHeader itemCount={0} totalSize={0} />
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="h-16 skeleton rounded-2xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader itemCount={items.length} totalSize={totalSize} />

      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400"
        >
          <Info className="h-4 w-4 shrink-0" />
          {message}
        </motion.div>
      )}

      {/* Search + Actions */}
      <div className="mb-5 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("recycleBin.searchPlaceholder")}
            className="h-10 w-full rounded-xl border border-border/60 bg-surface pl-10 pr-4 text-base sm:text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors text-xs"
            >
              {t("recycleBin.clear")}
            </button>
          )}
        </div>

        <Button
          variant="destructive"
          size="sm"
          disabled={items.length === 0 || actionLoading === "empty"}
          onClick={() => setConfirmEmpty(true)}
        >
          {actionLoading === "empty" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eraser className="h-3.5 w-3.5" />
          )}
          {t("recycleBin.emptyTrash")}
        </Button>
      </div>

      {/* Batch selection bar */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/30 bg-accent/5 px-5 py-3"
          >
            <span className="text-sm font-medium">{t("common.selectedCount", { count: selected.size })}</span>
            <div className="flex-1 min-w-0" />
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={toggleSelectAll}>
              {allSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{allSelected ? t("recycleBin.deselectAll") : t("recycleBin.selectAll")}</span>
            </Button>
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={handleBatchRestore} disabled={actionLoading === "batch-restore"}>
              {actionLoading === "batch-restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              <span>{t("recycleBin.restore")}</span>
            </Button>
            <Button variant="destructive" size="sm" className="gap-1.5" onClick={handleBatchDelete} disabled={actionLoading === "batch-delete"}>
              {actionLoading === "batch-delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {/* The short form is a separate key: no locale can be trimmed
                  automatically, so each language supplies its own abbreviation. */}
              <span className="hidden sm:inline">{t("common.delete")}</span><span className="sm:hidden">{t("recycleBin.deleteShort")}</span>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state */}
      {items.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-24 text-muted-foreground"
        >
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-accent/5 border border-accent/10">
            <Trash2 className="h-10 w-10 text-accent-ink/40" />
          </div>
          <p className="text-lg font-semibold">{t("recycleBin.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground/70">{t("recycleBin.emptyHint")}</p>
        </motion.div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => {
            const isExpanded = expandedGroups.has(group.id);
            return (
              <div key={group.id}>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center gap-2 mb-3 group/heading cursor-pointer"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground/50 group-hover/heading:text-foreground transition-colors" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover/heading:text-foreground transition-colors" />
                  )}
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 group-hover/heading:text-foreground transition-colors">
                    {t(GROUP_LABELS[group.id])}
                  </h2>
                  <span className="text-[11px] text-muted-foreground/40 font-mono">({formatNumber(group.items.length)})</span>
                  <div className="flex-1 border-b border-border/20" />
                </button>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-2 overflow-hidden"
                    >
                      {group.items.map((item, idx) => {
                        const isSelected = selected.has(item.id);
                        const rel = getRelativeTime(Date.now() - item._sortTime, t);
                        const Icon = item._type === "file" ? getFileIcon(item.mimeType) : FolderIcon;

                        return (
                          <motion.div
                            key={item.id}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: Math.min(idx * 0.02, 0.2) }}
                            className={cn(
                              "group/item flex items-center gap-3 rounded-2xl border p-4 transition-all",
                              isSelected
                                ? "border-accent/30 bg-accent/5 shadow-sm"
                                : "border-border/40 bg-surface hover:border-accent/20 hover:shadow-sm hover:bg-accent/[0.02]"
                            )}
                          >
                            {/* Checkbox */}
                            <button
                              onClick={() => toggleSelect(item.id)}
                              className={cn(
                                "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all",
                                isSelected
                                  ? "border-accent bg-accent text-on-accent"
                                  : "border-border/60 text-transparent hover:border-accent/50 group-hover/item:border-accent/30"
                              )}
                            >
                              {isSelected && <CheckSquare className="h-3 w-3" />}
                            </button>

                            {/* Icon */}
                            <div className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br",
                              item._type === "folder"
                                ? "from-blue-500/15 to-indigo-500/10"
                                : getFileGradient(item.mimeType)
                            )}>
                              <Icon className={cn(
                                "h-5 w-5",
                                item._type === "folder" ? "text-blue-500" : getFileAccent(item.mimeType)
                              )} />
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-semibold truncate">{item.name}</p>
                                {item._type === "file" && item.isNote && (
                                  <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium text-accent-ink">{t("common.note")}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground/60">
                                {item._type === "file" && (
                                  <span className="font-mono">{formatBytes(Number(item.sizeBytes))}</span>
                                )}
                                {item._type === "folder" && (
                                  <span className="inline-flex items-center gap-1">
                                    <FolderIcon className="h-3 w-3" />
                                    {t("common.folder")}
                                  </span>
                                )}
                                {item._type === "folder" && item.materializedPath && (
                                  <>
                                    <span className="text-muted-foreground/30">•</span>
                                    <span className="truncate max-w-[200px] opacity-70">{item.materializedPath}{item.name}/</span>
                                  </>
                                )}
                                <span className={cn("ml-auto flex items-center gap-1 shrink-0", rel.color)}>
                                  <Clock className="h-3 w-3" />
                                  {rel.label}
                                </span>
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 gap-1.5 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                                disabled={actionLoading === item.id}
                                onClick={() => handleRestore(item)}
                              >
                                {actionLoading === item.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3.5 w-3.5" />
                                )}
                                {t("recycleBin.restore")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 gap-1.5 text-danger-ink hover:bg-danger/10"
                                disabled={actionLoading === item.id}
                                onClick={() => setConfirmDelete(item.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                {t("common.delete")}
                              </Button>
                            </div>
                          </motion.div>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirm single delete */}
      <AnimatePresence>
        {confirmDelete && (
          <ConfirmModal
            title={t("recycleBin.confirmDeleteTitle")}
            description={t("recycleBin.confirmDeleteBody")}
            confirmLabel={t("recycleBin.confirmDeleteAction")}
            icon={AlertTriangle}
            danger
            loading={actionLoading === confirmDelete}
            onConfirm={() => {
              const item = items.find((i) => i.id === confirmDelete);
              if (item) handleDelete(item);
              setConfirmDelete(null);
            }}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </AnimatePresence>

      {/* Confirm empty trash */}
      <AnimatePresence>
        {confirmEmpty && (
          <ConfirmModal
            title={t("recycleBin.confirmEmptyTitle")}
            description={t("recycleBin.confirmEmptyBody", { count: items.length })}
            confirmLabel={t("recycleBin.confirmEmptyAction")}
            icon={AlertTriangle}
            danger
            loading={actionLoading === "empty"}
            onConfirm={handleEmptyTrash}
            onCancel={() => setConfirmEmpty(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ConfirmModal({
  title, description, confirmLabel, icon: Icon, danger, loading, onConfirm, onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  icon: typeof AlertTriangle;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // The caller passes already-translated copy; only this component's own
  // Cancel affordance is translated here.
  const t = useT();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-sm rounded-2xl border border-border/60 bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 mb-4">
          <div className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
            danger ? "bg-danger/10" : "bg-accent/10"
          )}>
            <Icon className={cn("h-6 w-6", danger ? "text-danger-ink" : "text-accent-ink")} />
          </div>
          <div>
            <h3 className="text-lg font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground/70 mt-0.5">{description}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button
            variant={danger ? "destructive" : "default"}
            size="sm"
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function PageHeader({ itemCount, totalSize }: { itemCount: number; totalSize: number }) {
  const t = useT();
  const { formatBytes } = useFormat();
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("recycleBin.title")}</h1>
        {itemCount > 0 && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground/60">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/30 px-3 py-1.5">
              <Trash2 className="h-3 w-3" />
              {t("common.itemCount", { count: itemCount })}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/30 px-3 py-1.5 font-mono">
              {formatBytes(totalSize)}
            </span>
          </div>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground/70">{t("recycleBin.subtitle")}</p>
    </motion.div>
  );
}
