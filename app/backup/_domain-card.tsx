"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  Download,
  Inbox,
  Loader2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";
import type { BackupDomain } from "@backup/domain/types";

/**
 * One figure on a card.
 *
 * `hint` exists for a total that cannot be understood on its own. The Brain card's "Memories" is
 * the case it was added for: it counts live rows, which is what the archive carries, while `/brain`
 * splits the same rows into active and archived tiles. Printing 9 next to that page's 3 without
 * saying "3 active · 6 archived" is how a correct number reads as a bug.
 */
interface DomainStat {
  label: string;
  value: string | number;
  hint?: string;
}

interface DomainCardProps {
  /** Namespaces this card's element ids: two cards share the page and must not collide. */
  domain: BackupDomain;
  /** Sits in the tinted tile beside the title. Decorative — the heading carries the meaning. */
  icon: LucideIcon;
  title: string;
  subtitle: string;
  stats: DomainStat[];
  /** What this domain's archive quietly does *not* carry, in one sentence. */
  note?: string;
  isEmpty: boolean;
  blocked?: { count: number; message: string };
  /**
   * A ticket is being minted. The button locks for the round trip because a second click
   * would spend this domain's one allowed prepare for the next ten minutes.
   */
  downloading?: boolean;
  onDownload: () => void;
  onRestore: () => void;
  downloadDisabled?: boolean;
  /** Staggers the entrance behind the panel above. Ignored when motion is reduced. */
  delay?: number;
}

export function DomainCard({
  domain,
  icon: Icon,
  title,
  subtitle,
  stats,
  note,
  isEmpty,
  blocked,
  downloading = false,
  onDownload,
  onRestore,
  downloadDisabled,
  delay = 0,
}: DomainCardProps) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const titleId = `backup-card-${domain}-title`;
  const blockedId = `backup-card-${domain}-blocked`;

  return (
    <motion.section
      aria-labelledby={titleId}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, delay, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface p-6",
        // Shadow only: a hover that moved the card would shift the button under the cursor.
        "shadow-sm transition-shadow duration-200 hover:shadow-md"
      )}
    >
      {/* Decorative hairline. Carries no text, so the gradient's contrast is nobody's problem. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-[image:var(--accent-gradient)] opacity-70"
      />

      <div className="mb-5 flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/10 ring-1 ring-accent/20"
        >
          <Icon className="h-5 w-5 text-accent-ink" />
        </span>
        <div className="min-w-0">
          <h3 id={titleId} className="text-lg font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      {blocked && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning-ink" aria-hidden="true" />
          <p id={blockedId} className="text-sm leading-relaxed text-foreground">
            {blocked.message}
          </p>
        </div>
      )}

      {isEmpty ? (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-dashed border-border/70 bg-background-secondary/50 p-4">
          <Inbox className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t("backup.card.empty")}</p>
        </div>
      ) : (
        <dl
          className={cn(
            "mb-4 grid gap-4 rounded-xl border border-border/50 bg-background-secondary/50 p-4",
            stats.length >= 3 ? "grid-cols-3" : "grid-cols-2"
          )}
        >
          {stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </dt>
              <dd className="truncate text-xl font-semibold tabular-nums text-foreground">
                {stat.value}
              </dd>
              {stat.hint !== undefined && (
                <dd className="mt-0.5 truncate text-xs text-muted-foreground" title={stat.hint}>
                  {stat.hint}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}

      {note !== undefined && !isEmpty && (
        <p className="mb-5 text-xs leading-relaxed text-muted-foreground">{note}</p>
      )}

      {/* Pushed to the bottom so two cards of unequal height still line their actions up. */}
      <div className="mt-auto flex flex-col gap-3 sm:flex-row">
        <Button
          onClick={onDownload}
          disabled={isEmpty || downloadDisabled || downloading}
          aria-describedby={blocked ? blockedId : undefined}
          className="flex-1"
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
          {downloading ? t("backup.download.preparing") : t("backup.card.download")}
        </Button>
        <Button onClick={onRestore} variant="secondary" className="flex-1">
          <Upload className="h-4 w-4" aria-hidden="true" />
          {t("backup.card.restore")}
        </Button>
      </div>
    </motion.section>
  );
}
