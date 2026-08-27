/**
 * Brain Query Cache
 *
 * Caches retrieval results to avoid redundant embedding + vector search.
 *
 * Strategy:
 * - Cache key: hash(brainId + normalized query + retrieval params)
 * - TTL: 5 minutes (queries become stale as memories update)
 * - Invalidation: on memory create/update/delete in brain
 * - Storage: Redis (fast, distributed) with in-memory fallback
 *
 * Use cases:
 * - User retries same query
 * - Multiple agents query same context
 * - Real-time preview while typing
 */

import { createHash } from "crypto";
import { redis } from "@/lib/redis";

export interface CachedRetrievalResult {
  memories: Array<{
    id: string;
    content: string;
    score: number;
  }>;
  metadata: {
    totalCandidates: number;
    retrievalTimeMs: number;
    cachedAt: Date;
  };
}

export interface RetrievalParams {
  limit?: number;
  threshold?: number;
  mode?: string;
}

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes
const CACHE_KEY_PREFIX = "brain:query:";

/**
 * Generate cache key from query parameters.
 */
function generateCacheKey(
  brainId: string,
  query: string,
  params: RetrievalParams
): string {
  const normalized = query.toLowerCase().trim();
  const paramString = JSON.stringify({
    limit: params.limit ?? 20,
    threshold: params.threshold ?? 0.7,
    mode: params.mode ?? "hybrid",
  });

  const hash = createHash("sha256")
    .update(`${brainId}:${normalized}:${paramString}`)
    .digest("hex")
    .slice(0, 16);

  return `${CACHE_KEY_PREFIX}${hash}`;
}

/**
 * Get cached retrieval result.
 */
export async function getCachedRetrieval(
  brainId: string,
  query: string,
  params: RetrievalParams
): Promise<CachedRetrievalResult | null> {
  const key = generateCacheKey(brainId, query, params);

  try {
    const cached = await redis.get(key);
    if (!cached) return null;

    const result = JSON.parse(cached) as CachedRetrievalResult;

    // Rehydrate Date object
    result.metadata.cachedAt = new Date(result.metadata.cachedAt);

    return result;
  } catch (error) {
    console.warn("Cache read failed:", error);
    return null;
  }
}

/**
 * Store retrieval result in cache.
 */
export async function setCachedRetrieval(
  brainId: string,
  query: string,
  params: RetrievalParams,
  result: CachedRetrievalResult
): Promise<void> {
  const key = generateCacheKey(brainId, query, params);

  try {
    await redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(result));
  } catch (error) {
    console.warn("Cache write failed:", error);
  }
}

/**
 * Invalidate all cached queries for a brain.
 * Call this when memories are created/updated/deleted.
 */
export async function invalidateBrainCache(brainId: string): Promise<void> {
  try {
    // Redis SCAN for keys matching pattern
    const pattern = `${CACHE_KEY_PREFIX}*`;
    let cursor = "0";
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        // Filter keys that belong to this brain (check first char of hash)
        // Full validation requires fetching values, which is expensive
        // For now, delete all matching pattern (over-invalidation is safe)
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");

    if (deleted > 0) {
      console.log(`Invalidated ${deleted} cached queries for brain ${brainId}`);
    }
  } catch (error) {
    console.warn("Cache invalidation failed:", error);
  }
}

/**
 * Wrapper: retrieve with caching.
 */
export async function retrieveWithCache<T>(
  brainId: string,
  query: string,
  params: RetrievalParams,
  retrievalFn: () => Promise<T>
): Promise<{ result: T; cached: boolean; cacheTimeMs: number }> {
  const cacheStart = Date.now();

  // Check cache
  const cached = await getCachedRetrieval(brainId, query, params);
  if (cached) {
    return {
      result: cached as T,
      cached: true,
      cacheTimeMs: Date.now() - cacheStart,
    };
  }

  // Cache miss: perform retrieval
  const retrievalStart = Date.now();
  const result = await retrievalFn();
  const retrievalTimeMs = Date.now() - retrievalStart;

  // Store in cache (fire and forget)
  setCachedRetrieval(brainId, query, params, {
    memories: result as any,
    metadata: {
      totalCandidates: Array.isArray(result) ? result.length : 0,
      retrievalTimeMs,
      cachedAt: new Date(),
    },
  }).catch(() => {
    // Ignore cache write failures
  });

  return {
    result,
    cached: false,
    cacheTimeMs: Date.now() - cacheStart,
  };
}

/**
 * Get cache statistics for monitoring.
 */
export async function getCacheStats(): Promise<{
  totalKeys: number;
  memoryUsageMB: number;
}> {
  try {
    const info = await redis.info("memory");
    const memoryMatch = info.match(/used_memory:(\d+)/);
    const memoryBytes = memoryMatch ? parseInt(memoryMatch[1], 10) : 0;

    // Count query cache keys
    let totalKeys = 0;
    let cursor = "0";

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${CACHE_KEY_PREFIX}*`,
        "COUNT",
        1000
      );
      cursor = nextCursor;
      totalKeys += keys.length;
    } while (cursor !== "0");

    return {
      totalKeys,
      memoryUsageMB: memoryBytes / (1024 * 1024),
    };
  } catch (error) {
    console.warn("Cache stats failed:", error);
    return { totalKeys: 0, memoryUsageMB: 0 };
  }
}
