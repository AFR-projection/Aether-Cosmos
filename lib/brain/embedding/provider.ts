/**
 * Embedding provider abstraction for the Second Brain.
 *
 * The Brain's core intelligence must work with NO embedding model at all: lexical
 * relevance, entity overlap, graph proximity and temporal signals are always
 * available, and semantic similarity is an optional extra leg. That is a hard
 * constraint, not a phasing decision — the deployment target is a self-hosted VPS
 * where a native ONNX runtime may simply not be installable, and no Brain content
 * may ever be sent to a third-party inference API.
 *
 * So retrieval never imports a model. It asks this module for a provider, and the
 * default provider reports itself unavailable. Everything downstream is written to
 * treat a missing semantic score as "this leg did not vote", never as "similarity
 * is zero" — the difference matters, because a zero would actively push a memory
 * down the ranking.
 *
 * ## Providers
 *
 * Two resolution paths exist:
 *
 *  - the ENV path here ({@link resolveEmbeddingProvider}) registers only the null
 *    provider — no local model ships — and is kept as the test seam;
 *  - the DB-backed path in `resolve.ts` reads the operator's configured provider from
 *    `brain_embedding_settings` and builds the OpenRouter provider from it.
 *
 * The original "inference must be local, no network, no per-token cost" rule has been
 * DELIBERATELY relaxed: the operator can opt into OpenRouter embeddings from
 * /brain/settings, accepting that memory text and queries leave the server. That is a
 * configured choice with a visible cost, not a silent default. The remaining parts of
 * the contract still hold for every provider:
 *
 *  - `embed()` must be deterministic for the same input and model version, or
 *    indexing and querying will disagree and retrieval quality will drift;
 *  - `available()` must be cheap and must never throw, and must not make a network call;
 *  - `dimensions` is the provider's returned width when known, or `null` when it is
 *    auto-detected at runtime; the `vector` column is dimension-flexible, so a provider
 *    is no longer required to match a fixed column width.
 */

/** A single embedding. Float32 to match pgvector's storage. */
export type EmbeddingVector = Float32Array;

export interface EmbeddingProvider {
  /** Stable identifier persisted next to every vector, e.g. `all-MiniLM-L6-v2`. */
  readonly model: string;
  /** Returned vector width when known, or `null` when auto-detected at runtime. */
  readonly dimensions: number | null;
  /** Cheap, never-throwing readiness probe. */
  available(): Promise<boolean>;
  /** Embed a batch. Rejects if the provider is unavailable. */
  embed(texts: string[]): Promise<EmbeddingVector[]>;
}

/**
 * The default. Reports unavailable and refuses to embed, so a deployment with no
 * model configured degrades to lexical + graph retrieval instead of failing.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly model = "none";
  readonly dimensions = 0;

  async available(): Promise<boolean> {
    return false;
  }

  async embed(): Promise<EmbeddingVector[]> {
    throw new EmbeddingUnavailableError();
  }
}

/**
 * Thrown when something asks an unavailable provider to embed. Callers in the
 * write path must swallow this: a memory is never rejected because enrichment
 * could not produce a vector.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message = "No embedding provider is configured") {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

let cached: EmbeddingProvider | null = null;
let testOverride: EmbeddingProvider | null = null;

/**
 * The configured provider. Cached per process; `BRAIN_EMBEDDING_PROVIDER` is read
 * once because switching models at runtime would silently mix vector spaces.
 *
 * A test override (see {@link setEmbeddingProviderForTests}) wins over both the cache
 * and the env, so a test can inject a provider without touching process env.
 *
 * Unknown values fall back to the null provider rather than throwing: a typo in an
 * env var must not take the Brain down.
 */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  if (testOverride) return testOverride;
  if (cached) return cached;

  const name = (process.env.BRAIN_EMBEDDING_PROVIDER ?? "none").trim().toLowerCase();
  switch (name) {
    // Register local providers here. Nothing is registered yet on purpose: a
    // stand-in that produced pseudo-semantic vectors (random projection, feature
    // hashing) would make retrieval look intelligent while ranking by noise. The
    // OpenRouter provider is resolved from the DB in `resolve.ts`, not from env.
    case "none":
    case "":
    default:
      cached = new NullEmbeddingProvider();
      break;
  }
  return cached;
}

/** Test seam: replace the process-wide provider. Pass null to restore resolution. */
export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null): void {
  testOverride = provider;
  // Drop the env cache too, so a subsequent resolve recomputes from a clean slate.
  cached = null;
}

/**
 * The current test override, or null when none is set. `resolve.ts` consults this so a
 * `setEmbeddingProviderForTests` stub also governs the DB-backed resolution path.
 */
export function getTestProviderOverride(): EmbeddingProvider | null {
  return testOverride;
}

/** True when a provider is configured AND ready. Never throws. */
export async function embeddingsAvailable(): Promise<boolean> {
  try {
    return await resolveEmbeddingProvider().available();
  } catch {
    return false;
  }
}

/**
 * Cosine similarity in [-1, 1], or `null` when the inputs are not comparable
 * (different widths, or a zero-magnitude vector). `null` rather than 0 so callers
 * can tell "no opinion" from "opposite meaning".
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number | null {
  if (a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;

  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Guard against floating-point drift pushing us outside the valid range.
  return Math.min(1, Math.max(-1, value));
}

/**
 * The text an embedding is computed from. Kept here so the indexing path and the
 * query path can never disagree about what gets embedded.
 */
export function embeddingInput(memory: {
  title: string;
  summary?: string | null;
  content: string;
}): string {
  const parts = [memory.title, memory.summary ?? "", memory.content];
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

