/**
 * The chat-completions client the translation passes go through.
 *
 * Deliberately dumb: one call is one request, it hands back the assistant's text, and it knows
 * nothing about glossaries, batches, retries or fallbacks. All of that is policy and lives in
 * `@files/application/subtitles/translate-cues.ts` — which is what makes both halves testable,
 * the policy against a fake `complete` and this against a fake `fetch`.
 *
 * Any OpenAI-compatible endpoint works, which is the point: the default is OpenRouter because it
 * reaches the cheap, strong translation models through one key, but pointing this at OpenAI or at
 * the same vendor doing the transcription is a base-URL change.
 *
 * One provider-specific field is sent, and only where it is understood: OpenRouter's
 * `provider.data_collection = "deny"` asks the upstream model host not to retain the dialogue
 * being translated. Sending an unrecognised top-level parameter to OpenAI is a 400, so the flag
 * is gated on the base URL rather than sent hopefully.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/** A network, HTTP, or shape failure from the translation call. Message is admin-safe. */
export class SubtitleTranslationError extends Error {
  readonly status?: number;
  /** How long the provider asked us to wait, when it said. Drives the caller's backoff. */
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "SubtitleTranslationError";
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export type TranslatorOptions = {
  apiKey: string;
  /** Everything before `/chat/completions`. A trailing slash is tolerated. */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Overridable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

type ChatResponse = {
  choices?: { message?: { content?: unknown } }[];
  error?: { message?: string };
};

/** Turn a fetch/abort failure into a short sentence an operator can act on. */
function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The translation request timed out";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return "Could not reach the translation provider — check the server's outbound network access";
  }
  return message.slice(0, 300);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * The message text, whichever shape the provider used.
 *
 * `content` is a string in the original API and an array of typed parts in the newer one; several
 * OpenAI-compatible hosts have moved to the array form, and a client that only understands the
 * string would read those replies as empty.
 */
function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

export class ChatCompletionTranslator {
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly isOpenRouter: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TranslatorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    const base = options.baseUrl.replace(/\/+$/, "");
    this.endpoint = `${base}/chat/completions`;
    this.isOpenRouter = /(^|\/\/)([a-z0-9-]+\.)*openrouter\.ai(\/|$)/i.test(base);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Cheap and never-throwing: a key must be present. No network call. */
  async available(): Promise<boolean> {
    return this.apiKey.trim().length > 0;
  }

  /** One request, one reply. Throws {@link SubtitleTranslationError} for anything unusable. */
  async complete(input: { system: string; user: string }): Promise<string> {
    if (this.apiKey.trim().length === 0) {
      throw new SubtitleTranslationError("No translation API key is configured");
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      // Deterministic: two runs over the same file must produce the same subtitles, or a user
      // who regenerates after a small correction gets a different translation everywhere.
      temperature: 0,
    };
    if (this.isOpenRouter) body.provider = { data_collection: "deny" };

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
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SubtitleTranslationError(friendlyError(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const failed = (await response.json()) as ChatResponse;
        detail = failed?.error?.message ?? "";
      } catch {
        // A provider that fails with HTML has nothing to quote.
      }
      throw new SubtitleTranslationError(
        `Translation failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        { status: response.status, retryAfterMs: retryAfterMs(response) }
      );
    }

    let json: ChatResponse;
    try {
      json = (await response.json()) as ChatResponse;
    } catch {
      throw new SubtitleTranslationError(
        "The translation provider returned a response that was not valid JSON"
      );
    }
    if (json.error) {
      throw new SubtitleTranslationError(
        `Translation failed: ${json.error.message ?? "unknown error"}`
      );
    }

    const text = readContent(json.choices?.[0]?.message?.content).trim();
    if (text.length === 0) {
      throw new SubtitleTranslationError("The translation provider returned an empty reply");
    }
    return text;
  }
}
