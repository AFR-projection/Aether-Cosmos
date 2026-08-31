import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/shared/infrastructure/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { brainEmbeddingSettings, EMBEDDING_DIMENSIONS } from "@/shared/infrastructure/db/schema";
import { decryptSecret, encryptSecret } from "@/shared/infrastructure/email/crypto";

/**
 * Global (single-row) configuration for the semantic embedding provider (P9).
 *
 * This is the ONLY module that decrypts the API key, and it does so server-side only:
 * {@link loadEmbeddingConfig} returns the plaintext key for use by the provider, while
 * {@link publicEmbeddingConfig} produces the client-safe shape that never carries it.
 * The route layer must return the public shape and nothing else.
 *
 * A 30s in-process cache mirrors `src/features/admin/domain/services/admin-settings.ts`: retrieval reads the config on
 * every semantic query, and re-decrypting per request is wasted work. Any write calls
 * {@link invalidateEmbeddingConfigCache} so a rotated key or a flipped toggle takes
 * effect on the next read, not 30s later.
 */

const SETTINGS_ID = "default";
const CACHE_TTL_MS = 30_000;

type EmbeddingDb = PostgresJsDatabase<typeof schema>;

/** Fully resolved config, key decrypted. Server-side only — never serialise this. */
export type EmbeddingConfig = {
  provider: string;
  model: string;
  dimensions: number;
  enabled: boolean;
  /** Decrypted API key, or null when unset (or when decryption failed). */
  apiKey: string | null;
};

/** Client-safe projection. Deliberately WITHOUT the key — only whether one exists. */
export type PublicEmbeddingConfig = {
  provider: string;
  model: string;
  dimensions: number;
  enabled: boolean;
  hasApiKey: boolean;
};

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: "openrouter",
  model: "openai/text-embedding-3-small",
  dimensions: EMBEDDING_DIMENSIONS,
  enabled: false,
  apiKey: null,
};

type CacheEntry = { value: EmbeddingConfig; fetchedAt: number };
let cache: CacheEntry | null = null;

export function invalidateEmbeddingConfigCache(): void {
  cache = null;
}

function rowToConfig(row: typeof brainEmbeddingSettings.$inferSelect): EmbeddingConfig {
  let apiKey: string | null = null;
  if (row.apiKeyEncrypted) {
    try {
      apiKey = decryptSecret(row.apiKeyEncrypted);
    } catch {
      // A key that will not decrypt (e.g. SESSION_SECRET rotated) is treated as absent:
      // the provider reports unavailable and retrieval degrades, rather than throwing on
      // every query. Re-saving the key from /brain/settings fixes it.
      apiKey = null;
    }
  }
  return {
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    enabled: row.enabled,
    apiKey,
  };
}

/**
 * Load the resolved config (key decrypted). Cached for {@link CACHE_TTL_MS}. On any DB
 * error, returns the defaults (disabled, no key) so a config-table read can never take
 * retrieval down.
 */
export async function loadEmbeddingConfig(
  db: EmbeddingDb = defaultDb,
  force = false
): Promise<EmbeddingConfig> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  try {
    const [row] = await db
      .select()
      .from(brainEmbeddingSettings)
      .where(eq(brainEmbeddingSettings.id, SETTINGS_ID))
      .limit(1);
    const value = row ? rowToConfig(row) : { ...DEFAULT_EMBEDDING_CONFIG };
    cache = { value, fetchedAt: Date.now() };
    return value;
  } catch {
    return { ...DEFAULT_EMBEDDING_CONFIG };
  }
}

export function publicEmbeddingConfig(config: EmbeddingConfig): PublicEmbeddingConfig {
  return {
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    enabled: config.enabled,
    hasApiKey: Boolean(config.apiKey),
  };
}

/** The client-safe config, read straight from the DB. Convenience for the GET route. */
export async function getPublicEmbeddingConfig(
  db: EmbeddingDb = defaultDb
): Promise<PublicEmbeddingConfig> {
  return publicEmbeddingConfig(await loadEmbeddingConfig(db, true));
}

export type EmbeddingConfigUpdate = {
  provider?: string;
  model?: string;
  enabled?: boolean;
  /** Auto-detected native width of the model, stored so returned vectors can be validated. */
  dimensions?: number;
  /**
   * New plaintext API key to encrypt and store. `undefined` leaves the stored key
   * untouched (so toggling `enabled` need not resend it); `null` explicitly clears it.
   */
  apiKey?: string | null;
};

/**
 * Upsert the single config row. The key is encrypted here and only here; callers pass
 * plaintext. Invalidates the cache so the next read (and the next semantic query) sees
 * the change immediately.
 */
export async function updateEmbeddingConfig(
  update: EmbeddingConfigUpdate,
  db: EmbeddingDb = defaultDb
): Promise<PublicEmbeddingConfig> {
  const now = new Date();

  const set: Partial<typeof brainEmbeddingSettings.$inferInsert> = { updatedAt: now };
  if (update.provider !== undefined) set.provider = update.provider;
  if (update.model !== undefined) set.model = update.model;
  if (update.enabled !== undefined) set.enabled = update.enabled;
  if (update.dimensions !== undefined) set.dimensions = update.dimensions;
  if (update.apiKey !== undefined) {
    set.apiKeyEncrypted = update.apiKey === null ? null : encryptSecret(update.apiKey);
  }

  const [row] = await db
    .insert(brainEmbeddingSettings)
    .values({
      id: SETTINGS_ID,
      provider: set.provider ?? DEFAULT_EMBEDDING_CONFIG.provider,
      model: set.model ?? DEFAULT_EMBEDDING_CONFIG.model,
      enabled: set.enabled ?? DEFAULT_EMBEDDING_CONFIG.enabled,
      apiKeyEncrypted: set.apiKeyEncrypted ?? null,
      dimensions: set.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: brainEmbeddingSettings.id, set })
    .returning();

  invalidateEmbeddingConfigCache();
  return publicEmbeddingConfig(rowToConfig(row));
}

/**
 * Null every stored embedding across all brains. Called when the model (or its detected
 * width) changes: vectors from the old model live in a different space and a different
 * width, so a mixed column would make the exact `<=>` scan compare incomparable vectors.
 * The rows are re-embedded by the backfill under the new model. Returns the count cleared.
 */
export async function clearStoredEmbeddings(db: EmbeddingDb = defaultDb): Promise<number> {
  const result = await db.execute(
    sql`UPDATE memories SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL WHERE embedding IS NOT NULL`
  );
  return (result as unknown as { count?: number }).count ?? 0;
}
