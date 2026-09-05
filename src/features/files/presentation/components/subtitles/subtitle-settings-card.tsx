"use client";

import { useCallback, useEffect, useState } from "react";
import { Captions, Eye, EyeOff, KeyRound, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { apiFetch } from "@/shared/api/client";
import { useT } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";

/**
 * The subtitle provider configuration, for the master console.
 *
 * Two provider blocks, because transcription and translation are bought separately — the cheapest
 * speech recogniser and the best translator are rarely the same company. Each is a base URL, a model
 * and a key, which is the whole contract "OpenAI-compatible" gives us.
 *
 * The key fields never show a stored value, only whether one exists. An input that displayed a
 * decrypted secret would put it in the DOM, in a screenshot, and in whatever the browser autofills
 * next — so the control is write-only: type to replace, a button to clear, blank to keep.
 *
 * The two warnings are not decoration. One says where the audio goes, which is the operator's to
 * know before they turn this on for their users. The other says what happens if `SESSION_SECRET`
 * changes, because the symptom — every track suddenly failing with "not configured" — looks nothing
 * like the cause.
 */

type PublicConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  translateBaseUrl: string;
  translateModel: string;
  hasTranslateApiKey: boolean;
  enabled: boolean;
};

type TestResult = { ok: boolean; model: string; message?: string; status?: number };

/** A key field: never shows what is stored, only offers to replace or clear it. */
function KeyField({
  id,
  label,
  stored,
  value,
  onChange,
  onClear,
}: {
  id: string;
  label: string;
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
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="off"
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
        {stored ? (
          <>
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-success-ink" aria-hidden="true" />
            <span>
              {t("admin.subtitles.keyStored")} {t("admin.subtitles.keyRotate")}
            </span>
            <button
              type="button"
              className="shrink-0 text-danger-ink underline underline-offset-2"
              onClick={onClear}
            >
              {t("admin.subtitles.keyClear")}
            </button>
          </>
        ) : (
          <span>{t("admin.subtitles.keyRotate")}</span>
        )}
      </p>
    </div>
  );
}

export function SubtitleSettingsCard() {
  const t = useT();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [draft, setDraft] = useState<Partial<PublicConfig>>({});
  /** Typed keys, kept apart from the draft so an empty string never means "clear". */
  const [keys, setKeys] = useState<{ apiKey: string; translateApiKey: string }>({
    apiKey: "",
    translateApiKey: "",
  });
  /** Keys the operator explicitly asked to remove. */
  const [cleared, setCleared] = useState<{ apiKey: boolean; translateApiKey: boolean }>({
    apiKey: false,
    translateApiKey: false,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"transcribe" | "translate" | null>(null);
  const [results, setResults] = useState<Partial<Record<"transcribe" | "translate", TestResult>>>({});

  const load = useCallback(async () => {
    const result = await apiFetch<PublicConfig>("/api/admin/subtitle-settings");
    if (result.success && result.data) setConfig(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = <K extends keyof PublicConfig>(field: K): PublicConfig[K] | undefined =>
    (draft[field] ?? config?.[field]) as PublicConfig[K] | undefined;

  const set = <K extends keyof PublicConfig>(field: K, next: PublicConfig[K]) =>
    setDraft((current) => ({ ...current, [field]: next }));

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = { ...draft };
    // A blank field means "leave the stored key alone"; `null` is the explicit clear. Conflating
    // the two would wipe a working key every time somebody toggled the switch.
    if (keys.apiKey.trim().length > 0) body.apiKey = keys.apiKey.trim();
    else if (cleared.apiKey) body.apiKey = null;
    if (keys.translateApiKey.trim().length > 0) body.translateApiKey = keys.translateApiKey.trim();
    else if (cleared.translateApiKey) body.translateApiKey = null;

    const result = await apiFetch<PublicConfig>("/api/admin/subtitle-settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!result.success || !result.data) {
      notify({
        title: t("admin.subtitles.saveFailed", { reason: result.error ?? "" }),
        tone: "error",
      });
      return;
    }
    setConfig(result.data);
    setDraft({});
    setKeys({ apiKey: "", translateApiKey: "" });
    setCleared({ apiKey: false, translateApiKey: false });
    setResults({});
    notify({ title: t("admin.subtitles.saved"), tone: "success" });
  }

  async function test(target: "transcribe" | "translate") {
    setTesting(target);
    const result = await apiFetch<TestResult>("/api/admin/subtitle-settings/test", {
      method: "POST",
      body: JSON.stringify({ target }),
    });
    setTesting(null);
    if (!result.success || !result.data) {
      setResults((current) => ({
        ...current,
        [target]: { ok: false, model: "", message: result.error ?? t("admin.subtitles.testNoKey") },
      }));
      return;
    }
    setResults((current) => ({ ...current, [target]: result.data as TestResult }));
  }

  if (!config) {
    return (
      <div className="adm-panel">
        <div className="adm-panel__body flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const dirty = Object.keys(draft).length > 0 || keys.apiKey !== "" || keys.translateApiKey !== "" || cleared.apiKey || cleared.translateApiKey;

  return (
    <div className="space-y-4">
      <div className="adm-panel">
        <div className="adm-panel__head">
          <span className="adm-panel__badge">
            <Captions aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="adm-panel__title">{t("admin.subtitles.title")}</h2>
            <p className="adm-panel__sub">{t("admin.subtitles.lede")}</p>
          </div>
        </div>
        <div className="adm-panel__body space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={Boolean(value("enabled"))}
              onChange={(event) => set("enabled", event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">
                {t("admin.subtitles.enabled")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("admin.subtitles.enabledHint")}
              </span>
            </span>
          </label>

          <p className="flex gap-2 rounded-lg bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-ink ring-1 ring-warning/20">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t("admin.subtitles.privacyWarning")}
          </p>
          <p className="flex gap-2 rounded-lg bg-muted p-2.5 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t("admin.subtitles.secretWarning")}
          </p>
        </div>
      </div>

      {(
        [
          {
            key: "transcribe" as const,
            heading: t("admin.subtitles.transcription.heading"),
            lede: t("admin.subtitles.transcription.lede"),
            baseUrlField: "baseUrl" as const,
            modelField: "model" as const,
            keyField: "apiKey" as const,
            stored: config.hasApiKey,
            baseUrlHint: t("admin.subtitles.transcription.baseUrlHint"),
            okKey: "admin.subtitles.testOkTranscribe" as const,
            extraHint: null,
          },
          {
            key: "translate" as const,
            heading: t("admin.subtitles.translation.heading"),
            lede: t("admin.subtitles.translation.lede"),
            baseUrlField: "translateBaseUrl" as const,
            modelField: "translateModel" as const,
            keyField: "translateApiKey" as const,
            stored: config.hasTranslateApiKey,
            baseUrlHint: t("admin.subtitles.translation.baseUrlHint"),
            okKey: "admin.subtitles.testOkTranslate" as const,
            extraHint: t("admin.subtitles.translation.sameKeyHint"),
          },
        ]
      ).map((block) => {
        const result = results[block.key];
        return (
          <div key={block.key} className="adm-panel">
            <div className="adm-panel__head">
              <div className="min-w-0">
                <h3 className="adm-panel__title">{block.heading}</h3>
                <p className="adm-panel__sub">{block.lede}</p>
              </div>
              <div className="adm-panel__tools">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void test(block.key)}
                  disabled={testing !== null || !block.stored}
                >
                  {testing === block.key && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {testing === block.key ? t("admin.subtitles.testing") : t("admin.subtitles.test")}
                </Button>
              </div>
            </div>
            <div className="adm-panel__body space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`${block.key}-base-url`}
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    {t("admin.subtitles.transcription.baseUrl")}
                  </label>
                  <Input
                    id={`${block.key}-base-url`}
                    value={String(value(block.baseUrlField) ?? "")}
                    onChange={(event) => set(block.baseUrlField, event.target.value)}
                    spellCheck={false}
                    className="font-mono"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{block.baseUrlHint}</p>
                </div>
                <div>
                  <label
                    htmlFor={`${block.key}-model`}
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    {t("admin.subtitles.transcription.model")}
                  </label>
                  <Input
                    id={`${block.key}-model`}
                    value={String(value(block.modelField) ?? "")}
                    onChange={(event) => set(block.modelField, event.target.value)}
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
              </div>

              <KeyField
                id={`${block.key}-key`}
                label={t("admin.subtitles.transcription.apiKey")}
                stored={block.stored}
                value={keys[block.keyField]}
                onChange={(next) => {
                  setKeys((current) => ({ ...current, [block.keyField]: next }));
                  setCleared((current) => ({ ...current, [block.keyField]: false }));
                }}
                onClear={() => {
                  setKeys((current) => ({ ...current, [block.keyField]: "" }));
                  setCleared((current) => ({ ...current, [block.keyField]: true }));
                }}
              />
              {block.extraHint && (
                <p className="text-xs text-muted-foreground">{block.extraHint}</p>
              )}

              {result && (
                <p
                  role="status"
                  className={
                    result.ok
                      ? "rounded-lg bg-success/10 p-2.5 text-xs text-success-ink ring-1 ring-success/20"
                      : "rounded-lg bg-danger/10 p-2.5 text-xs text-danger-ink ring-1 ring-danger/20"
                  }
                >
                  {result.ok
                    ? t(block.okKey, { model: result.model })
                    : t("admin.subtitles.testFailed", {
                        reason: result.message ?? String(result.status ?? ""),
                      })}
                </p>
              )}
              {cleared[block.keyField] && (
                <p className="text-xs text-danger-ink">{t("admin.subtitles.keyClear")}</p>
              )}
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => void save()} disabled={saving || !dirty}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {saving ? t("admin.subtitles.saving") : t("admin.subtitles.save")}
        </Button>
      </div>
    </div>
  );
}
