"use client";

import { useState, useEffect, useId, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings2,
  Shield,
  HardDrive,
  FileWarning,
  Sliders,
  Eye,
  EyeOff,
  Loader2,
  X,
  Database,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Users,
  Mail,
  Search,
  Clock,
  Info,
  Plus,
  Share2,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import type { AdminSettings } from "@/app/api/admin/settings/route";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import {
  AdminEmpty,
  AdminHeader,
  AdminPanel,
  Chip,
  FilterChip,
  IconButton,
  Note,
  SearchField,
  Skeleton,
  Switch,
} from "@admin/presentation/components/admin-ui";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { useT, type Translator } from "@/shared/lib/i18n";

/* ── Section definition ──────────────────────────────────────────────────────
   Sections are told apart by icon and title, not by colour: the previous version
   gave each one its own two-stop gradient (slate, emerald, violet, amber, blue,
   rose), which spent six hues on a distinction the reader already had. */

interface SettingField {
  key: keyof AdminSettings;
  label: string;
  description: string;
  type: "text" | "number" | "toggle" | "select" | "tags" | "password";
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  sensitive?: boolean;
}

interface Section {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  fields: SettingField[];
  /** Extra panel rendered under the fields — status the admin needs to trust the settings. */
  footer?: "cleanup";
}

interface CleanupState {
  lastRunAt: string | null;
  lastSource: "worker" | "app" | null;
  lastResult: {
    trashFiles: number;
    trashFolders: number;
    lifetimeSoftDeleted: number;
    logsDeleted: number;
  } | null;
  lastError: string | null;
}

interface SettingsMeta {
  totalUsers?: number;
  cleanup?: CleanupState | null;
  /**
   * Whether this deployment counts as production. Only used to resolve the "auto"
   * choice for IP binding into the answer that actually applies here, so "auto"
   * is not a mystery to whoever picked it.
   */
  productionMode?: boolean;
}

/** Drops the server-only `_meta` block so the editable draft holds settings alone. */
function stripMeta(payload: AdminSettings & { _meta?: unknown }): AdminSettings {
  const clone: AdminSettings & { _meta?: unknown } = { ...payload };
  delete clone._meta;
  return clone as AdminSettings;
}

const SETTING_SECTIONS: Section[] = [
  {
    id: "general",
    title: "General",
    description: "Core platform settings and maintenance controls",
    icon: Settings2,
    fields: [
      { key: "registrationEnabled", label: "Allow Registration", description: "Show public Sign up page and allow self-service accounts", type: "toggle" },
      { key: "allowedEmailDomains", label: "Allowed Email Domains", description: "Restrict sign-ups to these domains and their subdomains. Empty means any address is accepted. Existing accounts are never affected.", type: "tags", placeholder: "example.com" },
      { key: "maintenanceMode", label: "Maintenance Mode", description: "Block all user access except admins", type: "toggle" },
      { key: "maintenanceMessage", label: "Maintenance Message", description: "Message shown to users during maintenance", type: "text", placeholder: "System is under maintenance..." },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    description: "Quotas, upload ceilings and signed-URL lifetimes",
    icon: HardDrive,
    fields: [
      { key: "defaultQuotaGB", label: "Default Quota", description: "Storage quota for new users", type: "number", unit: "GB", min: 1, max: 10000 },
      { key: "maxUploadSizeMB", label: "Max Upload Size", description: "Maximum file size per upload. This is the only ceiling — there is no env override.", type: "number", unit: "MB", min: 1, max: 5120 },
      { key: "storageWarningThreshold", label: "Warning Threshold", description: "Notify users when storage exceeds this percentage", type: "number", unit: "%", min: 50, max: 100 },
      { key: "defaultBandwidthQuotaGB", label: "Default Bandwidth Quota", description: "Download allowance for new accounts on a rolling 30-day window. 0 means unmetered, which is what every account got before this was configurable.", type: "number", unit: "GB", min: 0, max: 1000000 },
      { key: "uploadUrlExpiryMinutes", label: "Upload URL Lifetime", description: "How long a signed upload URL stays valid. Long enough for a slow connection to finish a large part, short enough that a leaked URL goes stale.", type: "number", unit: "minutes", min: 1, max: 720 },
      { key: "downloadUrlExpirySeconds", label: "Download URL Lifetime", description: "How long a signed download URL stays valid. Anyone holding the URL can fetch the file until it expires, so keep it short.", type: "number", unit: "seconds", min: 15, max: 3600 },
    ],
  },
  {
    id: "security",
    title: "Security",
    description: "Session lifetime, binding and the second factor",
    icon: Shield,
    fields: [
      { key: "sessionDurationHours", label: "Session Duration", description: "How long a session stays valid before the user must sign in again", type: "number", unit: "hours", min: 1, max: 8760 },
      { key: "sessionIdleTimeoutMinutes", label: "Idle Timeout", description: "Sign a user out after this long with no activity. 0 disables it, which is the default — whichever of this and Session Duration is shorter is the one that ends the session.", type: "number", unit: "minutes", min: 0, max: 10080 },
      {
        key: "sessionIpBinding",
        label: "IP Binding",
        description: "Revoke a session when the client IP changes. Stops a stolen cookie being replayed elsewhere, but signs out anyone on a shifting mobile or VPN address.",
        type: "select",
        options: [
          { label: "Auto (production only)", value: "auto" },
          { label: "Always on", value: "on" },
          { label: "Always off", value: "off" },
        ],
      },
      { key: "maxSessionsPerUser", label: "Max Sessions", description: "Concurrent sessions per user — the oldest is signed out when exceeded", type: "number", unit: "sessions", min: 1, max: 100 },
      { key: "stepCodeRequired", label: "Require 2-Step Code", description: "Every user must set a numpad code entered after their password. Users without one are prompted to create it at next sign-in and cannot remove it.", type: "toggle" },
    ],
  },
  {
    id: "limits",
    title: "Access Limits",
    description: "Request throttling and failed-login lockout",
    icon: Gauge,
    fields: [
      { key: "rateLimitPerMinute", label: "Rate Limit", description: "API requests per minute per user. Upload endpoints get 5× this value.", type: "number", unit: "req/min", min: 10, max: 1000 },
      { key: "loginMaxAttempts", label: "Failed Logins per Account", description: "Wrong passwords before the account itself is locked for the window below. The floor is 3: a lower value locks an account on the first typo, which turns the lockout into a denial-of-service anyone can trigger with a username.", type: "number", unit: "attempts", min: 3, max: 50 },
      { key: "loginIpMaxAttempts", label: "Failed Logins per IP", description: "Failed attempts from one IP address before it is throttled. Keep this well above the per-account number so a shared office address is not locked out by one forgetful person.", type: "number", unit: "attempts", min: 5, max: 500 },
      { key: "loginLockoutMinutes", label: "Lockout Window", description: "How long a locked account or throttled IP has to wait. This is also the window the failed attempts are counted over, and the number quoted to the user in the message they see.", type: "number", unit: "minutes", min: 1, max: 1440 },
    ],
  },
  {
    id: "sharing",
    title: "Sharing",
    description: "Public link policy and expiry ceilings",
    icon: Share2,
    fields: [
      { key: "publicSharingEnabled", label: "Allow Public Links", description: "Let owners mint links that anyone with the URL can open. Turning this off stops new links being created; links that already exist keep working.", type: "toggle" },
      { key: "shareDefaultExpiryDays", label: "Default Link Expiry", description: "Expiry applied when the person sharing does not pick one. 0 means such a link never expires.", type: "number", unit: "days", min: 0, max: 3650 },
      { key: "shareMaxExpiryDays", label: "Maximum Link Expiry", description: "Longest expiry anyone may ask for — a longer request is capped to this. 0 removes the ceiling entirely.", type: "number", unit: "days", min: 0, max: 3650 },
    ],
  },
  {
    id: "files",
    title: "Files",
    description: "File policies, expiration and cleanup rules",
    icon: FileWarning,
    footer: "cleanup",
    fields: [
      { key: "maxFileLifetimeDays", label: "Max File Lifetime", description: "Auto-delete files after this many days (0 = unlimited)", type: "number", unit: "days", min: 0, max: 3650 },
      { key: "autoDeleteTrashDays", label: "Auto Delete Trash", description: "Automatically empty trash after this many days", type: "number", unit: "days", min: 0, max: 365 },
      { key: "blockedExtensions", label: "Blocked Extensions", description: "File extensions blocked from upload", type: "tags", placeholder: ".exe" },
      { key: "allowedMimeTypes", label: "Allowed MIME Types", description: "Restrict by MIME type (*/* for all)", type: "tags", placeholder: "image/*" },
    ],
  },
  {
    id: "retention",
    title: "Retention",
    description: "Activity log retention",
    icon: Database,
    footer: "cleanup",
    fields: [
      { key: "logRetentionDays", label: "Log Retention", description: "How long to keep activity logs", type: "number", unit: "days", min: 7, max: 730 },
    ],
  },
  {
    id: "email",
    title: "Email Delivery",
    description: "Smart Gmail sender router — limits, failover and cooldown",
    icon: Mail,
    fields: [
      { key: "emailDailyLimitPerSender", label: "Daily Limit per Sender", description: "Default max emails a Gmail sender may send per day before the router rotates to another. Gmail's own cap is ~500/day.", type: "number", unit: "emails/day", min: 1, max: 2000 },
      { key: "emailFailureThreshold", label: "Failure Threshold", description: "Consecutive send failures before a sender is rested (put on cooldown)", type: "number", unit: "failures", min: 1, max: 20 },
      { key: "emailCooldownMinutes", label: "Cooldown Duration", description: "How long a sender rests after hitting the failure threshold, then it's retried automatically", type: "number", unit: "minutes", min: 1, max: 1440 },
    ],
  },
];

const SECTION_KEYS = {
  general: ["sectionGeneral", "sectionGeneralDesc"],
  storage: ["sectionStorage", "sectionStorageDesc"],
  security: ["sectionSecurity", "sectionSecurityDesc"],
  limits: ["sectionLimits", "sectionLimitsDesc"],
  sharing: ["sectionSharing", "sectionSharingDesc"],
  files: ["sectionFiles", "sectionFilesDesc"],
  retention: ["sectionRetention", "sectionRetentionDesc"],
  email: ["sectionEmail", "sectionEmailDesc"],
} as const;

const FIELD_KEYS: Partial<Record<keyof AdminSettings, [string, string]>> = {
  registrationEnabled: ["registrationLabel", "registrationDesc"],
  allowedEmailDomains: ["allowedDomainsLabel", "allowedDomainsDesc"],
  maintenanceMode: ["maintenanceModeLabel", "maintenanceModeDesc"],
  maintenanceMessage: ["maintenanceMessageLabel", "maintenanceMessageDesc"],
  defaultQuotaGB: ["defaultQuotaLabel", "defaultQuotaDesc"],
  maxUploadSizeMB: ["maxUploadLabel", "maxUploadDesc"],
  storageWarningThreshold: ["warningThresholdLabel", "warningThresholdDesc"],
  defaultBandwidthQuotaGB: ["defaultBandwidthLabel", "defaultBandwidthDesc"],
  uploadUrlExpiryMinutes: ["uploadUrlLifetimeLabel", "uploadUrlLifetimeDesc"],
  downloadUrlExpirySeconds: ["downloadUrlLifetimeLabel", "downloadUrlLifetimeDesc"],
  sessionDurationHours: ["sessionDurationLabel", "sessionDurationDesc"],
  sessionIdleTimeoutMinutes: ["idleTimeoutLabel", "idleTimeoutDesc"],
  sessionIpBinding: ["ipBindingLabel", "ipBindingDesc"],
  maxSessionsPerUser: ["maxSessionsLabel", "maxSessionsDesc"],
  stepCodeRequired: ["stepCodeRequiredLabel", "stepCodeRequiredDesc"],
  rateLimitPerMinute: ["rateLimitLabel", "rateLimitDesc"],
  loginMaxAttempts: ["loginAttemptsLabel", "loginAttemptsDesc"],
  loginIpMaxAttempts: ["loginIpAttemptsLabel", "loginIpAttemptsDesc"],
  loginLockoutMinutes: ["lockoutWindowLabel", "lockoutWindowDesc"],
  publicSharingEnabled: ["publicSharingLabel", "publicSharingDesc"],
  shareDefaultExpiryDays: ["defaultExpiryLabel", "defaultExpiryDesc"],
  shareMaxExpiryDays: ["maxExpiryLabel", "maxExpiryDesc"],
  maxFileLifetimeDays: ["maxLifetimeLabel", "maxLifetimeDesc"],
  autoDeleteTrashDays: ["autoDeleteTrashLabel", "autoDeleteTrashDesc"],
  blockedExtensions: ["blockedExtensionsLabel", "blockedExtensionsDesc"],
  allowedMimeTypes: ["allowedMimeLabel", "allowedMimeDesc"],
  logRetentionDays: ["logRetentionLabel", "logRetentionDesc"],
  emailDailyLimitPerSender: ["emailDailyLimitLabel", "emailDailyLimitDesc"],
  emailFailureThreshold: ["emailFailureThresholdLabel", "emailFailureThresholdDesc"],
  emailCooldownMinutes: ["emailCooldownLabel", "emailCooldownDesc"],
};

const UNIT_KEYS: Record<string, string> = {
  GB: "unitGB", MB: "unitMB", "%": "unitPercent", minutes: "unitMinutes",
  seconds: "unitSeconds", hours: "unitHours", sessions: "unitSessions",
  "req/min": "unitReqMin", attempts: "unitAttempts", days: "unitDays",
  "emails/day": "unitEmailsDay", failures: "unitFailures",
};

function localizedSections(t: Translator): Section[] {
  return SETTING_SECTIONS.map((section) => {
    const sectionKeys = SECTION_KEYS[section.id as keyof typeof SECTION_KEYS];
    return {
      ...section,
      title: t(`admin.settings.${sectionKeys[0]}` as Parameters<Translator>[0]),
      description: t(`admin.settings.${sectionKeys[1]}` as Parameters<Translator>[0]),
      fields: section.fields.map((field) => {
        const keys = FIELD_KEYS[field.key]!;
        const placeholderKey = field.key === "allowedEmailDomains" ? "allowedDomainsPlaceholder"
          : field.key === "maintenanceMessage" ? "maintenanceMessagePlaceholder"
          : field.key === "blockedExtensions" ? "blockedExtensionsPlaceholder"
          : field.key === "allowedMimeTypes" ? "allowedMimePlaceholder" : null;
        return {
          ...field,
          label: t(`admin.settings.${keys[0]}` as Parameters<Translator>[0]),
          description: t(`admin.settings.${keys[1]}` as Parameters<Translator>[0]),
          placeholder: placeholderKey
            ? t(`admin.settings.${placeholderKey}` as Parameters<Translator>[0])
            : field.placeholder,
          unit: field.unit && UNIT_KEYS[field.unit]
            ? t(`admin.settings.${UNIT_KEYS[field.unit]}` as Parameters<Translator>[0])
            : field.unit,
          options: field.key === "sessionIpBinding" ? [
            { label: t("admin.settings.ipBindingAuto"), value: "auto" },
            { label: t("admin.settings.ipBindingOn"), value: "on" },
            { label: t("admin.settings.ipBindingOff"), value: "off" },
          ] : field.options,
        };
      }),
    };
  });
}

/* ── Session duration ────────────────────────────────────────────────────────
   Session length is the one setting on this page that is genuinely hard to type
   correctly (it is stored in hours, and "8760" means a year), so it gets presets
   plus a plain-language readout instead of a bare number box. */

interface SessionPreset {
  label: string;
  hours: number;
  sublabel?: string;
}

const SESSION_PRESETS: SessionPreset[] = [
  { label: "30 min", hours: 0.5 },
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "8 hours", hours: 8, sublabel: "work day" },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168, sublabel: "default" },
  { label: "2 weeks", hours: 336 },
  { label: "1 month", hours: 720 },
  { label: "3 months", hours: 2160 },
  { label: "1 year", hours: 8760 },
];

function formatSessionDuration(hours: number, t: Translator): string {
  if (hours < 1) return t("admin.settings.durationMinutes", { count: Math.round(hours * 60) });
  if (hours < 24) return t("admin.settings.durationHours", { count: hours });
  if (hours < 168) {
    const days = Math.round(hours / 24);
    return t("admin.settings.durationDays", { count: days });
  }
  if (hours < 720) {
    const weeks = Math.round(hours / 168);
    return t("admin.settings.durationWeeks", { count: weeks });
  }
  const months = Math.round(hours / 720);
  return t("admin.settings.durationMonths", { count: months });
}

function SessionDurationPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useT();
  const presets: SessionPreset[] = [
    { label: t("admin.settings.preset30min"), hours: 0.5 },
    { label: t("admin.settings.preset1hour"), hours: 1 },
    { label: t("admin.settings.preset4hours"), hours: 4 },
    { label: t("admin.settings.preset8hours"), hours: 8, sublabel: t("admin.settings.preset8hoursSub") },
    { label: t("admin.settings.preset1day"), hours: 24 },
    { label: t("admin.settings.preset3days"), hours: 72 },
    { label: t("admin.settings.preset1week"), hours: 168, sublabel: t("admin.settings.preset1weekSub") },
    { label: t("admin.settings.preset2weeks"), hours: 336 },
    { label: t("admin.settings.preset1month"), hours: 720 },
    { label: t("admin.settings.preset3months"), hours: 2160 },
    { label: t("admin.settings.preset1year"), hours: 8760 },
  ];
  const [customMode, setCustomMode] = useState(false);
  const activePreset = presets.find((p) => p.hours === value);
  const customId = useId();

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="adm-field__label">{t("admin.settings.sessionDurationLabel")}</span>
        <div className="adm-seg" role="group" aria-label={t("admin.settings.sessionDurationMode")}>
          <button
            type="button"
            className="adm-seg__btn"
            aria-pressed={!customMode}
            onClick={() => setCustomMode(false)}
          >
            {t("admin.settings.sessionDurationPresets")}
          </button>
          <button
            type="button"
            className="adm-seg__btn"
            aria-pressed={customMode}
            onClick={() => setCustomMode(true)}
          >
            {t("admin.settings.sessionDurationCustom")}
          </button>
        </div>
      </div>
      <span className="adm-field__hint">
        {t("admin.settings.sessionDurationDesc")}
      </span>

      {!customMode ? (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <FilterChip
              key={preset.hours}
              active={preset.hours === value}
              onClick={() => onChange(preset.hours)}
              title={preset.sublabel ? `${preset.label} — ${preset.sublabel}` : preset.label}
            >
              {preset.label}
              {preset.sublabel && <span className="adm-sub ml-1">{preset.sublabel}</span>}
            </FilterChip>
          ))}
        </div>
      ) : (
        <div className="relative max-w-[13rem]">
          <label className="sr-only" htmlFor={customId}>
            {t("admin.settings.sessionDurationHours")}
          </label>
          <Input
            id={customId}
            type="number"
            value={value}
            min={0.5}
            max={8760}
            step={0.5}
            onChange={(e) => onChange(Math.max(0.5, Math.min(8760, Number(e.target.value) || 0.5)))}
            className="h-9 pr-14 text-sm"
          />
          <span className="adm-sub absolute right-3 top-1/2 -translate-y-1/2">{t("admin.settings.unitHours")}</span>
        </div>
      )}

      <p className="adm-field__hint inline-flex items-start gap-1.5">
        <Clock className="mt-px h-3.5 w-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
        <span>
          {t("admin.settings.sessionDurationReadout", { duration: formatSessionDuration(value, t) })}
          {!activePreset && value >= 1 && (
            <span className="adm-num"> ({value}h)</span>
          )}{" "}
        </span>
      </p>
    </div>
  );
}

/* ── Tags input ──────────────────────────────────────────────────────────────── */

function TagsInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  label: string;
}) {
  const t = useT();
  const [input, setInput] = useState("");
  const inputId = useId();

  function addTag() {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
      setInput("");
    }
  }

  return (
    <div className="grid gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span key={tag} className="adm-chip adm-chip--mono" data-tone="accent">
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((t) => t !== tag))}
                className="-mr-0.5 ml-0.5 opacity-60 transition-opacity hover:opacity-100"
                aria-label={t("admin.settings.tagRemove", { tag })}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex max-w-sm gap-1.5">
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        <Input
          id={inputId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder={placeholder ? t("admin.settings.tagAdd", { placeholder }) : t("admin.settings.tagAddGeneric")}
          className="h-9 text-sm"
        />
        <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={addTag} type="button">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("admin.settings.tagAddButton")}
        </Button>
      </div>
    </div>
  );
}
/* ── One setting ─────────────────────────────────────────────────────────────
   The `.adm-field` wrapper (and its unsaved-change dot) belongs to the caller, so
   this only renders the label, the hint and the control. */

function SettingsField({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const [showSensitive, setShowSensitive] = useState(false);
  const id = useId();

  if (field.type === "toggle") {
    return (
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="adm-field__label block">{field.label}</span>
          <span className="adm-field__hint">{field.description}</span>
        </span>
        <Switch
          checked={!!value}
          onChange={(checked) => onChange(checked)}
          label={field.label}
          id={id}
        />
      </div>
    );
  }

  const control = (() => {
    switch (field.type) {
      case "number":
        return (
          <div className="relative max-w-[12rem]">
            <Input
              id={id}
              type="number"
              value={Number(value) || 0}
              min={field.min}
              max={field.max}
              step={field.step}
              onChange={(e) => onChange(Number(e.target.value))}
              className={cn("h-9 text-sm", field.unit && "pr-16")}
            />
            {field.unit && (
              <span className="adm-sub absolute right-3 top-1/2 -translate-y-1/2">{field.unit}</span>
            )}
          </div>
        );
      case "select":
        return (
          <select
            id={id}
            className="adm-select w-full max-w-[12rem]"
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
          >
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      case "tags":
        return (
          <TagsInput
            label={field.label}
            value={(value as string[]) ?? []}
            onChange={(v) => onChange(v)}
            placeholder={typeof field.placeholder === "string" ? field.placeholder : undefined}
          />
        );
      default:
        return (
          <div className="relative max-w-sm">
            <Input
              id={id}
              type={field.sensitive && !showSensitive ? "password" : "text"}
              value={String(value ?? "")}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder}
              className={cn("h-9 text-sm", field.sensitive && "pr-10")}
            />
            {field.sensitive && (
              <button
                type="button"
                onClick={() => setShowSensitive((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--adm-muted)] transition-colors hover:text-foreground"
                aria-label={showSensitive ? t("settings.password.hideCurrent") : t("settings.password.showCurrent")}
              >
                {showSensitive ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        );
    }
  })();

  return (
    <>
      {field.type === "tags" ? (
        // The tag editor owns several controls, so the section title is a plain
        // label-less heading and each control carries its own accessible name.
        <span className="adm-field__label">{field.label}</span>
      ) : (
        <label className="adm-field__label" htmlFor={id}>
          {field.label}
        </label>
      )}
      <span className="adm-field__hint">{field.description}</span>
      {control}
    </>
  );
}
/* ── Cleanup status ──────────────────────────────────────────────────────────── */

/** Pure: the page ticks `now` so this never reads the clock during render. */
function formatAgo(iso: string, now: number, t: Translator): string {
  if (now === 0) return t("common.relative.now");
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return t("common.relative.now");
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("common.relative.now");
  if (mins < 60) return t("common.relative.minutes", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("common.relative.hours", { count: hours });
  return t("common.relative.days", { count: Math.floor(hours / 24) });
}

/**
 * Retention settings only mean something if a sweep is actually running, so the
 * admin sees when it last ran and which scheduler did it — the web app's own
 * interval, or the BullMQ worker when Redis is up.
 */
function CleanupStatus({ cleanup, now }: { cleanup?: CleanupState | null; now: number }) {
  const t = useT();
  if (!cleanup) return null;

  const { lastRunAt, lastSource, lastResult, lastError } = cleanup;

  if (!lastRunAt) {
    return (
      <Note icon={AlertCircle} tone="warning" className="mt-4">
        {t("admin.settings.cleanupNone")}
      </Note>
    );
  }

  return (
    <div className="mt-4 grid gap-2">
      <Note icon={CheckCircle2} tone={lastError ? "warning" : "success"}>
        {t("admin.settings.cleanupLast", {
          ago: formatAgo(lastRunAt, now, t),
          source: lastSource === "worker" ? t("admin.settings.cleanupSourceWorker") : t("admin.settings.cleanupSourceApp"),
        })}
        {lastResult && (
          <span className="adm-sub mt-0.5 block">
            {t("admin.settings.cleanupStats", { trash: lastResult.trashFiles, folders: lastResult.trashFolders, expired: lastResult.lifetimeSoftDeleted, logs: lastResult.logsDeleted })}
          </span>
        )}
      </Note>
      {lastError && (
        <Note icon={AlertCircle} tone="danger">
          {t("admin.settings.cleanupError", { error: lastError })}
        </Note>
      )}
    </div>
  );
}
/** "90" is a worse way to say "1h 30m", so the idle readout spells it out. */
function formatIdleMinutes(minutes: number, t: Translator): string {
  if (minutes < 60) return t("admin.settings.durationMinutes", { count: minutes });
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return t("admin.settings.durationHours", { count: hours });
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Security section banner — explains how the two session cut-offs interact,
 * because they can silently disagree and the shorter one is the one that ends the
 * session. Both are now fields on this page (they used to be SESSION_INACTIVITY_MS
 * in the environment, which is why the note used to talk about an env var).
 */
function SessionDurationNote({
  idleMinutes,
  sessionDurationHours,
}: {
  idleMinutes: number;
  sessionDurationHours: number;
}) {
  const t = useT();
  const durationMinutes = sessionDurationHours * 60;
  const idleActive = idleMinutes > 0;
  const idleWins = idleActive && idleMinutes < durationMinutes;

  if (!idleActive) {
    return (
      <Note icon={Info} tone="info">
        {t("admin.settings.sessionNoteNoIdle", { duration: formatSessionDuration(sessionDurationHours, t) })}
      </Note>
    );
  }

  const idleLabel = formatIdleMinutes(idleMinutes, t);

  return (
    <Note icon={idleWins ? AlertCircle : CheckCircle2} tone={idleWins ? "warning" : "success"}>
      {t(idleWins ? "admin.settings.sessionNoteIdleWins" : "admin.settings.sessionNoteIdleLoses", {
        idle: idleLabel,
        duration: formatSessionDuration(sessionDurationHours, t),
      })}
    </Note>
  );
}

/**
 * "Auto" is the default for IP binding, and on its own it does not tell the admin
 * what is actually happening on this box — so the resolved answer is spelled out
 * using `_meta.productionMode` from the server.
 */
function IpBindingNote({ mode, productionMode }: { mode: string; productionMode?: boolean }) {
  const t = useT();
  if (mode !== "auto" || productionMode === undefined) return null;
  return (
    <Note icon={Info} tone={productionMode ? "success" : "info"} className="mt-1">
      {t(productionMode ? "admin.settings.ipBindingNoteProd" : "admin.settings.ipBindingNoteDev")}
    </Note>
  );
}
/**
 * Share expiry has two knobs that are clamped independently, so "default 0" plus
 * "max 30" is a reachable combination that reads like "never expires" but is not.
 * This mirrors `shareExpiryPolicy()` on the server and states the outcome.
 */
function ShareExpiryNote({ defaultDays, maxDays }: { defaultDays: number; maxDays: number }) {
  const t = useT();
  const effective =
    maxDays > 0 && (defaultDays === 0 || defaultDays > maxDays) ? maxDays : defaultDays;
  const capped = effective !== defaultDays;
  const label = (d: number) => t("admin.settings.durationDays", { count: d });

  return (
    <Note icon={capped ? AlertCircle : Info} tone={capped ? "warning" : "info"} className="mt-1">
      {effective === 0 ? (
        t("admin.settings.shareNoteNeverExpires")
      ) : (
        <>{t("admin.settings.shareNoteWithMax", { effective: label(effective) })}
          {capped && t("admin.settings.shareNoteCapped")}.{" "}
          {maxDays > 0
            ? t("admin.settings.shareNoteMaxCeiling", { max: label(maxDays) })
            : t("admin.settings.shareNoteNoCeiling")}</>
      )}
    </Note>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────────── */

function SettingsSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-5 lg:grid-cols-[13rem_1fr]">
        <Skeleton className="h-11 w-full" rows={6} />
        <Skeleton className="h-40 w-full" rows={2} />
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  const t = useT();
  const sections = useMemo(() => localizedSections(t), [t]);
  const queryClient = useQueryClient();
  const [values, setValues] = useState<AdminSettings | null>(null);
  const [baseline, setBaseline] = useState<AdminSettings | null>(null);
  const [activeSection, setActiveSection] = useState("general");
  const [search, setSearch] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Half-minute tick, so "last cleanup 3m ago" ages without any render reading
  // the clock. It starts at 0 (meaning "unknown") so the server and the client
  // render the same first paint; the short timeout fills it in right after mount.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 60);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async () => {
      const res = await apiFetch<AdminSettings & { _meta?: SettingsMeta }>("/api/admin/settings");
      return res.data;
    },
  });

  // The form is a local draft of the saved values, so it is seeded during render
  // rather than in an effect: an effect would paint an empty form first and then
  // correct itself. `_meta` is server-side context (user count, cleanup status),
  // not a setting, so it never enters the draft.
  if (data && !values) {
    const settings = stripMeta(data);
    setValues(settings);
    setBaseline(settings);
  }
  const saveMutation = useMutation({
    mutationFn: async (settings: AdminSettings) => {
      const res = await apiFetch<AdminSettings>("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      if (!res.success) throw new Error(res.error ?? t("admin.settings.saveFailed"));
      return res.data;
    },
    onSuccess: (saved) => {
      setSuccessMsg(t("admin.settings.saveSuccess"));
      setTimeout(() => setSuccessMsg(""), 4000);
      if (saved) setBaseline(saved as AdminSettings);
      queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
    },
    onError: (err) => {
      setErrorMsg(err.message);
      setTimeout(() => setErrorMsg(""), 4000);
    },
  });

  function handleChange(key: keyof AdminSettings, value: unknown) {
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleReset() {
    if (baseline) setValues(baseline);
  }

  // Which fields differ from the last-saved baseline? Drives the dirty indicator
  // and the per-section "unsaved" dots.
  const dirtyKeys = useMemo(() => {
    if (!values || !baseline) return new Set<string>();
    const keys = new Set<string>();
    (Object.keys(values) as (keyof AdminSettings)[]).forEach((k) => {
      if (JSON.stringify(values[k]) !== JSON.stringify(baseline[k])) keys.add(k as string);
    });
    return keys;
  }, [values, baseline]);
  const isDirty = dirtyKeys.size > 0;

  // Search filters the visible fields; when searching we show all matching
  // sections flattened rather than the single active section.
  const query = search.trim().toLowerCase();
  const filteredSections = useMemo(() => {
    if (!query) return sections;
    return sections
      .map((s) => ({
        ...s,
        fields: s.fields.filter(
          (f) =>
            f.label.toLowerCase().includes(query) ||
            f.description.toLowerCase().includes(query) ||
            s.title.toLowerCase().includes(query)
        ),
      }))
      .filter((s) => s.fields.length > 0);
  }, [query, sections]);

  const visibleSections = query
    ? filteredSections
    : filteredSections.filter((s) => s.id === activeSection);

  if (isLoading && !values) return <SettingsSkeleton />;

  const meta = data?._meta as SettingsMeta | undefined;

  // Loaded, but nothing came back — surfaced as a state rather than a blank page
  // so it is obvious the fetch failed instead of the settings being empty.
  if (!values) {
    return (
      <div className="space-y-5">
        <AdminHeader icon={Sliders} kicker={t("admin.settings.kicker")} title={t("admin.settings.title")} />
        <AdminEmpty
          icon={AlertCircle}
          title={t("admin.settings.loadFailed")}
          body={t("admin.settings.loadFailedBody")}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-settings"] })}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {t("admin.settings.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-28">
      <AdminHeader
        icon={Sliders}
        kicker={t("admin.settings.kicker")}
        title={t("admin.settings.title")}
        lede={t("admin.settings.lede")}
        actions={
          <>
            {meta?.totalUsers !== undefined && (
              <Chip icon={Users} mono>
                {t("admin.settings.usersChip", { count: meta.totalUsers })}
              </Chip>
            )}
            {values?.maintenanceMode && (
              <Chip icon={AlertCircle} tone="warning">
                {t("admin.settings.maintenanceChip")}
              </Chip>
            )}
            {isDirty ? (
              <Chip icon={AlertCircle} tone="warning">
                {t("admin.settings.unsavedChip", { count: dirtyKeys.size })}
              </Chip>
            ) : (
              <Chip icon={CheckCircle2} tone="success">
                {t("admin.settings.allSavedChip")}
              </Chip>
            )}
          </>
        }
      />

      <div className="adm-toolbar">
        <SearchField
          icon={Search}
          value={search}
          onChange={setSearch}
          label={t("admin.settings.searchLabel")}
          placeholder={t("admin.settings.searchPlaceholder")}
        />
        {search && (
          <IconButton icon={X} label={t("admin.settings.clearSearch")} onClick={() => setSearch("")} />
        )}
      </div>

      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            <Note icon={CheckCircle2} tone="success">
              {successMsg}
            </Note>
          </motion.div>
        )}
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            <Note icon={AlertCircle} tone="danger">
              {errorMsg}
            </Note>
          </motion.div>
        )}
      </AnimatePresence>
      <div className={cn("grid gap-5", !query && "lg:grid-cols-[13rem_1fr]")}>
        {/* Section rail. Hidden while searching, because search results span
            sections and a highlighted "current section" would be a lie. */}
        {!query && (
          <nav aria-label={t("admin.settings.title")} className="lg:sticky lg:top-4 lg:self-start">
            <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
              {sections.map((section) => {
                const active = section.id === activeSection;
                const sectionDirty = section.fields.some((f) => dirtyKeys.has(f.key as string));
                return (
                  <li key={section.id} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      aria-pressed={active}
                      aria-label={
                        sectionDirty ? t("admin.settings.sectionUnsaved", { title: section.title }) : undefined
                      }
                      onClick={() => setActiveSection(section.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-[0.7rem] border px-2.5 py-2 text-left text-[0.78rem] font-medium transition-colors",
                        active
                          ? "border-[var(--adm-rim-strong)] bg-[var(--adm-row)] text-foreground"
                          : "border-transparent text-[var(--adm-muted)] hover:bg-[var(--adm-soft)] hover:text-foreground"
                      )}
                    >
                      <section.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{section.title}</span>
                      {sectionDirty && (
                        <span
                          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <div className="space-y-4">
          {visibleSections.length === 0 ? (
            <AdminEmpty
              icon={Search}
              title={t("admin.settings.noMatchTitle")}
              body={t("admin.settings.noMatchBody")}
            />
          ) : (
            visibleSections.map((section) => {
              const hasSessionField = section.fields.some(
                (f) => f.key === "sessionDurationHours"
              );
              return (
                <AdminPanel
                  key={section.id}
                  icon={section.icon}
                  title={section.title}
                  sub={section.description}
                >
                  {/* Session duration gets a picker instead of a bare hours box:
                      typing "168" is a worse way to say "one week". */}
                  {section.id === "security" && hasSessionField && (
                    <div
                      className="adm-field"
                      data-dirty={dirtyKeys.has("sessionDurationHours") || undefined}
                    >
                      <SessionDurationPicker
                        value={values.sessionDurationHours}
                        onChange={(v) => handleChange("sessionDurationHours", v)}
                      />
                      <SessionDurationNote
                        idleMinutes={values.sessionIdleTimeoutMinutes}
                        sessionDurationHours={values.sessionDurationHours}
                      />
                    </div>
                  )}

                  {section.fields.map((field) => {
                    if (field.key === "sessionDurationHours") return null;
                    return (
                      <div
                        key={field.key as string}
                        className="adm-field"
                        data-dirty={dirtyKeys.has(field.key as string) || undefined}
                      >
                        <SettingsField
                          field={field}
                          value={values[field.key]}
                          onChange={(v) => handleChange(field.key, v)}
                        />
                        {/* Notes that only make sense beside one specific field, so
                            they sit inside it rather than at panel level. */}
                        {field.key === "sessionIpBinding" && (
                          <IpBindingNote
                            mode={values.sessionIpBinding}
                            productionMode={meta?.productionMode}
                          />
                        )}
                        {field.key === "shareMaxExpiryDays" && (
                          <ShareExpiryNote
                            defaultDays={values.shareDefaultExpiryDays}
                            maxDays={values.shareMaxExpiryDays}
                          />
                        )}
                      </div>
                    );
                  })}

                  {section.footer === "cleanup" && (
                    <CleanupStatus cleanup={meta?.cleanup} now={now} />
                  )}
                </AdminPanel>
              );
            })
          )}
        </div>
      </div>

      {/* The save bar only exists while something is unsaved, so the page never
          shows a Save button that would do nothing. */}
      <AnimatePresence>
        {isDirty && (
          <motion.div
            className="adm-savebar"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            role="region"
            aria-label={t("admin.settings.unsavedCount", { count: dirtyKeys.size })}
          >
            <AlertCircle className="h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="min-w-0 text-[0.78rem]">
              <span className="adm-num font-semibold">{t("admin.settings.unsavedCount", { count: dirtyKeys.size })}</span>
              <span className="adm-sub ml-1.5 hidden sm:inline">{t("admin.settings.unsavedHint")}</span>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={saveMutation.isPending}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t("admin.settings.discard")}
              </Button>
              <Button
                size="sm"
                onClick={() => saveMutation.mutate(values)}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {t("admin.settings.saveChanges")}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
