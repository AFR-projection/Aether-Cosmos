import { describe, it, expect, afterEach } from "vitest";
import {
  cosineSimilarity,
  embeddingInput,
  embeddingsAvailable,
  EmbeddingUnavailableError,
  NullEmbeddingProvider,
  resolveEmbeddingProvider,
  setEmbeddingProviderForTests,
  type EmbeddingProvider,
  type EmbeddingVector,
} from "./provider";

/**
 * The embedding layer's whole job is to be safely absent. These tests pin the two
 * properties everything downstream depends on: an unconfigured deployment reports
 * "no opinion" instead of failing, and `cosineSimilarity` returns null — never 0 —
 * whenever it cannot compare, because a 0 would actively demote a memory.
 */

afterEach(() => {
  // The resolved provider is cached per process; leave it as found.
  setEmbeddingProviderForTests(null);
  delete process.env.BRAIN_EMBEDDING_PROVIDER;
});

const vec = (...values: number[]): EmbeddingVector => Float32Array.from(values);

describe("NullEmbeddingProvider", () => {
  it("reports itself unavailable rather than pretending", async () => {
    const provider = new NullEmbeddingProvider();
    await expect(provider.available()).resolves.toBe(false);
  });

  it("refuses to embed instead of returning a fake vector", async () => {
    // A stand-in vector (random projection, feature hashing) would make retrieval
    // look intelligent while ranking by noise. Failing loudly is the point.
    const provider: EmbeddingProvider = new NullEmbeddingProvider();
    await expect(provider.embed(["anything"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("declares a zero width, so no vector column can accidentally match it", () => {
    const provider = new NullEmbeddingProvider();
    expect(provider.dimensions).toBe(0);
    expect(provider.model).toBe("none");
  });
});

describe("resolveEmbeddingProvider", () => {
  it("defaults to the null provider when nothing is configured", () => {
    setEmbeddingProviderForTests(null);
    expect(resolveEmbeddingProvider()).toBeInstanceOf(NullEmbeddingProvider);
  });

  it("falls back to the null provider on an unknown name instead of throwing", () => {
    // A typo in an env var must degrade retrieval, never take the Brain down.
    setEmbeddingProviderForTests(null);
    process.env.BRAIN_EMBEDDING_PROVIDER = "definitely-not-a-provider";
    expect(resolveEmbeddingProvider()).toBeInstanceOf(NullEmbeddingProvider);
  });

  it("caches, so one process cannot mix two vector spaces", () => {
    setEmbeddingProviderForTests(null);
    const first = resolveEmbeddingProvider();
    process.env.BRAIN_EMBEDDING_PROVIDER = "something-else";
    expect(resolveEmbeddingProvider()).toBe(first);
  });
});

describe("embeddingsAvailable", () => {
  it("is false with no provider configured", async () => {
    setEmbeddingProviderForTests(null);
    await expect(embeddingsAvailable()).resolves.toBe(false);
  });

  it("is true for a provider that reports ready", async () => {
    const stub: EmbeddingProvider = {
      model: "stub-v1",
      dimensions: 3,
      available: async () => true,
      embed: async (texts) => texts.map(() => vec(1, 0, 0)),
    };
    setEmbeddingProviderForTests(stub);
    await expect(embeddingsAvailable()).resolves.toBe(true);
  });

  it("swallows a probe that throws rather than propagating it into retrieval", async () => {
    setEmbeddingProviderForTests({
      model: "broken",
      dimensions: 3,
      available: async () => {
        throw new Error("onnxruntime not installed");
      },
      embed: async () => [],
    });
    await expect(embeddingsAvailable()).resolves.toBe(false);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for a vector against itself", () => {
    expect(cosineSimilarity(vec(1, 2, 3), vec(1, 2, 3))).toBeCloseTo(1, 6);
  });

  it("is 0 for orthogonal vectors and -1 for opposites", () => {
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1, 6);
  });

  it("ignores magnitude: direction is all that matters", () => {
    expect(cosineSimilarity(vec(1, 1), vec(10, 10))).toBeCloseTo(1, 6);
  });

  it("returns null — not 0 — for mismatched widths", () => {
    // 0 would read as "opposite meaning" and push the memory down the ranking; null
    // means "this leg did not vote".
    expect(cosineSimilarity(vec(1, 2, 3), vec(1, 2))).toBeNull();
  });

  it("returns null for an empty vector", () => {
    expect(cosineSimilarity(vec(), vec())).toBeNull();
  });

  it("returns null when either side has zero magnitude", () => {
    expect(cosineSimilarity(vec(0, 0, 0), vec(1, 2, 3))).toBeNull();
    expect(cosineSimilarity(vec(1, 2, 3), vec(0, 0, 0))).toBeNull();
  });

  it("stays inside [-1, 1] despite floating-point drift", () => {
    const a = vec(0.1, 0.2, 0.3, 0.4);
    const value = cosineSimilarity(a, a);
    expect(value).not.toBeNull();
    expect(value!).toBeLessThanOrEqual(1);
    expect(value!).toBeGreaterThanOrEqual(-1);
  });

  it("is symmetric", () => {
    const a = vec(0.3, -0.7, 0.1);
    const b = vec(-0.2, 0.5, 0.9);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a)!, 12);
  });
});

describe("embeddingInput", () => {
  it("joins title, summary and content so indexing and querying cannot disagree", () => {
    expect(
      embeddingInput({ title: "Deploy target", summary: "Vercel", content: "We deploy on Vercel." })
    ).toBe("Deploy target\n\nVercel\n\nWe deploy on Vercel.");
  });

  it("drops a missing or blank summary without leaving an empty block", () => {
    expect(embeddingInput({ title: "T", content: "C" })).toBe("T\n\nC");
    expect(embeddingInput({ title: "T", summary: "   ", content: "C" })).toBe("T\n\nC");
    expect(embeddingInput({ title: "T", summary: null, content: "C" })).toBe("T\n\nC");
  });

  it("trims each part, so whitespace churn cannot change the vector", () => {
    expect(embeddingInput({ title: "  T  ", summary: " S ", content: "\nC\n" })).toBe("T\n\nS\n\nC");
  });

  it("is deterministic for the same memory", () => {
    const memory = { title: "T", summary: "S", content: "C" };
    expect(embeddingInput(memory)).toBe(embeddingInput({ ...memory }));
  });
});
