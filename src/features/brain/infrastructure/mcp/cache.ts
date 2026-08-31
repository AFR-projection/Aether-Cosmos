/**
 * MCP query result cache (Phase 2 performance enhancement).
 *
 * Frequent brain_context and brain_search calls with identical parameters hit the
 * database every time. This layer adds an in-process LRU cache with TTL:
 * - brain_context results are cached for 60s (memories change less often than queries repeat)
 * - brain_search results are cached for 30s (user expects fresher search results)
 * - Cache keys include brainId + operation + params hash, so different brains never collide
 * - Memory-bounded: max 100 entries, each capped at ~50KB serialized
 * - Invalidation: manual via invalidateBrainCache(brainId) on any write operation
 *
 * This is a read-through cache: misses fall through to the real implementation.
 * Nothing here writes to the database.
 */

import { createHash } from "crypto";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  sizeBytes: number;
};

type CacheKey = string;

const cache = new Map<CacheKey, CacheEntry<unknown>>();

/** Max entries across all brains. LRU eviction when exceeded. */
const MAX_ENTRIES = 100;
/** Max size per entry. Larger results are not cached. */
const MAX_ENTRY_SIZE = 50_000;
/** Total memory budget. Evict oldest when exceeded. */
const MAX_TOTAL_SIZE = 5_000_000; // 5MB

let totalSize = 0;

export const CACHE_TTL = {
  context: 60_000, // 60s - memories change slowly
  search: 30_000, // 30s - search feels stale faster
  analytics: 120_000, // 2min - aggregates don't need real-time
  semantic_status: 30_000, // 30s
};

/**
 * Build a cache key from operation + brainId + params.
 * Params are sorted and hashed so {a:1, b:2} === {b:2, a:1}.
 */
function buildKey(operation: string, brainId: string, params: Record<string, unknown>): CacheKey {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join("&");
  const hash = createHash("sha256").update(sorted).digest("hex").slice(0, 16);
  return `${operation}:${brainId}:${hash}`;
}

function evictOldest(): void {
  if (cache.size === 0) return;
  const oldest = Array.from(cache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
  if (oldest) {
    totalSize -= oldest[1].sizeBytes;
    cache.delete(oldest[0]);
  }
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt < now) {
      totalSize -= entry.sizeBytes;
      cache.delete(key);
    }
  }
}

/**
 * Get a cached result. Returns undefined on miss or expiry.
 * Automatically evicts expired entries on every read (lazy cleanup).
 */
export function getCached<T>(
  operation: string,
  brainId: string,
  params: Record<string, unknown>
): T | undefined {
  evictExpired();

  const key = buildKey(operation, brainId, params);
  const entry = cache.get(key) as CacheEntry<T> | undefined;

  if (!entry) return undefined;

  const now = Date.now();
  if (entry.expiresAt < now) {
    totalSize -= entry.sizeBytes;
    cache.delete(key);
    return undefined;
  }

  return entry.value;
}

/**
 * Cache a result. Skips if the serialized size exceeds MAX_ENTRY_SIZE.
 * Evicts oldest entries if cache is full or total size is exceeded.
 */
export function setCached<T>(
  operation: string,
  brainId: string,
  params: Record<string, unknown>,
  value: T,
  ttl: number
): void {
  const key = buildKey(operation, brainId, params);
  const serialized = JSON.stringify(value);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  // Don't cache oversized results
  if (sizeBytes > MAX_ENTRY_SIZE) return;

  // Evict if at capacity
  while (cache.size >= MAX_ENTRIES) {
    evictOldest();
  }

  // Evict if over memory budget
  while (totalSize + sizeBytes > MAX_TOTAL_SIZE && cache.size > 0) {
    evictOldest();
  }

  const entry: CacheEntry<T> = {
    value,
    expiresAt: Date.now() + ttl,
    sizeBytes,
  };

  // Remove old entry size if overwriting
  const existing = cache.get(key);
  if (existing) {
    totalSize -= existing.sizeBytes;
  }

  cache.set(key, entry);
  totalSize += sizeBytes;
}

/**
 * Invalidate all cached results for a brain. Call this on any write operation
 * (remember, update, delete, link) to ensure reads see fresh data.
 */
export function invalidateBrainCache(brainId: string): void {
  const toDelete: CacheKey[] = [];
  for (const [key] of cache.entries()) {
    // Key format: "operation:brainId:hash"
    if (key.split(":")[1] === brainId) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    const entry = cache.get(key);
    if (entry) {
      totalSize -= entry.sizeBytes;
      cache.delete(key);
    }
  }
}

/**
 * Clear the entire cache. Use for tests or manual resets.
 */
export function clearCache(): void {
  cache.clear();
  totalSize = 0;
}

/**
 * Cache stats for observability.
 */
export function getCacheStats(): {
  entries: number;
  totalSizeBytes: number;
  maxEntries: number;
  maxTotalSize: number;
} {
  evictExpired();
  return {
    entries: cache.size,
    totalSizeBytes: totalSize,
    maxEntries: MAX_ENTRIES,
    maxTotalSize: MAX_TOTAL_SIZE,
  };
}
