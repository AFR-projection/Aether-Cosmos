import { describe, it, expect, beforeEach } from "vitest";
import {
  getCached,
  setCached,
  invalidateBrainCache,
  clearCache,
  getCacheStats,
  CACHE_TTL,
} from "./cache";

describe("MCP cache layer", () => {
  beforeEach(() => {
    clearCache();
  });

  it("returns undefined on cache miss", () => {
    const result = getCached("brain_context", "brain-1", { task: "test" });
    expect(result).toBeUndefined();
  });

  it("returns cached value on hit", () => {
    const data = { memories: [], tokensUsed: 100 };
    setCached("brain_context", "brain-1", { task: "test" }, data, CACHE_TTL.context);

    const result = getCached("brain_context", "brain-1", { task: "test" });
    expect(result).toEqual(data);
  });

  it("different params produce different cache keys", () => {
    const data1 = { result: "first" };
    const data2 = { result: "second" };

    setCached("brain_search", "brain-1", { query: "auth" }, data1, CACHE_TTL.search);
    setCached("brain_search", "brain-1", { query: "deploy" }, data2, CACHE_TTL.search);

    expect(getCached("brain_search", "brain-1", { query: "auth" })).toEqual(data1);
    expect(getCached("brain_search", "brain-1", { query: "deploy" })).toEqual(data2);
  });

  it("different brains have separate cache spaces", () => {
    const data1 = { result: "brain1" };
    const data2 = { result: "brain2" };

    setCached("brain_context", "brain-1", { task: "test" }, data1, CACHE_TTL.context);
    setCached("brain_context", "brain-2", { task: "test" }, data2, CACHE_TTL.context);

    expect(getCached("brain_context", "brain-1", { task: "test" })).toEqual(data1);
    expect(getCached("brain_context", "brain-2", { task: "test" })).toEqual(data2);
  });

  it("param order does not matter for cache key", () => {
    const data = { result: "same" };

    setCached("brain_search", "brain-1", { query: "test", limit: 10 }, data, CACHE_TTL.search);

    // Different param order should hit the same cache entry
    const result = getCached("brain_search", "brain-1", { limit: 10, query: "test" });
    expect(result).toEqual(data);
  });

  it("expires entries after TTL", async () => {
    const data = { result: "expires" };
    const shortTTL = 50; // 50ms

    setCached("brain_search", "brain-1", { query: "test" }, data, shortTTL);

    // Should hit immediately
    expect(getCached("brain_search", "brain-1", { query: "test" })).toEqual(data);

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should miss after expiry
    expect(getCached("brain_search", "brain-1", { query: "test" })).toBeUndefined();
  });

  it("invalidates all entries for a brain", () => {
    setCached("brain_context", "brain-1", { task: "task1" }, { result: "a" }, CACHE_TTL.context);
    setCached("brain_search", "brain-1", { query: "query1" }, { result: "b" }, CACHE_TTL.search);
    setCached("brain_context", "brain-2", { task: "task1" }, { result: "c" }, CACHE_TTL.context);

    invalidateBrainCache("brain-1");

    // brain-1 entries should be gone
    expect(getCached("brain_context", "brain-1", { task: "task1" })).toBeUndefined();
    expect(getCached("brain_search", "brain-1", { query: "query1" })).toBeUndefined();

    // brain-2 entry should remain
    expect(getCached("brain_context", "brain-2", { task: "task1" })).toEqual({ result: "c" });
  });

  it("reports correct cache stats", () => {
    clearCache();

    setCached("brain_context", "brain-1", { task: "t1" }, { data: "a" }, CACHE_TTL.context);
    setCached("brain_search", "brain-1", { query: "q1" }, { data: "b" }, CACHE_TTL.search);

    const stats = getCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.totalSizeBytes).toBeGreaterThan(0);
    expect(stats.maxEntries).toBe(100);
  });

  it("does not cache oversized results", () => {
    const huge = { data: "x".repeat(100_000) }; // > 50KB

    setCached("brain_context", "brain-1", { task: "huge" }, huge, CACHE_TTL.context);

    // Should not be cached
    expect(getCached("brain_context", "brain-1", { task: "huge" })).toBeUndefined();
  });

  it("evicts oldest entries when at capacity", () => {
    clearCache();

    // Fill cache to max + 1
    for (let i = 0; i < 101; i++) {
      setCached("brain_context", "brain-1", { task: `task-${i}` }, { data: i }, CACHE_TTL.context);
    }

    const stats = getCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(100);
  });

  it("clearCache removes all entries", () => {
    setCached("brain_context", "brain-1", { task: "t1" }, { data: "a" }, CACHE_TTL.context);
    setCached("brain_search", "brain-2", { query: "q1" }, { data: "b" }, CACHE_TTL.search);

    clearCache();

    const stats = getCacheStats();
    expect(stats.entries).toBe(0);
    expect(stats.totalSizeBytes).toBe(0);
  });

  it("removes expired entries during getCached", async () => {
    const shortTTL = 50;

    setCached("brain_search", "brain-1", { query: "test1" }, { data: "a" }, shortTTL);
    setCached("brain_search", "brain-1", { query: "test2" }, { data: "b" }, CACHE_TTL.search);

    // Wait for first entry to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Trigger cleanup by reading
    getCached("brain_search", "brain-1", { query: "test2" });

    const stats = getCacheStats();
    expect(stats.entries).toBe(1); // Only one entry should remain
  });
});
