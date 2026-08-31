import { OpenRouterEmbeddingProvider } from "./openrouter";

/**
 * Auto-detect the native embedding width of an OpenRouter model (P9, multi-model).
 *
 * Because the request never pins `dimensions`, the only reliable way to know how wide a
 * model's vectors are is to embed a tiny sample and measure the result. The settings
 * "Test" endpoint and the PUT (save) path both use this: Test reports the width to the
 * operator, and save stores it so later batches can be validated for a consistent width.
 *
 * The probe runs in AUTO mode (`dimensions: null`) so it accepts whatever the model
 * returns — that is exactly the value we want to learn. Any failure (bad key, unreachable
 * host, model error, empty vector) propagates as an `OpenRouterEmbeddingError` for the
 * caller to surface; nothing is persisted on failure.
 */

export const DETECT_SAMPLE = "Second Brain embedding connectivity test.";

export async function detectEmbeddingDimension(opts: {
  apiKey: string;
  model: string;
}): Promise<number> {
  const provider = new OpenRouterEmbeddingProvider({
    apiKey: opts.apiKey,
    model: opts.model,
    dimensions: null,
  });
  const [vector] = await provider.embed([DETECT_SAMPLE]);
  return vector?.length ?? 0;
}
