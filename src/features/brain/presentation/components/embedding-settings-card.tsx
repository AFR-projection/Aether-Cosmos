"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Save, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { BrainPanel } from "@brain/presentation/components/brain-states";
import { notify } from "@/shared/lib/system/notify-store";
import { apiFetch } from "@/shared/api/client";
import { apiErrorMessage, useFormat, useT } from "@/shared/lib/i18n";

/**
 * Server-wide semantic-embedding provider (OpenRouter) configuration card (P9).
 *
 * The config is GLOBAL, not per-brain — one API key/model powers the semantic leg for
 * every brain — and it is master-gated on the server, so a non-master viewer simply sees
 * the load error rather than an editable form. The key is never returned by the API: the
 * password field stays blank and shows "configured" via `hasApiKey`; leaving it blank on
 * Save keeps the stored key untouched.
 */

type PublicEmbeddingConfig = {
  provider: string;
  model: string;
  dimensions: number;
  enabled: boolean;
  hasApiKey: boolean;
};

/** PUT also reports whether the model/width change invalidated the stored vectors. */
type SaveResult = PublicEmbeddingConfig & {
  reembedRequired?: boolean;
  embeddingsCleared?: number;
};

type TestResult = {
  ok: boolean;
  model?: string;
  dimensions?: number;
  error?: string;
};

const ENDPOINT = "/api/brain/embedding-settings";

/** Field hints that are literal identifiers rather than prose, so never translated. */
const KEY_PLACEHOLDER = "sk-or-…";
const MODEL_PLACEHOLDER = "openai/text-embedding-3-small";

export function EmbeddingSettingsCard() {
  const queryClient = useQueryClient();
  const t = useT();
  const { formatNumber } = useFormat();

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const configQuery = useQuery({
    queryKey: ["brain", "embedding-settings"],
    queryFn: async () => {
      const res = await apiFetch<PublicEmbeddingConfig>(ENDPOINT);
      // Resolved here rather than at render: the thrown message is already display-ready,
      // and `t` is stable per locale so a language switch refetches into the new wording.
      if (!res.success || !res.data) {
        throw new Error(apiErrorMessage(res, t, "brain.embedding.loadFailed"));
      }
      return res.data;
    },
    retry: false,
  });

  const config = configQuery.data;

  // Seed the editable fields once per loaded config, without an effect: the model+enabled
  // signature we last seeded from is the state that matters. The API key is never seeded
  // (the server never sends it) — a blank field means "leave the stored key untouched".
  if (config) {
    const signature = `${config.model}|${config.enabled}`;
    if (seededFor !== signature) {
      setSeededFor(signature);
      setModel(config.model);
      setEnabled(config.enabled);
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: "openrouter",
        model: model.trim(),
        enabled,
      };
      // Only send the key when the operator actually typed one — blank leaves it as is.
      if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();

      const res = await apiFetch<SaveResult>(ENDPOINT, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (!res.success || !res.data) {
        throw new Error(apiErrorMessage(res, t, "brain.embedding.saveFailed"));
      }
      return res.data;
    },
    onSuccess: (data) => {
      setApiKey("");
      setSeededFor(null); // re-seed from the authoritative saved config
      queryClient.setQueryData(["brain", "embedding-settings"], {
        provider: data.provider,
        model: data.model,
        dimensions: data.dimensions,
        enabled: data.enabled,
        hasApiKey: data.hasApiKey,
      } satisfies PublicEmbeddingConfig);
      if (data.reembedRequired) {
        notify({
          title: t("brain.embedding.savedReembed", {
            dimensions: formatNumber(data.dimensions),
            cleared: formatNumber(data.embeddingsCleared ?? 0),
          }),
          tone: "success",
        });
      } else {
        notify({ title: t("brain.embedding.saved"), tone: "success" });
      }
    },
    onError: (error) =>
      notify({
        title: error instanceof Error ? error.message : t("brain.embedding.saveFailed"),
        tone: "error",
      }),
  });

  async function handleTest() {
    setTesting(true);
    try {
      const body: Record<string, unknown> = {};
      if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();
      if (model.trim().length > 0) body.model = model.trim();

      const res = await apiFetch<TestResult>(`${ENDPOINT}/test`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const result = res.data;
      if (res.success && result?.ok) {
        notify({
          title: t("brain.embedding.testOk", {
            dimensions: formatNumber(result.dimensions ?? 0),
          }),
          tone: "success",
        });
      } else {
        notify({
          // The provider's own error wins when there is one; it names the model or key.
          title: result?.error ?? apiErrorMessage(res, t, "brain.embedding.testFailed"),
          tone: "error",
        });
      }
    } catch (error) {
      notify({
        title: error instanceof Error ? error.message : t("brain.embedding.testFailed"),
        tone: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  const busy = saveMutation.isPending;

  return (
    <BrainPanel icon={Sparkles} title={t("brain.embedding.title")}>
      {configQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t("brain.embedding.loading")}
        </div>
      ) : configQuery.isError ? (
        <>
          <p className="text-sm text-danger-ink">
            {configQuery.error instanceof Error
              ? configQuery.error.message
              : t("brain.embedding.loadFailed")}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("brain.embedding.masterOnly")}
          </p>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!model.trim()) return;
            saveMutation.mutate();
          }}
          className="space-y-3"
        >
          <p className="text-[11px] text-muted-foreground">
            {t("brain.embedding.cost", {
              dimensions: formatNumber(config?.dimensions ?? 1536),
            })}
          </p>

          <div>
            <label htmlFor="embed-key" className="mb-1.5 block text-xs font-medium text-foreground">
              {t("brain.embedding.apiKey")}
            </label>
            <div className="relative">
              <KeyRound
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="embed-key"
                type="password"
                autoComplete="off"
                className="pl-9"
                value={apiKey}
                maxLength={400}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  config?.hasApiKey ? t("brain.embedding.apiKeyConfigured") : KEY_PLACEHOLDER
                }
              />
            </div>
          </div>

          <div>
            <label htmlFor="embed-model" className="mb-1.5 block text-xs font-medium text-foreground">
              {t("brain.embedding.model")}
            </label>
            <Input
              id="embed-model"
              value={model}
              maxLength={200}
              onChange={(event) => setModel(event.target.value)}
              placeholder={MODEL_PLACEHOLDER}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-accent"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t("brain.embedding.enable")}
          </label>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testing || busy}
              onClick={() => void handleTest()}
            >
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Wand2 className="h-4 w-4" aria-hidden="true" />
              )}
              {t("brain.embedding.test")}
            </Button>
            <Button type="submit" size="sm" disabled={!model.trim() || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <Save className="h-4 w-4" aria-hidden="true" />
              {t("common.save")}
            </Button>
          </div>
        </form>
      )}
    </BrainPanel>
  );
}
