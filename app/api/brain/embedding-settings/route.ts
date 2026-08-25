import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import {
  clearStoredEmbeddings,
  getPublicEmbeddingConfig,
  loadEmbeddingConfig,
  updateEmbeddingConfig,
} from "@/lib/brain/embedding/config";
import { detectEmbeddingDimension } from "@/lib/brain/embedding/detect";
import { OpenRouterEmbeddingError } from "@/lib/brain/embedding/openrouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Global semantic-embedding provider configuration (P9).
 *
 * This is a SERVER-WIDE secret with a real per-token cost and a privacy tradeoff
 * (memory text leaves the server for OpenRouter), so writes are gated behind master
 * auth exactly like the Gmail sender config — not behind brain ownership. A regular
 * brain user cannot spend the operator's API budget or flip the privacy posture.
 *
 * The API key is NEVER returned: GET yields only `{provider, model, dimensions,
 * enabled, hasApiKey}`. The key is encrypted at rest and decrypted only server-side by
 * the config module and the provider.
 */

/**
 * Only OpenRouter is wired today. `dimensions` is NOT accepted from the client — it is
 * auto-detected server-side by embedding a sample when the config is enabled, so any
 * OpenRouter model works regardless of its native width. A model whose width changes
 * from what was stored (or whose key/name is bad) fails the save with a 400, never a
 * silently corrupted column.
 */
const updateSchema = z.object({
  provider: z.literal("openrouter").optional(),
  model: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  /**
   * A non-empty string sets a new key; `null` explicitly clears it; omitting the field
   * leaves the stored key untouched — so toggling `enabled` need not resend the secret.
   */
  apiKey: z.union([z.string().trim().min(1).max(400), z.null()]).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "settings");
    return apiSuccess(await getPublicEmbeddingConfig());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "settings");

    const body = updateSchema.parse(await request.json());
    const current = await loadEmbeddingConfig(undefined, true);

    const effectiveModel = body.model ?? current.model;
    const effectiveEnabled = body.enabled ?? current.enabled;
    // Omitted key → keep the stored one; explicit null → cleared; string → the new key.
    const effectiveKey = body.apiKey === undefined ? current.apiKey : body.apiKey;

    let dimensions = current.dimensions;
    let reembedRequired = false;

    // Only probe the network when the result will actually be enabled — a plain disable
    // (or a key clear) must not require a working provider.
    if (effectiveEnabled) {
      if (!effectiveKey || effectiveKey.trim().length === 0) {
        return apiError("An API key is required to enable semantic embeddings", 400);
      }
      try {
        dimensions = await detectEmbeddingDimension({ apiKey: effectiveKey, model: effectiveModel });
      } catch (err) {
        const message =
          err instanceof OpenRouterEmbeddingError || err instanceof Error
            ? err.message
            : "Could not verify the embedding model";
        return apiError(`Embedding model check failed: ${message}`, 400);
      }
      if (!dimensions || dimensions <= 0) {
        return apiError("The embedding model returned no vector — check the model name", 400);
      }
      // A changed model or width means the stored vectors are from another space entirely.
      reembedRequired = effectiveModel !== current.model || dimensions !== current.dimensions;
    }

    // `updateEmbeddingConfig` encrypts the key, scrubs it from the returned shape, and
    // invalidates the 30s config cache so the next semantic query sees the change.
    const config = await updateEmbeddingConfig({
      provider: body.provider,
      model: body.model,
      enabled: body.enabled,
      apiKey: body.apiKey,
      dimensions: effectiveEnabled ? dimensions : undefined,
    });

    let embeddingsCleared = 0;
    if (reembedRequired) embeddingsCleared = await clearStoredEmbeddings();

    return apiSuccess({ ...config, reembedRequired, embeddingsCleared });
  } catch (error) {
    return handleApiError(error);
  }
}
