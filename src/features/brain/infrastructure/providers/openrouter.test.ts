import { describe, it, expect, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@/shared/infrastructure/db/schema";
import { EmbeddingUnavailableError } from "./provider";
import {
  OpenRouterEmbeddingProvider,
  OpenRouterEmbeddingError,
  friendlyOpenRouterError,
  OPENROUTER_EMBEDDINGS_URL,
} from "./openrouter";

/**
 * The provider's one job: turn text into validated vectors, or fail cleanly. These
 * tests pin the guarantees retrieval and the write path lean on — the width is checked
 * before a vector is ever stored, the response order is normalized to the inputs, a
 * failure is a clean typed error (never a partial write), and `available()` is a cheap
 * never-throwing probe that makes NO network call.
 *
 * `fetch` is stubbed per test; nothing here touches the real endpoint.
 */

const KEY = "sk-or-test-key";

/** A JSON `Response` stand-in — only the two methods the provider reads. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

/** N-dimensional vector of a constant, for building well-formed API replies. */
function embeddingOf(value: number, dims = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dims }, () => value);
}

function providerWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new OpenRouterEmbeddingProvider({
    apiKey: KEY,
    model: "openai/text-embedding-3-small",
    fetchImpl,
    ...overrides,
  });
}

describe("OpenRouterEmbeddingProvider.available", () => {
  it("is true when a key is present, with no network call", async () => {
    const fetchImpl = vi.fn();
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    await expect(provider.available()).resolves.toBe(true);
    // A readiness probe that dialed the network would be neither cheap nor safe to call
    // on every request — the contract in provider.ts forbids it.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is false — never throwing — when the key is blank", async () => {
    const provider = providerWith((() => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch, { apiKey: "   " });
    await expect(provider.available()).resolves.toBe(false);
  });
});

describe("OpenRouterEmbeddingProvider.embed", () => {
  it("returns nothing for an empty batch without calling the API", async () => {
    const fetchImpl = vi.fn();
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to embed with no key rather than sending an unauthenticated request", async () => {
    const fetchImpl = vi.fn();
    const provider = providerWith(fetchImpl as unknown as typeof fetch, { apiKey: "" });
    await expect(provider.embed(["hi"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("omits dimensions, and sends deny-collection and the bearer key to the right endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: embeddingOf(0.1), index: 0 }] })
    );
    const provider = providerWith(fetchImpl as unknown as typeof fetch);

    await provider.embed(["hello"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_EMBEDDINGS_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("openai/text-embedding-3-small");
    expect(sent.input).toEqual(["hello"]);
    // `dimensions` must NOT be sent: pinning it breaks models like voyage-code-4, which
    // reject 1536 outright. Each model's native width is used and detected instead.
    expect(sent).not.toHaveProperty("dimensions");
    expect(sent.encoding_format).toBe("float");
    // The privacy tradeoff the operator opted into is asserted at the wire: ask the
    // upstream not to retain the content.
    expect(sent.provider).toEqual({ data_collection: "deny" });
  });

  it("returns Float32Array vectors of the configured width", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: embeddingOf(0.25), index: 0 }] })
    );
    const [vector] = await providerWith(fetchImpl as unknown as typeof fetch).embed(["x"]);
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(EMBEDDING_DIMENSIONS);
    expect(vector[0]).toBeCloseTo(0.25, 5);
  });

  it("reorders the response by index so a batch matches its inputs", async () => {
    // OpenRouter may return embeddings out of order; the index is authoritative.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { embedding: embeddingOf(0.2), index: 1 },
          { embedding: embeddingOf(0.1), index: 0 },
        ],
      })
    );
    const vectors = await providerWith(fetchImpl as unknown as typeof fetch).embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBeCloseTo(0.1, 5);
    expect(vectors[1][0]).toBeCloseTo(0.2, 5);
  });

  it("accepts any width in auto mode, returning a Float32Array of the model's native width", async () => {
    // No expected width configured → the provider takes whatever the model produces. This
    // is what makes non-1536 models (voyage-code-4 → 1024, etc.) work at all.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: embeddingOf(0.3, 1024), index: 0 }] })
    );
    const [vector] = await providerWith(fetchImpl as unknown as typeof fetch).embed(["x"]);
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(1024);
  });

  it("rejects a batch that mixes widths in auto mode", async () => {
    // Even without a configured width, one batch must be internally consistent — a mixed
    // column would make the exact <=> scan compare incomparable vectors.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { embedding: embeddingOf(0.1, 1024), index: 0 },
          { embedding: embeddingOf(0.2, 512), index: 1 },
        ],
      })
    );
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    await expect(provider.embed(["a", "b"])).rejects.toThrow(/inconsistent widths/);
  });

  it("rejects a wrong-width vector when an expected width is configured", async () => {
    // Once Test has detected and stored a width, a model that later drifts to another width
    // must be caught HERE, not three days into a backfill or at query time.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: embeddingOf(0.1, 768), index: 0 }] })
    );
    const provider = providerWith(fetchImpl as unknown as typeof fetch, { dimensions: 1536 });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(OpenRouterEmbeddingError);
    await expect(provider.embed(["x"])).rejects.toThrow(/768 dimensions, expected 1536/);
  });

  it("rejects a count mismatch between inputs and returned embeddings", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: embeddingOf(0.1), index: 0 }] })
    );
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    await expect(provider.embed(["a", "b"])).rejects.toThrow(/1 embeddings for 2 inputs/);
  });

  it("maps an HTTP error to a typed error carrying the status and body message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "invalid api key" } }, { ok: false, status: 401 })
    );
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    const err = await provider.embed(["x"]).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterEmbeddingError);
    expect((err as OpenRouterEmbeddingError).status).toBe(401);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).toMatch(/invalid api key/);
  });

  it("surfaces an application-level error object even on a 200", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "model not found" } }));
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    await expect(provider.embed(["x"])).rejects.toThrow(/model not found/);
  });

  it("maps a network failure to a friendly, admin-safe message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = providerWith(fetchImpl as unknown as typeof fetch);
    await expect(provider.embed(["x"])).rejects.toThrow(/Could not reach openrouter\.ai/);
  });

  it("aborts and reports a timeout when the API hangs past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });
      const provider = providerWith(fetchImpl as unknown as typeof fetch, { timeoutMs: 50 });
      const pending = provider.embed(["x"]);
      const asserted = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await asserted;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("friendlyOpenRouterError", () => {
  it("names a timeout for an AbortError", () => {
    expect(friendlyOpenRouterError(new DOMException("x", "AbortError"))).toMatch(/timed out/);
  });

  it("names an unreachable host for common network errors", () => {
    expect(friendlyOpenRouterError(new Error("getaddrinfo ENOTFOUND openrouter.ai"))).toMatch(
      /Could not reach openrouter\.ai/
    );
  });

  it("truncates an unknown message so an error can never dump a huge body", () => {
    expect(friendlyOpenRouterError(new Error("z".repeat(1000))).length).toBeLessThanOrEqual(300);
  });
});
