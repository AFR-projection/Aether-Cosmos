"use client";

import { useId, useRef } from "react";
import { CopyPlus, Replace, SkipForward, TriangleAlert } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Modal } from "@/ui/primitives/modal";
import { cn } from "@/shared/lib/utils";
import { useT } from "@/shared/lib/i18n";
import type { ConflictPolicy } from "@files/domain/services/paste-plan";
import type { PasteConflict } from "@files/presentation/hooks/use-paste";

/** How many colliding names are listed before the rest collapse into "and N more". */
const PREVIEW = 4;

interface PasteConflictDialogProps {
  /** `null` while no paste is waiting on an answer. */
  conflict: PasteConflict | null;
  /** The destination folder's name, for the sentence the dialog opens with. */
  destinationName: string;
}

/**
 * Explorer's name-clash prompt, with one difference that matters: the decision applies to
 * every clash in this paste at once. Asking per item would mean a dialog every few
 * hundred milliseconds through a 400-file paste, and the answer is almost never per item.
 */
export function PasteConflictDialog({ conflict, destinationName }: PasteConflictDialogProps) {
  const t = useT();
  // Focus opens on "keep both" rather than on the dialog's ✕. The default a keyboard user
  // lands on should be the one that cannot lose data, and ✕ cancels the whole paste.
  const keepBothRef = useRef<HTMLButtonElement>(null);
  if (!conflict) return null;

  const collided = conflict.files.length + conflict.folders.length;
  // `decide` resolves the promise the paste is parked on, so closing the dialog any other
  // way — Escape, the scrim, ✕ — has to be a cancel, never a silent hang.
  const choose = (policy: ConflictPolicy | null) => conflict.decide(policy);

  const options: Array<{
    policy: ConflictPolicy;
    label: string;
    hint: string;
    icon: typeof CopyPlus;
    /** The one option that discards something, marked so it does not read as a peer. */
    destructive?: boolean;
  }> = [
    {
      policy: "keep-both",
      label: t("files.paste.conflict.keepBoth"),
      hint: t("files.paste.conflict.keepBothHint"),
      icon: CopyPlus,
    },
    {
      policy: "replace",
      label: t("files.paste.conflict.replace"),
      hint: t("files.paste.conflict.replaceHint"),
      icon: Replace,
      destructive: true,
    },
    {
      policy: "skip",
      label: t("files.paste.conflict.skip"),
      hint: t("files.paste.conflict.skipHint"),
      icon: SkipForward,
    },
  ];

  return (
    <Modal
      open
      onClose={() => choose(null)}
      icon={TriangleAlert}
      tone="warning"
      size="lg"
      initialFocusRef={keepBothRef}
      title={t("files.paste.conflict.title", { count: collided })}
      description={t(
        conflict.mode === "cut" ? "files.paste.conflict.bodyMove" : "files.paste.conflict.bodyCopy",
        { folder: destinationName }
      )}
      footer={
        <div className="flex w-full justify-end">
          <Button variant="ghost" size="sm" onClick={() => choose(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <NameList
          label={t("files.paste.conflict.foldersLabel")}
          names={conflict.folders.map((item) => item.sourceName)}
          t={t}
        />
        <NameList
          label={t("files.paste.conflict.filesLabel")}
          names={conflict.files.map((item) => item.sourceName)}
          t={t}
        />

        <div className="space-y-2">
          {options.map((option) => (
            <button
              key={option.policy}
              ref={option.policy === "keep-both" ? keepBothRef : undefined}
              type="button"
              onClick={() => choose(option.policy)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border bg-surface px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                option.destructive
                  ? "border-danger/30 hover:border-danger/50 hover:bg-danger/5"
                  : "border-border/60 hover:border-accent/40 hover:bg-surface-hover"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  option.destructive ? "bg-danger/10" : "bg-accent/10"
                )}
              >
                <option.icon
                  className={cn("h-4 w-4", option.destructive ? "text-danger-ink" : "text-accent-ink")}
                  aria-hidden="true"
                />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {/* A folder "replace" would delete a whole subtree, so the endpoint merges instead.
            Said here rather than discovered afterwards. */}
        {conflict.folders.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("files.paste.conflict.replaceFolders")}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** One labelled group of colliding names, truncated so the options stay above the fold. */
function NameList({
  label,
  names,
  t,
}: {
  label: string;
  names: string[];
  t: ReturnType<typeof useT>;
}) {
  // Ties the caption to the list it captions. Stacking a paragraph on top of a list is a
  // visual relationship only, and a screen reader reads the names with no idea what they are.
  const labelId = useId();
  if (names.length === 0) return null;
  const shown = names.slice(0, PREVIEW);
  const rest = names.length - shown.length;

  return (
    <div>
      <p id={labelId} className="text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <ul aria-labelledby={labelId} className="mt-1 space-y-0.5 text-sm">
        {shown.map((name) => (
          <li key={name} className="truncate">
            {name}
          </li>
        ))}
        {rest > 0 && (
          <li className="text-xs text-muted-foreground">
            {t("files.paste.conflict.more", { count: rest })}
          </li>
        )}
      </ul>
    </div>
  );
}
