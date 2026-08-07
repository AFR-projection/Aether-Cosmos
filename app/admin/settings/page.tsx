"use client";

import { useState, useEffect, useMemo } from "react";
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
} from "lucide-react";
import type { AdminSettings } from "@/app/api/admin/settings/route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";

// ─── Section Definition ──────────────────────────────────────────────────────

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
  icon: typeof Shield;
  gradient: string;
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
  sessionInactivityMs?: number | null;
}

const SETTING_SECTIONS: Section[] = [
  {
    id: "general",
    title: "General",
    description: "Core platform settings and maintenance controls",
    icon: Settings2,
    gradient: "from-slate-500 to-zinc-500",
    fields: [
      { key: "registrationEnabled", label: "Allow Registration", description: "Show public Sign up page and allow self-service accounts", type: "toggle" },
      { key: "maintenanceMode", label: "Maintenance Mode", description: "Block all user access except admins", type: "toggle" },
      { key: "maintenanceMessage", label: "Maintenance Message", description: "Message shown to users during maintenance", type: "text", placeholder: "System is under maintenance..." },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    description: "Quota limits and file size restrictions",
    icon: HardDrive,
    gradient: "from-emerald-500 to-teal-500",
    fields: [
      { key: "defaultQuotaGB", label: "Default Quota", description: "Storage quota for new users", type: "number", unit: "GB", min: 1, max: 10000 },
      { key: "maxUploadSizeMB", label: "Max Upload Size", description: "Maximum file size per upload", type: "number", unit: "MB", min: 1, max: 5120 },
      { key: "storageWarningThreshold", label: "Warning Threshold", description: "Notify users when storage exceeds this percentage", type: "number", unit: "%", min: 50, max: 100 },
    ],
  },
  {
    id: "security",
    title: "Security",
    description: "Session, access and rate limiting controls",
    icon: Shield,
    gradient: "from-violet-500 to-fuchsia-500",
    fields: [
      { key: "sessionDurationHours", label: "Session Duration", description: "How long a session stays valid before the user must sign in again", type: "number", unit: "hours", min: 1, max: 8760 },
      { key: "maxSessionsPerUser", label: "Max Sessions", description: "Concurrent sessions per user — the oldest is signed out when exceeded", type: "number", unit: "sessions", min: 1, max: 100 },
      { key: "rateLimitPerMinute", label: "Rate Limit", description: "API requests per minute per user. Upload endpoints get 5× this value.", type: "number", unit: "req/min", min: 10, max: 1000 },
      { key: "stepCodeRequired", label: "Require 2-Step Code", description: "Every user must set a numpad code entered after their password. Users without one are prompted to create it at next sign-in and cannot remove it.", type: "toggle" },
    ],
  },
  {
    id: "files",
    title: "Files",
    description: "File policies, expiration and cleanup rules",
    icon: FileWarning,
    gradient: "from-amber-500 to-orange-500",
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
    gradient: "from-blue-500 to-cyan-500",
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
    gradient: "from-rose-500 to-pink-500",
    fields: [
      { key: "emailDailyLimitPerSender", label: "Daily Limit per Sender", description: "Default max emails a Gmail sender may send per day before the router rotates to another. Gmail's own cap is ~500/day.", type: "number", unit: "emails/day", min: 1, max: 2000 },
      { key: "emailFailureThreshold", label: "Failure Threshold", description: "Consecutive send failures before a sender is rested (put on cooldown)", type: "number", unit: "failures", min: 1, max: 20 },
      { key: "emailCooldownMinutes", label: "Cooldown Duration", description: "How long a sender rests after hitting the failure threshold, then it's retried automatically", type: "number", unit: "minutes", min: 1, max: 1440 },
    ],
  },
];

// ─── Tags Input ───────────────────────────────────────────────────────────────

function TagsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [input, setInput] = useState("");

  function addTag() {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
      setInput("");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-lg bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
            {tag}
            <button onClick={() => onChange(value.filter((t) => t !== tag))} className="hover:text-accent/60" aria-label={`Remove ${tag}`}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          placeholder={placeholder ? `Add ${placeholder}...` : "Add value..."}
          className="h-8 text-xs"
        />
        <Button variant="secondary" size="sm" className="h-8 shrink-0" onClick={addTag} type="button">Add</Button>
      </div>
    </div>
  );
}

// ─── Settings Field ───────────────────────────────────────────────────────────

function SettingsField({ field, value, onChange }: {
  field: SettingField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [showSensitive, setShowSensitive] = useState(false);

  switch (field.type) {
    case "toggle":
      return (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{field.label}</p>
            <p className="text-xs text-muted-foreground/60">{field.description}</p>
          </div>
          <ToggleSwitch value={!!value} onChange={(v) => onChange(v)} />
        </div>
      );

    case "number":
      return (
        <div>
          <label className="mb-1.5 block text-sm font-medium">{field.label}</label>
          <p className="text-xs text-muted-foreground/60 mb-2">{field.description}</p>
          <div className="relative max-w-[200px]">
            <Input
              type="number"
              value={Number(value) || 0}
              min={field.min}
              max={field.max}
              step={field.step}
              onChange={(e) => onChange(Number(e.target.value))}
              className="h-9 pr-10 text-sm"
            />
            {field.unit && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground/50 font-medium">{field.unit}</span>
            )}
          </div>
        </div>
      );

    case "select":
      return (
        <div>
          <label className="mb-1.5 block text-sm font-medium">{field.label}</label>
          <p className="text-xs text-muted-foreground/60 mb-2">{field.description}</p>
          <select
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="flex h-9 w-full max-w-[200px] rounded-xl border border-border/50 bg-surface px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      );

    case "tags":
      return (
        <div>
          <label className="mb-1.5 block text-sm font-medium">{field.label}</label>
          <p className="text-xs text-muted-foreground/60 mb-2">{field.description}</p>
          <TagsInput
            value={(value as string[]) ?? []}
            onChange={(v) => onChange(v)}
            placeholder={typeof field.placeholder === "string" ? field.placeholder : undefined}
          />
        </div>
      );

    default:
      return (
        <div>
          <label className="mb-1.5 block text-sm font-medium">{field.label}</label>
          <p className="text-xs text-muted-foreground/60 mb-2">{field.description}</p>
          <div className="relative max-w-sm">
            <Input
              type={field.sensitive && !showSensitive ? "password" : "text"}
              value={String(value ?? "")}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder}
              className="h-9 text-sm pr-9"
            />
            {field.sensitive && (
              <button
                type="button"
                onClick={() => setShowSensitive(!showSensitive)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
                aria-label={showSensitive ? "Hide" : "Show"}
              >
                {showSensitive ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>
      );
  }
}

// ─── Cleanup status ───────────────────────────────────────────────────────────

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Retention settings only mean something if a sweep is actually running, so the
 * admin sees when it last ran and which scheduler did it — the web app's own
 * interval, or the BullMQ worker when Redis is up.
 */
function CleanupStatus({ cleanup }: { cleanup?: CleanupState | null }) {
  if (!cleanup) return null;

  const { lastRunAt, lastSource, lastResult, lastError } = cleanup;

  return (
    <div className="border-t border-border/30 px-6 py-4 text-xs">
      {lastRunAt ? (
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span className="text-foreground/80">
              Last cleanup {formatAgo(lastRunAt)}
            </span>
            <span className="text-muted-foreground/60">
              via {lastSource === "worker" ? "background worker" : "app scheduler"}
            </span>
          </p>
          {lastResult && (
            <p className="pl-5 text-muted-foreground/70">
              {lastResult.trashFiles} trash files · {lastResult.trashFolders} folders ·{" "}
              {lastResult.lifetimeSoftDeleted} expired · {lastResult.logsDeleted} logs
            </p>
          )}
          {lastError && (
            <p className="pl-5 text-red-500">Last run failed: {lastError}</p>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          No cleanup has run yet — the first sweep happens within ~20 minutes of server start.
        </p>
      )}
    </div>
  );
}

/**
 * The idle cut-off is set via SESSION_INACTIVITY_MS and, when shorter than the
 * configured session duration, is what actually logs users out. Surfacing it
 * here stops "Session Duration" from looking like it does nothing.
 */
function SessionDurationNote({
  inactivityMs,
  sessionDurationHours,
}: {
  inactivityMs?: number | null;
  sessionDurationHours: number;
}) {
  if (!inactivityMs) return null;
  const durationMs = sessionDurationHours * 3600_000;
  if (inactivityMs >= durationMs) return null;

  const minutes = Math.round(inactivityMs / 60000);
  return (
    <p className="flex items-start gap-1.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>
        An idle timeout of {minutes} minutes is set via <code>SESSION_INACTIVITY_MS</code>,
        so inactive users are signed out well before the {sessionDurationHours}h session
        duration. Remove that variable to let this setting take full effect.
      </span>
    </p>
  );
}

// ─── Settings Section ─────────────────────────────────────────────────────────

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        value ? "bg-accent" : "bg-muted-foreground/20"
      )}
    >
      <span className={cn(
        "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200",
        value ? "translate-x-5" : "translate-x-0"
      )} />
    </button>
  );
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-10 w-48 skeleton rounded-lg" />
      <div className="h-8 w-72 skeleton rounded-lg" />
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 skeleton rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const sections = SETTING_SECTIONS;

export default function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<AdminSettings | null>(null);
  const [baseline, setBaseline] = useState<AdminSettings | null>(null);
  const [activeSection, setActiveSection] = useState("general");
  const [search, setSearch] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: async () => {
      const res = await apiFetch<AdminSettings & { _meta?: SettingsMeta }>("/api/admin/settings");
      return res.data;
    },
  });

  useEffect(() => {
    if (data && !values) {
      const { _meta: _, ...settings } = data as AdminSettings & { _meta?: unknown };
      setValues(settings as AdminSettings);
      setBaseline(settings as AdminSettings);
    }
  }, [data, values]);

  const saveMutation = useMutation({
    mutationFn: async (settings: AdminSettings) => {
      const res = await apiFetch<AdminSettings>("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      if (!res.success) throw new Error(res.error ?? "Failed to save settings");
      return res.data;
    },
    onSuccess: (saved) => {
      setSuccessMsg("Settings saved — changes take effect within ~30 seconds");
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
  }, [query]);

  const visibleSections = query
    ? filteredSections
    : filteredSections.filter((s) => s.id === activeSection);

  if (isLoading && !values) return <SettingsSkeleton />;

  const meta = data?._meta as SettingsMeta | undefined;

  return (
    <div className="pb-28">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/60 shadow-lg shadow-accent/20">
            <Sliders className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground/60">
              Platform configuration · saved to database, applied within ~30 seconds
            </p>
          </div>
        </div>
      </motion.div>

      {/* System info bar */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/40 bg-surface/60 px-5 py-3 text-xs text-muted-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          <span className="font-medium text-foreground/80">System online</span>
        </span>
        {meta?.totalUsers !== undefined && (
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> {meta.totalUsers} users
          </span>
        )}
        {values?.maintenanceMode && (
          <span className="inline-flex items-center gap-1.5 text-amber-500">
            <AlertCircle className="h-3.5 w-3.5" /> Maintenance mode active
          </span>
        )}
        <span className="inline-flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto">
          {isDirty ? (
            <span className="inline-flex items-center gap-1.5 text-amber-500">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
              {dirtyKeys.size} unsaved change{dirtyKeys.size > 1 ? "s" : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> All changes saved
            </span>
          )}
        </span>
      </motion.div>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search settings…"
          className="h-10 pl-9"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {values && (
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          {/* Section nav — horizontal scroll chips on mobile, sticky sidebar on desktop.
              Hidden while searching (results are flattened across sections). */}
          {!query && (
            <nav>
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 no-scrollbar lg:sticky lg:top-4 lg:mx-0 lg:flex-col lg:gap-0 lg:space-y-1 lg:overflow-visible lg:px-0 lg:pb-0">
                {sections.map((section) => {
                  const Icon = section.icon;
                  const active = section.id === activeSection;
                  const sectionDirty = section.fields.some((f) => dirtyKeys.has(f.key as string));
                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      className={cn(
                        "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl border px-3 py-2.5 text-left text-sm transition-colors lg:w-full lg:border-transparent",
                        active
                          ? "border-accent/30 bg-accent/10 font-medium text-accent lg:border-transparent"
                          : "border-border/40 text-muted-foreground hover:bg-accent/5 hover:text-foreground"
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br",
                          section.gradient
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="flex-1 truncate">{section.title}</span>
                      {sectionDirty && <span className="size-1.5 rounded-full bg-amber-500" />}
                    </button>
                  );
                })}
              </div>
            </nav>
          )}

          {/* Content */}
          <div className="space-y-6">
            <AnimatePresence>
              {successMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400"
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0" /> {successMsg}
                </motion.div>
              )}
              {errorMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-500"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" /> {errorMsg}
                </motion.div>
              )}
            </AnimatePresence>

            {visibleSections.length === 0 && (
              <div className="rounded-2xl border border-border/40 bg-surface/50 py-16 text-center text-sm text-muted-foreground">
                No settings match “{search}”.
              </div>
            )}

            {visibleSections.map((section) => {
              const Icon = section.icon;
              return (
                <motion.div
                  key={section.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="overflow-hidden rounded-2xl border border-border/50 bg-surface/80 backdrop-blur-sm"
                >
                  <div className="flex items-center gap-3 border-b border-border/30 px-6 py-4">
                    <div
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br",
                        section.gradient
                      )}
                    >
                      <Icon className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold">{section.title}</h3>
                      <p className="text-xs text-muted-foreground/60">{section.description}</p>
                    </div>
                  </div>
                  <div className="space-y-5 px-6 py-5">
                    {section.id === "security" && (
                      <SessionDurationNote
                        inactivityMs={meta?.sessionInactivityMs}
                        sessionDurationHours={values.sessionDurationHours}
                      />
                    )}
                    {section.fields.map((field) => (
                      <div
                        key={field.key as string}
                        className={cn(
                          "rounded-xl transition-colors",
                          dirtyKeys.has(field.key as string) && "-mx-2 bg-amber-500/[0.04] px-2 py-2"
                        )}
                      >
                        <SettingsField
                          field={field}
                          value={values[field.key]}
                          onChange={(v) => handleChange(field.key, v)}
                        />
                      </div>
                    ))}
                  </div>
                  {section.footer === "cleanup" && <CleanupStatus cleanup={meta?.cleanup} />}
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      {/* Sticky action bar */}
      <AnimatePresence>
        {isDirty && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-[calc(100%-2rem)] max-w-lg items-center justify-between gap-4 rounded-2xl border border-border/60 bg-surface/95 px-5 py-3 shadow-2xl backdrop-blur-xl"
          >
            <span className="text-sm text-muted-foreground">
              {dirtyKeys.size} unsaved change{dirtyKeys.size > 1 ? "s" : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={saveMutation.isPending}
                className="gap-1.5"
              >
                <RotateCcw className="h-4 w-4" /> Discard
              </Button>
              <Button
                size="sm"
                onClick={() => values && saveMutation.mutate(values)}
                disabled={saveMutation.isPending}
                className="gap-1.5"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save changes
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}