"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { formatBytes, formatDate, cn } from "@/lib/utils";
import { useDialogs } from "@/components/ui/dialog-prompts";

type FileVersion = {
  id: string;
  version: number;
  sizeBytes: number;
  createdAt: string | Date;
  createdByUsername: string | null;
};

interface FileVersionsPanelProps {
  fileId: string;
  canRestore?: boolean;
  onRestored?: () => void;
  className?: string;
}

export function FileVersionsPanel({
  fileId,
  canRestore = true,
  onRestored,
  className,
}: FileVersionsPanelProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { askConfirm, dialogs } = useDialogs();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<{
      currentVersion: number;
      versions: FileVersion[];
      canRestore: boolean;
    }>(`/api/files/${fileId}/versions`);
    if (!res.success || !res.data) {
      setError(res.error ?? "Failed to load versions");
      setLoading(false);
      return;
    }
    setVersions(res.data.versions);
    setCurrentVersion(res.data.currentVersion);
    setLoading(false);
  }, [fileId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRestore(version: number) {
    const ok = await askConfirm({
      title: `Restore version ${version}?`,
      message: "Current content will be kept as a new version.",
      confirmText: "Restore",
    });
    if (!ok) return;
    setRestoring(version);
    const res = await apiFetch(`/api/files/${fileId}/versions/restore`, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
    setRestoring(null);
    if (!res.success) {
      setError(res.error ?? "Restore failed");
      return;
    }
    await load();
    onRestored?.();
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Versions
        </h4>
        {currentVersion != null && (
          <span className="text-xs text-muted-foreground/70">v{currentVersion} current</span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      {!loading && versions.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No previous versions yet.</p>
      )}

      <ul className="max-h-48 space-y-1.5 overflow-y-auto">
        {versions.map((v) => (
          <li
            key={v.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-surface-hover/40 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">v{v.version}</p>
              <p className="truncate text-xs text-muted-foreground">
                {formatBytes(v.sizeBytes)} · {formatDate(v.createdAt)}
                {v.createdByUsername ? ` · ${v.createdByUsername}` : ""}
              </p>
            </div>
            {canRestore && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 shrink-0"
                disabled={restoring === v.version}
                onClick={() => handleRestore(v.version)}
              >
                {restoring === v.version ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {dialogs}
    </div>
  );
}
