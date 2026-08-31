"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/feedback/spinner";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { apiErrorMessage, useFormat, useT } from "@/shared/lib/i18n";
import { useDialogs } from "@/ui/primitives/dialog-prompts";

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
  const t = useT();
  const { formatBytes, formatDate } = useFormat();
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { askConfirm, dialogs } = useDialogs();

  const load = useCallback(async () => {
    // No setLoading(true) here: the panel starts in its loading state, and a
    // reload after a restore is already reported by the row's own spinner — so
    // the version list never blanks out under the user.
    setError(null);
    const res = await apiFetch<{
      currentVersion: number;
      versions: FileVersion[];
      canRestore: boolean;
    }>(`/api/files/${fileId}/versions`);
    if (!res.success || !res.data) {
      setError(apiErrorMessage(res, t, "files.versions.loadFailed"));
      setLoading(false);
      return;
    }
    setVersions(res.data.versions);
    setCurrentVersion(res.data.currentVersion);
    setLoading(false);
    // `t` is a dependency because the stored message is already translated: a
    // language switch has to re-read it rather than leave the old wording.
  }, [fileId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRestore(version: number) {
    const ok = await askConfirm({
      title: t("files.versions.restoreConfirmTitle", { version }),
      message: t("files.versions.restoreConfirmBody"),
      confirmText: t("files.versions.restoreAction"),
    });
    if (!ok) return;
    setRestoring(version);
    const res = await apiFetch(`/api/files/${fileId}/versions/restore`, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
    setRestoring(null);
    if (!res.success) {
      setError(apiErrorMessage(res, t, "files.versions.restoreFailed"));
      return;
    }
    await load();
    onRestored?.();
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("files.versions.title")}
        </h4>
        {currentVersion != null && (
          <span className="text-xs text-muted-foreground">
            {t("files.versions.current", { version: currentVersion })}
          </span>
        )}
      </div>

      {loading && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" /> {t("files.versions.loading")}
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      )}

      {!loading && versions.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">
          {t("files.versions.none")}
        </p>
      )}

      {versions.length > 0 && (
        <ul className="max-h-48 space-y-1.5 overflow-y-auto">
          {versions.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-surface-hover/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t("files.versions.versionLabel", { version: v.version })}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {formatBytes(v.sizeBytes)} · {formatDate(v.createdAt)}
                  {v.createdByUsername ? ` · ${v.createdByUsername}` : ""}
                </p>
              </div>
              {canRestore && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t("files.versions.restoreLabel", { version: v.version })}
                  disabled={restoring === v.version}
                  onClick={() => void handleRestore(v.version)}
                >
                  {restoring === v.version ? (
                    <Spinner size="sm" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialogs}
    </div>
  );
}
