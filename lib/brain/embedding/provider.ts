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
 * ## Adding a real provider
 *
 * Implement {@link EmbeddingProvider} in `lib/brain/embedding/<name>.ts`, register
 * it in {@link resolveEmbeddingProvider}, and select it with
 * `BRAIN_EMBEDDING_PROVIDER=<name>`. The contract:
 *
 *  - `embed()` must be deterministic for the same input and model version, or
 *    indexing and querying will disagree and retrieval quality will drift;
 *  - inference must be local — no network calls, no per-token cost;
 *  - `available()` must be cheap and must never throw;
 *  - `dimensions` must match the `vector(N)` column the index was built with.
 */

/** A single embedding. Float32 to match pgvector's storage. */
export type EmbeddingVector = Float32Array;

export interface EmbeddingProvider {
  /** Stable identifier persisted next to every vector, e.g. `all-MiniLM-L6-v2`. */
  readonly model: string;
  /** Vector width. Must equal the width of the database column. */
  readonly dimensions: number;
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

/**
 * The configured provider. Cached per process; `BRAIN_EMBEDDING_PROVIDER` is read
 * once because switching models at runtime would silently mix vector spaces.
 *
 * Unknown values fall back to the null provider rather than throwing: a typo in an
 * env var must not take the Brain down.
 */
export function resolveEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;

  const name = (process.env.BRAIN_EMBEDDING_PROVIDER ?? "none").trim().toLowerCase();
  switch (name) {
    // Register local providers here. Nothing is registered yet on purpose: a
    // stand-in that produced pseudo-semantic vectors (random projection, feature
    // hashing) would make retrieval look intelligent while ranking by noise.
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
  cached = provider;
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

