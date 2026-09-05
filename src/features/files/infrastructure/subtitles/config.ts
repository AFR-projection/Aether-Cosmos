import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { db as defaultDb } from "@/shared/infrastructure/db";
import { subtitleSettings } from "@/shared/infrastructure/db/schema";
import { decryptSecret, encryptSecret } from "@/shared/infrastructure/email/crypto";

/**
 * Global (single-row) configuration for the two subtitle providers.
 *
 * This is the ONLY module that decrypts either API key, and it does so server-side only:
 * {@link loadSubtitleConfig} returns plaintext keys for the worker, while
 * {@link publicSubtitleConfig} produces the client-safe shape that never carries them. The route
 * layer must return the public shape and nothing else.
 *
 * Structured after `@brain/infrastructure/providers/config.ts`, including the 30-second cache:
 * every generate request reads this, and re-decrypting per request is wasted work. Any write
 * calls {@link invalidateSubtitleConfigCache}, so a rotated key or a flipped toggle takes effect
 * on the next read rather than half a minute later.
 *
 * **A note for whoever reads this after rotating `SESSION_SECRET`:** the ciphertext is sealed with
 * that secret. Rotating it does not corrupt these rows, but it does make them unreadable — the
 * keys have to be pasted again in /admin/subtitles. A key that will not decrypt is reported as
 * absent rather than thrown, so the feature switches itself off instead of erroring on every
 * request. Same behaviour, same reason, as the Gmail App Passwords.
 */

const SETTINGS_ID = "default";
const CACHE_TTL_MS = 30_000;

type SubtitleDb = PostgresJsDatabase<typeof schema>;

/** Fully resolved config, keys decrypted. Server-side only — never serialise this. */
export type SubtitleConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  /** Decrypted transcription key, or null when unset (or when decryption failed). */
  apiKey: string | null;
  translateBaseUrl: string;
  translateModel: string;
  /** Decrypted translation key, or null. */
  translateApiKey: string | null;
  enabled: boolean;
};

/** Client-safe projection. Deliberately WITHOUT either key — only whether one exists. */
export type PublicSubtitleConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  translateBaseUrl: string;
  translateModel: string;
  hasTranslateApiKey: boolean;
  enabled: boolean;
};

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "whisper-large-v3-turbo",
  apiKey: null,
  translateBaseUrl: "https://openrouter.ai/api/v1",
  translateModel: "google/gemini-2.5-flash",
  translateApiKey: null,
  enabled: false,
};

type CacheEntry = { value: SubtitleConfig; fetchedAt: number };
let cache: CacheEntry | null = null;

export function invalidateSubtitleConfigCache(): void {
  cache = null;
}

/** A stored secret, or null when it is absent or no longer decryptable. */
function readSecret(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

function rowToConfig(row: typeof subtitleSettings.$inferSelect): SubtitleConfig {
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey: readSecret(row.apiKeyEncrypted),
    translateBaseUrl: row.translateBaseUrl,
    translateModel: row.translateModel,
    translateApiKey: readSecret(row.translateApiKeyEncrypted),
    enabled: row.enabled,
  };
}

/**
 * Load the resolved config. Cached for {@link CACHE_TTL_MS}. On any DB error, returns the
 * defaults (disabled, no keys) so a config-table read can never take the files page down.
 */
export async function loadSubtitleConfig(
  db: SubtitleDb = defaultDb,
  force = false
): Promise<SubtitleConfig> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  try {
    const [row] = await db
      .select()
      .from(subtitleSettings)
      .where(eq(subtitleSettings.id, SETTINGS_ID))
      .limit(1);
    const value = row ? rowToConfig(row) : { ...DEFAULT_SUBTITLE_CONFIG };
    cache = { value, fetchedAt: Date.now() };
    return value;
  } catch {
    return { ...DEFAULT_SUBTITLE_CONFIG };
  }
}

export function publicSubtitleConfig(config: SubtitleConfig): PublicSubtitleConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: Boolean(config.apiKey),
    translateBaseUrl: config.translateBaseUrl,
    translateModel: config.translateModel,
    hasTranslateApiKey: Boolean(config.translateApiKey),
    enabled: config.enabled,
  };
}

/** The client-safe config, read straight from the DB. Convenience for the GET route. */
export async function getPublicSubtitleConfig(
  db: SubtitleDb = defaultDb
): Promise<PublicSubtitleConfig> {
  return publicSubtitleConfig(await loadSubtitleConfig(db, true));
}

/**
 * Whether subtitles can be generated at all right now.
 *
 * Transcription needs its key; translation is separate, so a missing translation key means "one
 * language only" rather than "nothing works". The route reports both so the UI can offer the
 * transcript without promising a translation it cannot make.
 */
export function subtitleCapability(config: SubtitleConfig): {
  canTranscribe: boolean;
  canTranslate: boolean;
} {
  const canTranscribe = config.enabled && Boolean(config.apiKey);
  return { canTranscribe, canTranslate: canTranscribe && Boolean(config.translateApiKey) };
}

export type SubtitleConfigUpdate = {
  provider?: string;
  baseUrl?: string;
  model?: string;
  translateBaseUrl?: string;
  translateModel?: string;
  enabled?: boolean;
  /**
   * New plaintext key to encrypt and store. `undefined` leaves the stored key untouched (so
   * toggling `enabled` need not resend it); `null` explicitly clears it.
   */
  apiKey?: string | null;
  translateApiKey?: string | null;
};

/**
 * Upsert the single config row. The keys are encrypted here and only here; callers pass
 * plaintext. Invalidates the cache so the next request sees the change immediately.
 */
export async function updateSubtitleConfig(
  update: SubtitleConfigUpdate,
  db: SubtitleDb = defaultDb
): Promise<PublicSubtitleConfig> {
  const now = new Date();

  const set: Partial<typeof subtitleSettings.$inferInsert> = { updatedAt: now };
  if (update.provider !== undefined) set.provider = update.provider;
  if (update.baseUrl !== undefined) set.baseUrl = update.baseUrl;
  if (update.model !== undefined) set.model = update.model;
  if (update.translateBaseUrl !== undefined) set.translateBaseUrl = update.translateBaseUrl;
  if (update.translateModel !== undefined) set.translateModel = update.translateModel;
  if (update.enabled !== undefined) set.enabled = update.enabled;
  if (update.apiKey !== undefined) {
    set.apiKeyEncrypted = update.apiKey === null ? null : encryptSecret(update.apiKey);
  }
  if (update.translateApiKey !== undefined) {
    set.translateApiKeyEncrypted =
      update.translateApiKey === null ? null : encryptSecret(update.translateApiKey);
  }

  const [row] = await db
    .insert(subtitleSettings)
    .values({
      id: SETTINGS_ID,
      provider: set.provider ?? DEFAULT_SUBTITLE_CONFIG.provider,
      baseUrl: set.baseUrl ?? DEFAULT_SUBTITLE_CONFIG.baseUrl,
      model: set.model ?? DEFAULT_SUBTITLE_CONFIG.model,
      apiKeyEncrypted: set.apiKeyEncrypted ?? null,
      translateBaseUrl: set.translateBaseUrl ?? DEFAULT_SUBTITLE_CONFIG.translateBaseUrl,
      translateModel: set.translateModel ?? DEFAULT_SUBTITLE_CONFIG.translateModel,
      translateApiKeyEncrypted: set.translateApiKeyEncrypted ?? null,
      enabled: set.enabled ?? DEFAULT_SUBTITLE_CONFIG.enabled,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: subtitleSettings.id, set })
    .returning();

  invalidateSubtitleConfigCache();
  return publicSubtitleConfig(rowToConfig(row));
}
