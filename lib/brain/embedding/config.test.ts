import { describe, it, expect, beforeEach } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema";
import { encryptSecret } from "@/lib/email/crypto";
import {
  clearStoredEmbeddings,
  DEFAULT_EMBEDDING_CONFIG,
  getPublicEmbeddingConfig,
  invalidateEmbeddingConfigCache,
  loadEmbeddingConfig,
  publicEmbeddingConfig,
  updateEmbeddingConfig,
} from "./config";

/**
 * The config module is the ONLY place the API key is decrypted, and the ONLY thing
 * standing between a plaintext secret and a JSON response. These tests pin exactly
 * that boundary: the key round-trips through encryption but never appears in the
 * public shape, the auto-detected width persists across writes, the 30s cache serves
 * stale until it is invalidated, and a DB error degrades to "disabled" instead of
 * taking retrieval down.
 */

type Row = typeof schema.brainEmbeddingSettings.$inferSelect;

function fullRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "default",
    provider: "openrouter",
    model: "openai/text-embedding-3-small",
    apiKeyEncrypted: null,
    dimensions: EMBEDDING_DIMENSIONS,
    enabled: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * A single-row store with the two chains config.ts uses: a `select…limit` read and an
 * `insert…onConflictDoUpdate…returning` upsert that actually persists, so a write is
 * observable by a subsequent load.
 */
function makeDb(seed: Row | null = null) {
  const state: { row: Row | null } = { row: seed };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (state.row ? [state.row] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (vals: Partial<Row>) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<Row> }) => ({
          returning: async () => {
            state.row = state.row
              ? ({ ...state.row, ...set } as Row)
              : (fullRow(vals) as Row);
            return [state.row];
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as PostgresJsDatabase<typeof schema>, state };
}

/** A db whose read always throws — the "config table is unreachable" case. */
function failingDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            throw new Error("connection terminated");
          },
        }),
      }),
    }),
  } as unknown as PostgresJsDatabase<typeof schema>;
}

beforeEach(() => {
  // The cache is module-global; start every test from a clean slate.
  invalidateEmbeddingConfigCache();
});

describe("updateEmbeddingConfig — the write boundary", () => {
  it("stores the key encrypted, and a later load decrypts it back", async () => {
    const { db, state } = makeDb();

    await updateEmbeddingConfig({ apiKey: "sk-or-secret", enabled: true, model: "m1" }, db);

    // What lands in the column is ciphertext, never the plaintext a DB dump could read.
    expect(state.row?.apiKeyEncrypted).toBeTruthy();
    expect(state.row?.apiKeyEncrypted).not.toBe("sk-or-secret");
    expect(state.row?.apiKeyEncrypted).toMatch(/^v1:/);

    invalidateEmbeddingConfigCache();
    const loaded = await loadEmbeddingConfig(db, true);
    expect(loaded.apiKey).toBe("sk-or-secret");
    expect(loaded.enabled).toBe(true);
    expect(loaded.model).toBe("m1");
  });

  it("returns the public shape, which cannot carry the key", async () => {
    const { db } = makeDb();
    const result = await updateEmbeddingConfig({ apiKey: "sk-or-x" }, db);
    expect(result).not.toHaveProperty("apiKey");
    expect(result.hasApiKey).toBe(true);
  });

  it("leaves the stored key untouched when apiKey is omitted", async () => {
    const { db, state } = makeDb();
    await updateEmbeddingConfig({ apiKey: "sk-keep", enabled: true }, db);
    const before = state.row?.apiKeyEncrypted;

    // Toggling `enabled` must not require resending the secret.
    const result = await updateEmbeddingConfig({ enabled: false }, db);
    expect(state.row?.apiKeyEncrypted).toBe(before);
    expect(result.hasApiKey).toBe(true);
  });

  it("clears the stored key when apiKey is explicitly null", async () => {
    const { db, state } = makeDb();
    await updateEmbeddingConfig({ apiKey: "sk-or-x" }, db);
    const result = await updateEmbeddingConfig({ apiKey: null }, db);
    expect(state.row?.apiKeyEncrypted).toBeNull();
    expect(result.hasApiKey).toBe(false);
  });

  it("persists an auto-detected width, and leaves it untouched when omitted", async () => {
    const { db, state } = makeDb();
    // Save with a detected width (e.g. a voyage model) — it must be stored, not pinned.
    await updateEmbeddingConfig({ model: "voyageai/voyage-code-4", enabled: true, dimensions: 1024 }, db);
    expect(state.row?.dimensions).toBe(1024);

    // A later write that does not carry a width (e.g. just toggling) keeps the stored one.
    const result = await updateEmbeddingConfig({ model: "voyageai/voyage-code-4" }, db);
    expect(state.row?.dimensions).toBe(1024);
    expect(result.dimensions).toBe(1024);
  });
});

describe("clearStoredEmbeddings", () => {
  it("issues the wipe and reports how many rows it cleared", async () => {
    let called = 0;
    const db = {
      execute: async () => {
        called += 1;
        return { count: 5 } as unknown;
      },
    } as unknown as PostgresJsDatabase<typeof schema>;

    const cleared = await clearStoredEmbeddings(db);
    expect(called).toBe(1);
    expect(cleared).toBe(5);
  });
});

describe("publicEmbeddingConfig", () => {
  it("projects exactly the client-safe fields — and never the key", () => {
    const shape = publicEmbeddingConfig({
      provider: "openrouter",
      model: "m",
      dimensions: EMBEDDING_DIMENSIONS,
      enabled: true,
      apiKey: "sk-or-super-secret",
    });
    expect(shape).not.toHaveProperty("apiKey");
    expect(Object.keys(shape).sort()).toEqual([
      "dimensions",
      "enabled",
      "hasApiKey",
      "model",
      "provider",
    ]);
    expect(shape.hasApiKey).toBe(true);
    expect(JSON.stringify(shape)).not.toContain("super-secret");
  });

  it("reports hasApiKey=false when no key is set", () => {
    expect(publicEmbeddingConfig({ ...DEFAULT_EMBEDDING_CONFIG }).hasApiKey).toBe(false);
  });
});

describe("getPublicEmbeddingConfig", () => {
  it("reads the stored config into the scrubbed shape", async () => {
    const { db } = makeDb(fullRow({ enabled: true, apiKeyEncrypted: encryptSecret("sk-or-live") }));
    const shape = await getPublicEmbeddingConfig(db);
    expect(shape).not.toHaveProperty("apiKey");
    expect(shape.hasApiKey).toBe(true);
    expect(shape.enabled).toBe(true);
  });
});

describe("loadEmbeddingConfig — cache + resilience", () => {
  it("serves the cached value until it is invalidated", async () => {
    const { db, state } = makeDb(fullRow({ enabled: true }));

    const first = await loadEmbeddingConfig(db);
    expect(first.enabled).toBe(true);

    // Underlying row flips, but a read inside the TTL keeps serving the cached value.
    state.row = fullRow({ enabled: false });
    expect((await loadEmbeddingConfig(db)).enabled).toBe(true);

    // A write path calls this; the next read then reflects the change immediately.
    invalidateEmbeddingConfigCache();
    expect((await loadEmbeddingConfig(db)).enabled).toBe(false);
  });

  it("force-reads past the cache", async () => {
    const { db, state } = makeDb(fullRow({ model: "old" }));
    await loadEmbeddingConfig(db);
    state.row = fullRow({ model: "new" });
    expect((await loadEmbeddingConfig(db, true)).model).toBe("new");
  });

  it("treats a key that will not decrypt as absent rather than throwing", async () => {
    // e.g. SESSION_SECRET was rotated. Retrieval must degrade, not crash on every query.
    const { db } = makeDb(fullRow({ enabled: true, apiKeyEncrypted: "not-a-valid-ciphertext" }));
    const config = await loadEmbeddingConfig(db, true);
    expect(config.apiKey).toBeNull();
    expect(config.enabled).toBe(true);
  });

  it("returns disabled defaults when the config table read fails", async () => {
    const config = await loadEmbeddingConfig(failingDb(), true);
    expect(config).toEqual(DEFAULT_EMBEDDING_CONFIG);
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBeNull();
  });

  it("falls back to defaults when no row exists yet", async () => {
    const { db } = makeDb(null);
    const config = await loadEmbeddingConfig(db, true);
    expect(config).toEqual(DEFAULT_EMBEDDING_CONFIG);
  });
});
