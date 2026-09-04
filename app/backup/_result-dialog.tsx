"use client";

import { AlertCircle, CheckCircle2, Network } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { useT, useFormat } from "@/shared/lib/i18n";
import type { RestoreResponse } from "./_types";

interface ResultDialogProps {
  open: boolean;
  result: RestoreResponse | null;
  onClose: () => void;
}

export function ResultDialog({ open, result, onClose }: ResultDialogProps) {
  const t = useT();
  const { formatBytes, formatNumber } = useFormat();

  if (!result) return null;

  const { report, adopted, expected, removed, graph } = result;

  const figures: Array<{ label: string; value: string }> = [
    { label: t("backup.result.rows"), value: formatNumber(report.rows) },
    { label: t("backup.result.bytes"), value: formatBytes(report.bytes) },
    { label: t("backup.result.skipped"), value: formatNumber(report.skipped) },
    { label: t("backup.result.renamed"), value: formatNumber(report.renamed) },
  ];

  /**
   * The derived graph, which is the one thing here that has not happened yet.
   *
   * Only a Brain restore has a graph at all, and only a brain that exists can be swept — a zero
   * means there was nothing to ask for, not that something failed. Below that, `queued < brains`
   * is the sentence worth printing: the rows are in, the worker is not reachable, and the map
   * between them rebuilds later. Saying nothing is what made an empty `/brain/graph` look like
   * lost data.
   */
  const graphAllQueued = graph !== null && graph.queued >= graph.brains;
  const showGraph = graph !== null && graph.brains > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={CheckCircle2}
      tone="success"
      title={t("backup.result.title")}
      footer={<Button onClick={onClose}>{t("backup.result.close")}</Button>}
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border/60 bg-surface p-4">
          {figures.map((figure) => (
            <div key={figure.label}>
              <dt className="text-xs text-muted-foreground">{figure.label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-foreground">
                {figure.value}
              </dd>
            </div>
          ))}
        </dl>

        {removed && (
          <p className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
            {"folders" in removed
              ? t("backup.result.removedFiles", {
                  folders: formatNumber(removed.folders),
                  files: formatNumber(removed.files),
                })
              : t("backup.result.removedBrain", {
                  rows: formatNumber(removed.rows),
                  tables: formatNumber(removed.tables),
                })}
          </p>
        )}

        {showGraph && (
          <div
            className={
              graphAllQueued
                ? "flex items-start gap-3 rounded-xl border border-info/30 bg-info/10 p-3"
                : "flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3"
            }
          >
            {graphAllQueued ? (
              <Network className="mt-0.5 h-5 w-5 shrink-0 text-info-ink" aria-hidden="true" />
            ) : (
              <AlertCircle
                className="mt-0.5 h-5 w-5 shrink-0 text-warning-ink"
                aria-hidden="true"
              />
            )}
            <p className="text-sm leading-relaxed text-foreground">
              {graphAllQueued
                ? t("backup.result.graphQueued")
                : t("backup.result.graphPending")}
            </p>
          </div>
        )}

        {adopted && (
          <p className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm text-foreground">
            {t("backup.result.adopted")}
          </p>
        )}

        {/* What the archive said it held, so a short report can be reconciled rather than doubted. */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("backup.result.expected", {
            rows: formatNumber(expected.rows),
            bytes: formatBytes(expected.bytes),
          })}
        </p>
      </div>
    </Modal>
  );
}
