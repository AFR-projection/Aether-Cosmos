"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Save, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrainPanel } from "@/components/brain/brain-states";
import { notify } from "@/lib/system/notify-store";
import { apiFetch } from "@/lib/api/client";

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

export function EmbeddingSettingsCard() {
  const queryClient = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const configQuery = useQuery({
    queryKey: ["brain", "embedding-settings"],
    queryFn: async () => {
      const res = await apiFetch<PublicEmbeddingConfig>(ENDPOINT);
      if (!res.success || !res.data) throw new Error(res.error ?? "Could not load embedding settings");
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
      if (!res.success || !res.data) throw new Error(res.error ?? "Could not save embedding settings");
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
          title: `Saved — model changed (${data.dimensions}-d). Cleared ${data.embeddingsCleared ?? 0} old vectors; run brain:backfill-embed to re-embed.`,
          tone: "success",
        });
      } else {
        notify({ title: "Embedding settings saved", tone: "success" });
      }
    },
    onError: (error) =>
      notify({
        title: error instanceof Error ? error.message : "Could not save embedding settings",
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
          title: `Model OK — ${result.dimensions}-d vectors`,
          tone: "success",
        });
      } else {
        notify({
          title: result?.error ?? res.error ?? "Embedding test failed",
          tone: "error",
        });
      }
    } catch (error) {
      notify({
        title: error instanceof Error ? error.message : "Embedding test failed",
        tone: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  const busy = saveMutation.isPending;

  return (
    <BrainPanel icon={Sparkles} title="Semantic Search (OpenRouter)">
      {configQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading provider settings…
        </div>
      ) : configQuery.isError ? (
        <p className="text-sm text-danger-ink">
          {configQuery.error instanceof Error
            ? configQuery.error.message
            : "Could not load embedding settings"}
          . This is a server-wide setting — a master account is required to view or change it.
        </p>
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
            Server-wide setting. Enabling this sends memory text and search queries to
            OpenRouter to be embedded ({config?.dimensions ?? 1536}-d vectors). It adds a
            per-token cost; leave it off to keep retrieval lexical + graph only.
          </p>

          <div>
            <label htmlFor="embed-key" className="mb-1.5 block text-xs font-medium text-foreground">
              OpenRouter API key
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
                placeholder={config?.hasApiKey ? "•••••••• (configured — leave blank to keep)" : "sk-or-…"}
              />
            </div>
          </div>

          <div>
            <label htmlFor="embed-model" className="mb-1.5 block text-xs font-medium text-foreground">
              Embedding model
            </label>
            <Input
              id="embed-model"
              value={model}
              maxLength={200}
              onChange={(event) => setModel(event.target.value)}
              placeholder="openai/text-embedding-3-small"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-accent"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable semantic retrieval
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
              Test
            </Button>
            <Button type="submit" size="sm" disabled={!model.trim() || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <Save className="h-4 w-4" aria-hidden="true" />
              Save
            </Button>
          </div>
        </form>
      )}
    </BrainPanel>
  );
}
