"use client";

import { useCallback, useState } from "react";
import {
  Check, Clock, Copy, ExternalLink, Eye, File, FileText, Film, Image as ImageIcon,
  Link as LinkIcon, Loader2, Lock, Music, Pencil, Shield, Timer, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
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

const DURATION_PRESETS: { label: string; minutes: number | null }[] = [
  { label: "1 min", minutes: 1 },
  { label: "5 min", minutes: 5 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 1440 },
  { label: "7 days", minutes: 10080 },
  { label: "Never", minutes: null },
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

function durationLabel(minutes: number | null): string {
  if (minutes === null) return "Never expires";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

function limitLabel(maxAccess: number | null): string {
  if (maxAccess === null) return "Unlimited opens";
  return `${maxAccess} open${maxAccess === 1 ? "" : "s"}`;
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
      setError(res.error ?? "Could not create the share link.");
      return;
    }
    setShareUrl(res.data.shareUrl);
    setStep("created");
  }, [fileId, canEdit, permission, duration, maxAccess]);

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
      title={step === "configure" ? "Create share link" : "Share link ready"}
      description={
        step === "configure" ? (
          <span className="flex items-center gap-1.5">
            <Glyph icon={fileIconFor(fileType)} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{fileName}</span>
          </span>
        ) : (
          "Anyone with this link can open the file — no account needed."
        )
      }
      footer={
        step === "configure" ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={creating}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LinkIcon className="h-4 w-4" aria-hidden="true" />
              )}
              {creating ? "Creating…" : "Create link"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Done
            </Button>
            <Button size="sm" onClick={() => void handleCopy()}>
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </>
        )
      }
    >
      {step === "configure" ? (
        <div className="space-y-3">
          <Section
            icon={Shield}
            title="Permission"
            value={permission === "edit" ? "Can edit" : "View only"}
          >
            {canEdit ? (
              <div className="flex flex-wrap gap-1.5">
                <Chip active={permission === "view"} onClick={() => setPermission("view")}>
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" /> View only
                </Chip>
                <Chip active={permission === "edit"} onClick={() => setPermission("edit")}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Can edit
                </Chip>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                This file type can only be shared for viewing.
              </p>
            )}
          </Section>

          <Section icon={Timer} title="Link expires" value={durationLabel(duration)}>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((preset) => (
                <Chip
                  key={preset.label}
                  active={duration === preset.minutes}
                  onClick={() => setDuration(preset.minutes)}
                >
                  {preset.minutes === null && (
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {preset.label}
                </Chip>
              ))}
            </div>
          </Section>
          <Section icon={Eye} title="Open limit" value={limitLabel(maxAccess)}>
            <div className="flex flex-wrap gap-1.5">
              <Chip
                active={maxAccess === null && !customAccess}
                onClick={() => {
                  setCustomAccess(false);
                  setMaxAccess(null);
                }}
              >
                Unlimited
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
                Custom
              </Chip>
            </div>
            {customAccess && (
              <Field
                label="Custom open limit"
                hint="Leave empty for unlimited opens."
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
            <span>
              Anyone with the link gets{" "}
              <span className="font-medium text-foreground">
                {permission === "edit" && canEdit ? "edit" : "read-only"}
              </span>{" "}
              access ·{" "}
              <span className="font-medium text-foreground">{durationLabel(duration).toLowerCase()}</span>{" "}
              · <span className="font-medium text-foreground">{limitLabel(maxAccess).toLowerCase()}</span>
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
              Share link
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
                aria-label="Open link in a new tab"
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
              {permission === "edit" && canEdit ? "Can edit" : "View only"}
            </Badge>
            <Badge tone="neutral">
              <Timer className="h-3 w-3" aria-hidden="true" />
              {durationLabel(duration)}
            </Badge>
            <Badge tone="neutral">
              <Eye className="h-3 w-3" aria-hidden="true" />
              {limitLabel(maxAccess)}
            </Badge>
          </div>

          <Button variant="ghost" size="sm" onClick={reset} className="w-full">
            <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Create another link with different settings
          </Button>

        </div>
      )}
    </Modal>
  );
}
