"use client";

import { useCallback, useState } from "react";
import {
  Check, Clock, Copy, ExternalLink, Eye, File, FileText, Film, Image as ImageIcon,
  Link as LinkIcon, Loader2, Lock, Music, Pencil, Shield, Timer, type LucideIcon,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Badge } from "@/ui/primitives/badge";
import { Field } from "@/ui/primitives/field";
import { Modal } from "@/ui/primitives/modal";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { apiErrorMessage, useT, type TranslationKey, type Translator } from "@/shared/lib/i18n";

interface ShareDialogProps {
  fileId: string;
  fileName: string;
  fileType?: string;
  isNote?: boolean;
  onClose: () => void;
}

type Step = "configure" | "created";

/**
 * The lifetime chips. Each carries its own key rather than being derived from
 * `minutes`: “24 hours” and “7 days” are choices of wording, and no locale can
 * shorten them automatically.
 */
const DURATION_PRESETS: { labelKey: TranslationKey; minutes: number | null }[] = [
  { labelKey: "files.share.preset.min1", minutes: 1 },
  { labelKey: "files.share.preset.min5", minutes: 5 },
  { labelKey: "files.share.preset.min30", minutes: 30 },
  { labelKey: "files.share.preset.hour1", minutes: 60 },
  { labelKey: "files.share.preset.hours24", minutes: 1440 },
  { labelKey: "files.share.preset.days7", minutes: 10080 },
  { labelKey: "files.share.preset.never", minutes: null },
];

const ACCESS_PRESETS = [1, 3, 5, 10, 25, 50];

function fileIconFor(mime?: string): LucideIcon {
  if (!mime) return File;
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.startsWith("video/")) return Film;
  if (mime.startsWith("audio/")) return Music;
  if (mime.includes("pdf")) return FileText;
  return File;
}

/** The icon arrives as a prop so it is never a component built during render. */
function Glyph({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon className={className} aria-hidden="true" />;
}

function durationLabel(minutes: number | null, t: Translator): string {
  if (minutes === null) return t("files.share.duration.never");
  if (minutes < 60) return t("files.share.duration.minutes", { count: minutes });
  if (minutes < 1440) return t("files.share.duration.hours", { count: Math.round(minutes / 60) });
  return t("files.share.duration.days", { count: Math.round(minutes / 1440) });
}

function limitLabel(maxAccess: number | null, t: Translator): string {
  if (maxAccess === null) return t("files.share.unlimitedOpens");
  return t("files.share.opens", { count: maxAccess });
}

/** Selection chip. `aria-pressed` carries the state for anyone who cannot see
 *  the accent fill. */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium",
        "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        active
          ? "border-accent bg-accent text-on-accent"
          : "border-border/60 bg-surface text-muted-foreground hover:border-accent/40 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Section({
  icon: Icon,
  title,
  value,
  children,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-background/40 p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          {title}
        </h3>
        <span className="text-xs font-medium text-muted-foreground">{value}</span>
      </div>
      {children}
    </section>
  );
}

/**
 * Creates a public share link. Two steps inside one dialog: configure the link,
 * then hand over the URL. Everything the link grants — permission, lifetime,
 * open count — is restated in one summary line before the button, because a
 * public URL is the one action here that cannot be taken back.
 */
export function ShareDialog({ fileId, fileName, fileType, isNote, onClose }: ShareDialogProps) {
  const t = useT();
  const [step, setStep] = useState<Step>("configure");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [duration, setDuration] = useState<number | null>(1440);
  const [maxAccess, setMaxAccess] = useState<number | null>(null);
  const [customAccess, setCustomAccess] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Only editable documents can grant write access; anything else is view-only
  // no matter what the picker says.
  const canEdit = Boolean(isNote);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    const res = await apiFetch<{ shareUrl: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify({
        fileId,
        permission: canEdit ? permission : "view",
        ...(duration !== null ? { expiresInMinutes: duration } : {}),
        ...(maxAccess !== null ? { maxAccessCount: maxAccess } : {}),
      }),
    });
    setCreating(false);
    if (!res.success || !res.data) {
      setError(apiErrorMessage(res, t, "files.share.createFailed"));
      return;
    }
    setShareUrl(res.data.shareUrl);
    setStep("created");
    // `t` is a dependency because the stored message is already translated: a
    // language switch has to re-read it rather than leave the old wording.
  }, [fileId, canEdit, permission, duration, maxAccess, t]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the URL stays selectable in the field */
    }
  }, [shareUrl]);

  function reset() {
    setStep("configure");
    setShareUrl("");
    setError(null);
    setCopied(false);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={step === "configure" ? LinkIcon : Check}
      tone={step === "configure" ? "accent" : "success"}
      title={step === "configure" ? t("files.share.title") : t("files.share.readyTitle")}
      description={
        step === "configure" ? (
          <span className="flex items-center gap-1.5">
            <Glyph icon={fileIconFor(fileType)} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{fileName}</span>
          </span>
        ) : (
          t("files.share.readyDescription")
        )
      }
      footer={
        step === "configure" ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={creating}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LinkIcon className="h-4 w-4" aria-hidden="true" />
              )}
              {creating ? t("files.share.creating") : t("files.share.create")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.done")}
            </Button>
            <Button size="sm" onClick={() => void handleCopy()}>
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? t("common.copied") : t("files.share.copyLink")}
            </Button>
          </>
        )
      }
    >
      {step === "configure" ? (
        <div className="space-y-3">
          <Section
            icon={Shield}
            title={t("files.share.permission")}
            value={permission === "edit" ? t("common.canEdit") : t("common.viewOnly")}
          >
            {canEdit ? (
              <div className="flex flex-wrap gap-1.5">
                <Chip active={permission === "view"} onClick={() => setPermission("view")}>
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" /> {t("common.viewOnly")}
                </Chip>
                <Chip active={permission === "edit"} onClick={() => setPermission("edit")}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> {t("common.canEdit")}
                </Chip>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t("files.share.viewOnlyNote")}
              </p>
            )}
          </Section>

          <Section
            icon={Timer}
            title={t("files.share.expires")}
            value={durationLabel(duration, t)}
          >
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((preset) => (
                <Chip
                  key={preset.labelKey}
                  active={duration === preset.minutes}
                  onClick={() => setDuration(preset.minutes)}
                >
                  {preset.minutes === null && (
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t(preset.labelKey)}
                </Chip>
              ))}
            </div>
          </Section>
          <Section icon={Eye} title={t("files.share.limit")} value={limitLabel(maxAccess, t)}>
            <div className="flex flex-wrap gap-1.5">
              <Chip
                active={maxAccess === null && !customAccess}
                onClick={() => {
                  setCustomAccess(false);
                  setMaxAccess(null);
                }}
              >
                {t("files.share.unlimited")}
              </Chip>
              {ACCESS_PRESETS.map((n) => (
                <Chip
                  key={n}
                  active={!customAccess && maxAccess === n}
                  onClick={() => {
                    setCustomAccess(false);
                    setMaxAccess(n);
                  }}
                >
                  {n}
                </Chip>
              ))}
              <Chip active={customAccess} onClick={() => setCustomAccess(true)}>
                {t("files.share.custom")}
              </Chip>
            </div>
            {customAccess && (
              <Field
                label={t("files.share.customLabel")}
                hint={t("files.share.customHint")}
                className="mt-2.5"
              >
                {(field) => (
                  <Input
                    {...field}
                    type="number"
                    min={1}
                    max={999}
                    value={maxAccess ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === "") return setMaxAccess(null);
                      const n = Number(raw);
                      setMaxAccess(Number.isFinite(n) ? Math.min(999, Math.max(1, Math.trunc(n))) : null);
                    }}
                    className="h-9 w-28"
                  />
                )}
              </Field>
            )}
          </Section>

          <p className="flex items-start gap-1.5 rounded-xl border border-border/60 bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/* One interpolated sentence. The three values were emphasised spans
                lowercased at render, and neither the emphasis nor `toLowerCase`
                survives a clause that reorders per language. */}
            <span>
              {t("files.share.summary", {
                access:
                  permission === "edit" && canEdit
                    ? t("files.share.accessEdit")
                    : t("files.share.accessReadOnly"),
                duration: durationLabel(duration, t),
                limit: limitLabel(maxAccess, t),
              })}
            </span>
          </p>

          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-danger-ink">
              <span aria-hidden="true" className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
              <span>{error}</span>
            </p>
          )}


        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl border border-success/30 bg-success/5 p-3">
            <label
              htmlFor="share-url"
              className="mb-1.5 block text-xs font-semibold text-foreground"
            >
              {t("files.share.linkLabel")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="share-url"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 flex-1 font-mono text-xs"
              />
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label={t("files.share.openInNewTab")}
                onClick={() => window.open(shareUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={permission === "edit" && canEdit ? "success" : "warning"}>
              {permission === "edit" && canEdit ? (
                <Pencil className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Eye className="h-3 w-3" aria-hidden="true" />
              )}
              {permission === "edit" && canEdit ? t("common.canEdit") : t("common.viewOnly")}
            </Badge>
            <Badge tone="neutral">
              <Timer className="h-3 w-3" aria-hidden="true" />
              {durationLabel(duration, t)}
            </Badge>
            <Badge tone="neutral">
              <Eye className="h-3 w-3" aria-hidden="true" />
              {limitLabel(maxAccess, t)}
            </Badge>
          </div>

          <Button variant="ghost" size="sm" onClick={reset} className="w-full">
            <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {t("files.share.another")}
          </Button>

        </div>
      )}
    </Modal>
  );
}
