"use client";

import { Archive } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { useT, useFormat } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";
import type { TranslationKey } from "@/shared/lib/i18n";
import type { InspectResponse, SplitReason } from "./_types";
import type { RestoreMode } from "@backup/account/application/import-types";

interface PreviewDialogProps {
  open: boolean;
  preview: InspectResponse | null;
  mode: RestoreMode;
  /** True while a mode switch is in flight: this dialog stays up, its actions do not. */
  busy: boolean;
  onModeChange: (mode: RestoreMode) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Why the four numbers below are estimates, when they are. §7.2: they may be stated as fact
 * only when they came from the archive's own index — otherwise the reason is named, because a
 * number nobody can reconcile with the final report is worse than no number.
 */
const SPLIT_REASON_KEY: Record<Exclude<SplitReason, "ok">, TranslationKey> = {
  "brain-has-no-split": "backup.split.reasonBrain",
  "index-too-large": "backup.split.reasonIndexTooLarge",
  "need-more-bytes": "backup.split.reasonNeedMoreBytes",
  "over-row-cap": "backup.split.reasonOverRowCap",
};

export function PreviewDialog({
  open,
  preview,
  mode,
  busy,
  onModeChange,
  onConfirm,
  onClose,
}: PreviewDialogProps) {
  const t = useT();
  const { formatBytes, formatNumber, formatDate } = useFormat();

  if (!preview) return null;

  const { summary, ownership, capacity, split, splitExact, splitReason } = preview;
  const isFiles = preview.domain === "files";

  const meta: Array<{ label: string; value: string; mono?: boolean; wide?: boolean }> = [
    { label: t("backup.preview.written"), value: formatDate(preview.createdAt, "medium") },
    { label: t("backup.preview.version"), value: String(preview.formatVersion) },
    {
      label: t("backup.preview.archiveId"),
      value: summary.accountBackupIdDisplay,
      mono: true,
    },
    { label: t("backup.preview.sourceInstance"), value: summary.sourceInstanceId, mono: true },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      icon={Archive}
      title={t("backup.preview.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {ownership.restorable && (
            <Button onClick={onConfirm} disabled={busy}>
              {mode === "merge" ? t("backup.start.merge") : t("backup.start.replace")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border/60 bg-surface p-4">
          {meta.map((row) => (
            <div key={row.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "truncate text-sm font-medium text-foreground",
                  row.mono && "font-mono"
                )}
                title={row.mono ? row.value : undefined}
              >
                {row.value}
              </dd>
            </div>
          ))}
          {summary.email && (
            <div className="col-span-2 min-w-0">
              <dt className="text-xs text-muted-foreground">
                {t("backup.preview.email")}{" "}
                <span className="text-muted-foreground/70">
                  ({t("backup.preview.emailHint")})
                </span>
              </dt>
              <dd className="truncate text-sm font-medium text-foreground">{summary.email}</dd>
            </div>
          )}
        </dl>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("backup.preview.contents")}
          </h3>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border/60 bg-surface p-3">
              <dt className="text-xs text-muted-foreground">{t("backup.preview.rows")}</dt>
              <dd className="text-lg font-semibold tabular-nums text-foreground">
                {formatNumber(summary.counts.rows)}
              </dd>
            </div>
            <div className="rounded-xl border border-border/60 bg-surface p-3">
              <dt className="text-xs text-muted-foreground">{t("backup.preview.payload")}</dt>
              <dd className="text-lg font-semibold tabular-nums text-foreground">
                {formatBytes(summary.totalBytes)}
              </dd>
            </div>
          </dl>
        </section>

        {/* Which key opened it, and whether that key is still the current one. */}
        <div className="space-y-1 text-sm">
          <p className="text-foreground">
            {preview.via === "phrase"
              ? t("backup.preview.openedByPhrase")
              : t("backup.preview.openedByServer")}
          </p>
          {preview.stale && (
            <p className="text-warning-ink">{t("backup.preview.staleKey")}</p>
          )}
        </div>

        <div className="space-y-2 rounded-xl border border-border/60 p-4">
          {ownership.bound && (
            <p className="text-sm text-foreground">{t("backup.preview.bound")}</p>
          )}
          {ownership.willAdopt && (
            <p className="text-sm text-foreground">{t("backup.preview.willAdopt")}</p>
          )}
          {!ownership.restorable && (
            <>
              <p className="text-sm font-medium text-danger-ink">
                {t("backup.preview.notRestorable")}
              </p>
              {!capacity.withinRowCaps && (
                <p className="text-sm text-muted-foreground">
                  {t("backup.preview.overCap", {
                    rows: formatNumber(capacity.rows),
                    cap: formatNumber(capacity.cap),
                  })}
                </p>
              )}
            </>
          )}
        </div>

        {ownership.restorable && (
          <>
            <section>
              <h3
                id="backupModeHeading"
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t("backup.mode.heading")}
              </h3>
              {/* Buttons with aria-pressed rather than role="radio": a real radiogroup owes
                  the user arrow-key traversal, and these stay plain tab stops. */}
              <div
                role="group"
                aria-labelledby="backupModeHeading"
                className="grid gap-3 sm:grid-cols-2"
              >
                {(["merge", "replace"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onModeChange(option)}
                    disabled={busy}
                    aria-pressed={mode === option}
                    className={cn(
                      "rounded-xl border p-4 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      mode === option
                        ? "border-accent/50 bg-accent/5"
                        : "border-border/60 hover:border-accent/30 hover:bg-surface-hover"
                    )}
                  >
                    <p className="mb-1 text-sm font-semibold text-foreground">
                      {option === "merge"
                        ? t("backup.mode.mergeTitle")
                        : t("backup.mode.replaceTitle")}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {option === "merge"
                        ? t("backup.mode.mergeBody")
                        : isFiles
                          ? t("backup.mode.replaceBodyFiles")
                          : t("backup.mode.replaceBodyBrain")}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            {split && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("backup.split.heading")}
                </h3>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: t("backup.split.restored"), value: formatNumber(split.restored) },
                    { label: t("backup.split.skipped"), value: formatNumber(split.skipped) },
                    { label: t("backup.split.renamed"), value: formatNumber(split.renamed) },
                    {
                      label: t("backup.split.newFolders"),
                      value: formatNumber(split.newFolders),
                    },
                  ].map((cell) => (
                    <div
                      key={cell.label}
                      className="rounded-xl border border-border/60 bg-surface p-3"
                    >
                      <dt className="text-xs text-muted-foreground">{cell.label}</dt>
                      <dd className="text-base font-semibold tabular-nums text-foreground">
                        {cell.value}
                      </dd>
                    </div>
                  ))}
                  <div className="col-span-2 rounded-xl border border-border/60 bg-surface p-3 sm:col-span-4">
                    <dt className="text-xs text-muted-foreground">{t("backup.split.bytes")}</dt>
                    <dd className="text-base font-semibold tabular-nums text-foreground">
                      {formatBytes(split.bytes)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {splitExact ? t("backup.split.exact") : t("backup.split.inexact")}
                  {!splitExact && splitReason !== "ok" && (
                    <> {t(SPLIT_REASON_KEY[splitReason])}</>
                  )}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
