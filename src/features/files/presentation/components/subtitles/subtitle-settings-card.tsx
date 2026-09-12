"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Captions,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PauseCircle,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Badge } from "@/ui/primitives/badge";
import { apiFetch } from "@/shared/api/client";
import { useT } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";

type Capability = "asr" | "translation";
type Role = "primary" | "fallback";
type ProfileKey = `${Capability}:${Role}`;
type Health = "unknown" | "healthy" | "degraded" | "unhealthy";

type PublicProfile = {
  id: string;
  capability: Capability;
  role: Role;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
  concurrencyLimit: number;
  rateLimit: number;
  burstLimit: number;
  health: Health;
  lastHealthAt: string | null;
  lastErrorCode: string | null;
  hasApiKey: boolean;
};

type OperationalStatus = {
  available: boolean;
  activeRuns: number;
  pendingWorkItems: number;
  leasedWorkItems: number;
  failedRuns: number;
  backfill: {
    status: "idle" | "running" | "blocked" | "failed";
    scannedCount: number;
    processedCount: number;
    failedCount: number;
    heartbeatAt: string | null;
    lastCompletedAt: string | null;
    lastErrorCode: string | null;
  } | null;
};

type PublicConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  translateBaseUrl: string;
  translateModel: string;
  hasTranslateApiKey: boolean;
  enabled: boolean;
  advanced?: {
    available: boolean;
    profiles: PublicProfile[];
    operational: OperationalStatus;
  };
};

type TestResult = {
  ok: boolean;
  model: string;
  message?: string;
  status?: number;
  latencyMs?: number;
};

type ProfileDraft = Partial<Pick<PublicProfile,
  "name" | "provider" | "baseUrl" | "model" | "enabled" | "timeoutMs" |
  "concurrencyLimit" | "rateLimit" | "burstLimit"
>>;

type SecretDraft = { value: string; clear: boolean };

const PROFILE_KEYS: ProfileKey[] = [
  "asr:primary",
  "asr:fallback",
  "translation:primary",
  "translation:fallback",
];

function keyOf(profile: Pick<PublicProfile, "capability" | "role">): ProfileKey {
  return `${profile.capability}:${profile.role}`;
}

function KeyField({
  id,
  stored,
  value,
  onChange,
  onClear,
}: {
  id: string;
  stored: boolean;
  value: string;
  onChange: (next: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
        {t("admin.subtitles.transcription.apiKey")}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("admin.subtitles.keyPlaceholder")}
          className="pr-11 font-mono"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={visible ? t("admin.subtitles.hideKey") : t("admin.subtitles.showKey")}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        {stored && <KeyRound className="h-3.5 w-3.5 shrink-0 text-success-ink" aria-hidden="true" />}
        <span>{stored ? t("admin.subtitles.keyStored") : t("admin.subtitles.keyRotate")}</span>
        {stored && (
          <button type="button" className="text-danger-ink underline underline-offset-2" onClick={onClear}>
            {t("admin.subtitles.keyClear")}
          </button>
        )}
      </p>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export function SubtitleSettingsCard() {
  const t = useT();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<ProfileKey, ProfileDraft>>>({});
  const [secrets, setSecrets] = useState<Partial<Record<ProfileKey, SecretDraft>>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<ProfileKey | null>(null);
  const [results, setResults] = useState<Partial<Record<ProfileKey, TestResult>>>({});

  const load = useCallback(async () => {
    const result = await apiFetch<PublicConfig>("/api/admin/subtitle-settings");
    if (result.success && result.data) {
      setConfig(result.data);
      setEnabled(result.data.enabled);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const profiles = useMemo(() => {
    const available = config?.advanced?.profiles ?? [];
    return new Map(available.map((profile) => [keyOf(profile), profile]));
  }, [config]);

  function profileValue<K extends keyof ProfileDraft>(key: ProfileKey, field: K): ProfileDraft[K] {
    return drafts[key]?.[field] ?? profiles.get(key)?.[field];
  }

  function setProfile<K extends keyof ProfileDraft>(key: ProfileKey, field: K, value: ProfileDraft[K]) {
    setDrafts((current) => ({ ...current, [key]: { ...current[key], [field]: value } }));
  }

  const dirty = enabled !== config?.enabled || Object.keys(drafts).length > 0 || Object.keys(secrets).length > 0;

  async function save() {
    if (!config) return;
    setSaving(true);
    const updates = PROFILE_KEYS.filter((key) => profiles.has(key)).map((key) => {
      const [capability, role] = key.split(":") as [Capability, Role];
      const secret = secrets[key];
      return {
        capability,
        role,
        ...drafts[key],
        ...(secret?.value.trim() ? { apiKey: secret.value.trim() } : secret?.clear ? { apiKey: null } : {}),
      };
    });
    const result = await apiFetch<PublicConfig>("/api/admin/subtitle-settings", {
      method: "PUT",
      body: JSON.stringify({ enabled, profiles: updates }),
    });
    setSaving(false);
    if (!result.success || !result.data) {
      notify({ title: t("admin.subtitles.saveFailed", { reason: result.error ?? "" }), tone: "error" });
      return;
    }
    setConfig(result.data);
    setDrafts({});
    setSecrets({});
    setResults({});
    notify({ title: t("admin.subtitles.saved"), tone: "success" });
  }

  async function testProfile(profile: PublicProfile) {
    const key = keyOf(profile);
    setTesting(key);
    const result = await apiFetch<TestResult>("/api/admin/subtitle-settings/test", {
      method: "POST",
      body: JSON.stringify({
        target: profile.capability === "asr" ? "transcribe" : "translate",
        role: profile.role,
      }),
    });
    setTesting(null);
    setResults((current) => ({
      ...current,
      [key]: result.success && result.data
        ? result.data
        : { ok: false, model: profile.model, message: result.error ?? t("admin.subtitles.testNoKey") },
    }));
    void load();
  }

  if (!config) {
    return <div className="adm-panel"><div className="adm-panel__body flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" /></div></div>;
  }

  const advanced = config.advanced;
  return (
    <div className="space-y-4">
      <div className="adm-panel">
        <div className="adm-panel__head">
          <span className="adm-panel__badge"><Captions aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 className="adm-panel__title">{t("admin.subtitles.title")}</h2>
            <p className="adm-panel__sub">{t("admin.subtitles.lede")}</p>
          </div>
          <div className="adm-panel__tools">
            <Badge tone={enabled ? "success" : "danger"}>
              {enabled ? t("admin.subtitles.operational.accepting") : t("admin.subtitles.operational.paused")}
            </Badge>
          </div>
        </div>
        <div className="adm-panel__body space-y-4">
          <label className="flex items-start gap-3 rounded-lg border border-border/60 p-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <PauseCircle className="h-4 w-4 shrink-0 text-warning-ink" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium text-foreground">{t("admin.subtitles.emergencyPause")}</span>
              <span className="block text-xs text-muted-foreground">{t("admin.subtitles.emergencyPauseHint")}</span>
            </span>
          </label>
          <p className="flex gap-2 rounded-lg bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-ink ring-1 ring-warning/20"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t("admin.subtitles.privacyWarning")}</p>
          <p className="flex gap-2 rounded-lg bg-muted p-2.5 text-xs leading-relaxed text-muted-foreground"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{t("admin.subtitles.secretWarning")}</p>
        </div>
      </div>

      {advanced?.available ? PROFILE_KEYS.map((key) => {
        const profile = profiles.get(key);
        if (!profile) return null;
        const result = results[key];
        const health = profile.health;
        const healthTone = health === "healthy" ? "success" : health === "degraded" ? "warning" : health === "unhealthy" ? "danger" : "neutral";
        return (
          <div key={key} className="adm-panel">
            <div className="adm-panel__head">
              <div className="min-w-0">
                <h3 className="adm-panel__title">{t(`admin.subtitles.profiles.${profile.capability}.${profile.role}`)}</h3>
                <p className="adm-panel__sub">{profile.name}</p>
              </div>
              <div className="adm-panel__tools">
                <Badge tone={healthTone}>{t(`admin.subtitles.health.${health}`)}</Badge>
                <Button variant="secondary" size="sm" onClick={() => void testProfile(profile)} disabled={testing !== null || !profile.hasApiKey}>
                  {testing === key && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {testing === key ? t("admin.subtitles.testing") : t("admin.subtitles.test")}
                </Button>
              </div>
            </div>
            <div className="adm-panel__body space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <input type="checkbox" checked={Boolean(profileValue(key, "enabled"))} onChange={(event) => setProfile(key, "enabled", event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
                {t("admin.subtitles.profileEnabled")}
              </label>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div><label htmlFor={`${key}-name`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.subtitles.profileName")}</label><Input id={`${key}-name`} value={String(profileValue(key, "name") ?? "")} onChange={(event) => setProfile(key, "name", event.target.value)} /></div>
                <div><label htmlFor={`${key}-provider`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.subtitles.provider")}</label><Input id={`${key}-provider`} value={String(profileValue(key, "provider") ?? "")} onChange={(event) => setProfile(key, "provider", event.target.value)} /></div>
                <div><label htmlFor={`${key}-model`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.subtitles.transcription.model")}</label><Input id={`${key}-model`} value={String(profileValue(key, "model") ?? "")} onChange={(event) => setProfile(key, "model", event.target.value)} className="font-mono" /></div>
              </div>
              <div><label htmlFor={`${key}-url`} className="mb-1 block text-xs font-medium text-muted-foreground">{t("admin.subtitles.transcription.baseUrl")}</label><Input id={`${key}-url`} value={String(profileValue(key, "baseUrl") ?? "")} onChange={(event) => setProfile(key, "baseUrl", event.target.value)} spellCheck={false} className="font-mono" /></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <NumberField id={`${key}-timeout`} label={t("admin.subtitles.controls.timeout")} min={1000} max={600000} value={Number(profileValue(key, "timeoutMs") ?? 120000)} onChange={(value) => setProfile(key, "timeoutMs", value)} />
                <NumberField id={`${key}-concurrency`} label={t("admin.subtitles.controls.concurrency")} min={1} max={100} value={Number(profileValue(key, "concurrencyLimit") ?? 1)} onChange={(value) => setProfile(key, "concurrencyLimit", value)} />
                <NumberField id={`${key}-rate`} label={t("admin.subtitles.controls.rate")} min={0} max={100000} value={Number(profileValue(key, "rateLimit") ?? 0)} onChange={(value) => setProfile(key, "rateLimit", value)} />
                <NumberField id={`${key}-burst`} label={t("admin.subtitles.controls.burst")} min={0} max={100000} value={Number(profileValue(key, "burstLimit") ?? 0)} onChange={(value) => setProfile(key, "burstLimit", value)} />
              </div>
              <KeyField
                id={`${key}-key`}
                stored={profile.hasApiKey}
                value={secrets[key]?.value ?? ""}
                onChange={(value) => setSecrets((current) => ({ ...current, [key]: { value, clear: false } }))}
                onClear={() => setSecrets((current) => ({ ...current, [key]: { value: "", clear: true } }))}
              />
              {profile.lastHealthAt && <p className="text-xs text-muted-foreground">{t("admin.subtitles.lastChecked", { date: new Date(profile.lastHealthAt).toLocaleString() })}</p>}
              {result && <p role="status" className={result.ok ? "rounded-lg bg-success/10 p-2.5 text-xs text-success-ink ring-1 ring-success/20" : "rounded-lg bg-danger/10 p-2.5 text-xs text-danger-ink ring-1 ring-danger/20"}>{result.ok ? t("admin.subtitles.testOk", { model: result.model, latency: String(result.latencyMs ?? 0) }) : t("admin.subtitles.testFailed", { reason: result.message ?? String(result.status ?? "") })}</p>}
            </div>
          </div>
        );
      }) : (
        <div className="adm-panel"><div className="adm-panel__body text-sm text-muted-foreground">{t("admin.subtitles.advancedUnavailable")}</div></div>
      )}

      {advanced?.operational && (
        <div className="adm-panel">
          <div className="adm-panel__head"><span className="adm-panel__badge"><Activity aria-hidden="true" /></span><div className="min-w-0"><h3 className="adm-panel__title">{t("admin.subtitles.operational.heading")}</h3><p className="adm-panel__sub">{t("admin.subtitles.operational.lede")}</p></div></div>
          <div className="adm-panel__body">
            {advanced.operational.available ? (
              <div className="space-y-3">
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {([["activeRuns", advanced.operational.activeRuns], ["pendingWork", advanced.operational.pendingWorkItems], ["leasedWork", advanced.operational.leasedWorkItems], ["failedRuns", advanced.operational.failedRuns]] as const).map(([label, count]) => <div key={label} className="rounded-lg bg-muted p-3"><dt className="text-xs text-muted-foreground">{t(`admin.subtitles.operational.${label}`)}</dt><dd className="mt-1 text-xl font-semibold text-foreground">{count}</dd></div>)}
                </dl>
                <p className="text-xs text-muted-foreground">
                  {advanced.operational.backfill
                    ? t("admin.subtitles.operational.backfill", { status: advanced.operational.backfill.status, processed: String(advanced.operational.backfill.processedCount), scanned: String(advanced.operational.backfill.scannedCount), failed: String(advanced.operational.backfill.failedCount) })
                    : t("admin.subtitles.operational.backfillNotStarted")}
                </p>
              </div>
            ) : <p className="text-sm text-muted-foreground">{t("admin.subtitles.operational.unavailable")}</p>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2"><Button onClick={() => void save()} disabled={saving || !dirty || !advanced?.available}>{saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{saving ? t("admin.subtitles.saving") : t("admin.subtitles.save")}</Button></div>
    </div>
  );
}
