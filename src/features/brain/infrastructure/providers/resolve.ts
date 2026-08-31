import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { db as defaultDb } from "@/shared/infrastructure/db";
import {
  NullEmbeddingProvider,
  getTestProviderOverride,
  type EmbeddingProvider,
} from "./provider";
import { OpenRouterEmbeddingProvider } from "./openrouter";
import { loadEmbeddingConfig } from "./config";

/**
 * DB-backed provider resolution (P9).
 *
 * `provider.ts` resolves from env and only ever yields the null provider; this module
 * resolves from `brain_embedding_settings` and yields the OpenRouter provider when the
 * operator has configured one. Retrieval and the embed jobs call {@link getEmbeddingProvider}.
 *
 * A test override set via `setEmbeddingProviderForTests` wins here too, so unit tests can
 * inject a fake provider without a database or a config row.
 */

type EmbeddingDb = PostgresJsDatabase<typeof schema>;

const NULL_PROVIDER = new NullEmbeddingProvider();

/**
 * The provider to use for this database. Returns:
 *  - the test override, if one is set (unit-test seam);
 *  - an {@link OpenRouterEmbeddingProvider} when config is enabled AND a key is present;
 *  - the null provider otherwise (disabled, no key, or a DB read that failed).
 *
 * Never throws: a failure to resolve degrades retrieval to lexical+graph.
 */
export async function getEmbeddingProvider(
  db: EmbeddingDb = defaultDb
): Promise<EmbeddingProvider> {
  const override = getTestProviderOverride();
  if (override) return override;

  try {
    const config = await loadEmbeddingConfig(db);
    if (config.enabled && config.provider === "openrouter" && config.apiKey) {
      return new OpenRouterEmbeddingProvider({
        apiKey: config.apiKey,
        model: config.model,
        // The stored width validates that the model keeps returning what Test detected;
        // 0/unset means "auto" (accept the model's native width).
        dimensions: config.dimensions > 0 ? config.dimensions : null,
      });
    }
  } catch {
    // fall through to the null provider
  }
  return NULL_PROVIDER;
}

/** True when a provider is configured AND reports ready. Never throws. */
export async function embeddingsAvailable(db: EmbeddingDb = defaultDb): Promise<boolean> {
  try {
    return await (await getEmbeddingProvider(db)).available();
  } catch {
    return false;
  }
}
