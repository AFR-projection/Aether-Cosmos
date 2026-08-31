import { EmbeddingUnavailableError, type EmbeddingProvider, type EmbeddingVector } from "./provider";

/**
 * OpenRouter embedding provider (Second Brain 2.0, P9).
 *
 * Unlike the local-only contract the abstraction was first written for, this provider
 * deliberately calls an external API: memory text and queries are sent to OpenRouter to
 * be embedded. That is a tradeoff the operator opted into by configuring a key in
 * /brain/settings; `provider.data_collection = "deny"` asks OpenRouter not to retain the
 * content.
 *
 * The request NEVER pins `dimensions`: every OpenRouter model has its own native width
 * (voyage-code-4 rejects 1536 outright — its widths are 256/512/1024/2048), so sending a
 * fixed value breaks most models. Instead each model's native width is used as-is and
 * auto-detected at the settings "Test"/Save step. An optional `dimensions` here is a
 * *validation* width, not a request field: when set, a returned vector of a different
 * width is rejected (the model silently changed); when null (auto) the first returned
 * width is locked in for the batch so a batch can never mix widths.
 *
 * The provider holds only what a single request needs — an API key, a model name and an
 * optional expected width. Configuration (loading + decrypting the key, the cache) lives
 * in `config.ts`; choosing between this and the null provider lives in `resolve.ts`. This
 * class does exactly one thing: turn text into validated vectors, or fail cleanly.
 */

export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_TIMEOUT_MS = 20_000;

/** A network/HTTP/shape failure from the OpenRouter embeddings call. Message is admin-safe. */
export class OpenRouterEmbeddingError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenRouterEmbeddingError";
    this.status = status;
  }
}

type OpenRouterEmbeddingResponse = {
  data?: { embedding?: number[]; index?: number }[];
  error?: { message?: string; code?: string | number };
};

export type OpenRouterProviderOptions = {
  apiKey: string;
  model: string;
  /**
   * Expected returned width to validate against. `null`/omitted = auto: accept whatever
   * width the model emits, locking the batch to the first vector's width. NEVER sent to
   * the API. A stored value (from Test/Save auto-detection) guards against a model
   * silently changing its output width.
   */
  dimensions?: number | null;
  timeoutMs?: number;
  /** Overridable for tests. Defaults to the real endpoint. */
  endpoint?: string;
  /** Overridable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number | null;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenRouterProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimensions = opts.dimensions ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.endpoint = opts.endpoint ?? OPENROUTER_EMBEDDINGS_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Cheap and never-throwing: a key must be present. No network call. */
  async available(): Promise<boolean> {
    return this.apiKey.trim().length > 0;
  }

  async embed(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    if (this.apiKey.trim().length === 0) throw new EmbeddingUnavailableError();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          // `dimensions` is deliberately NOT sent: each model has its own native width and
          // several reject an explicit value (voyage-code-4 only allows 256/512/1024/2048).
          encoding_format: "float",
          // Ask OpenRouter (and the upstream provider) not to retain the content.
          provider: { data_collection: "deny" },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new OpenRouterEmbeddingError(friendlyOpenRouterError(err));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw new OpenRouterEmbeddingError(
        `OpenRouter embeddings failed (HTTP ${response.status})${message ? `: ${message}` : ""}`,
        response.status
      );
    }

    let json: OpenRouterEmbeddingResponse;
    try {
      json = (await response.json()) as OpenRouterEmbeddingResponse;
    } catch {
      throw new OpenRouterEmbeddingError("OpenRouter returned a response that was not valid JSON");
    }

    if (json.error) {
      throw new OpenRouterEmbeddingError(`OpenRouter error: ${json.error.message ?? "unknown"}`);
    }
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new OpenRouterEmbeddingError(
        `OpenRouter returned ${Array.isArray(data) ? data.length : 0} embeddings for ${texts.length} inputs`
      );
    }

    // Responses carry an `index`; sort by it so the returned order matches the inputs
    // regardless of how the API ordered them.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const configured = this.dimensions;
    let width: number | null = configured;
    return ordered.map((item, i) => {
      const embedding = item.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new OpenRouterEmbeddingError(
          `Embedding ${i} is empty — the model "${this.model}" returned no vector.`
        );
      }
      // Auto mode: lock onto the first returned width so a single batch can never mix
      // widths (which would corrupt the flexible column).
      if (width == null) width = embedding.length;
      if (embedding.length !== width) {
        throw new OpenRouterEmbeddingError(
          configured != null
            ? `Embedding ${i} has ${embedding.length} dimensions, expected ${configured}. ` +
                `The model "${this.model}" no longer produces ${configured}-d vectors — re-test it in /brain/settings.`
            : `Embedding ${i} has ${embedding.length} dimensions but the batch started at ${width}. ` +
                `The model "${this.model}" returned inconsistent widths.`
        );
      }
      return Float32Array.from(embedding);
    });
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as OpenRouterEmbeddingResponse;
    return body?.error?.message ?? "";
  } catch {
    return "";
  }
}

/** Turn a fetch/abort error into a short, admin-readable string. */
export function friendlyOpenRouterError(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return "OpenRouter request timed out";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) {
    return "Could not reach openrouter.ai — check the server's outbound network access";
  }
  return msg.slice(0, 300);
}
