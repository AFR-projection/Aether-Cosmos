import { normalizeLanguageTag } from "@files/domain/services/subtitles/languages";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";

/**
 * Speech recognition over one audio chunk, against an OpenAI-compatible endpoint.
 *
 * The endpoint shape is the product decision this class encodes: `/audio/transcriptions` with a
 * multipart body is implemented by Groq, OpenAI, and several others, so one adapter plus a
 * configurable base URL covers all of them and the operator picks on price. Groq's
 * `whisper-large-v3-turbo` is the default because it is the cheapest per audio hour by a wide
 * margin and loses very little accuracy against the full model.
 *
 * Structured like `@brain/infrastructure/providers/openrouter.ts` on purpose — a class holding
 * only what one request needs, an injectable `fetchImpl` so the tests never touch a network, and
 * its own error type carrying an admin-safe message. Configuration lives in `./config.ts`;
 * deciding whether to use it at all lives in the worker.
 *
 * **The hallucination filter is not a nicety.** Whisper invents plausible speech over silence —
 * "Thank you for watching", a channel sign-off, whatever the training data had in quiet moments —
 * and falls into loops repeating one phrase. It also reports, per segment, exactly the numbers
 * that describe both failures. The thresholds applied below are Whisper's own decoder defaults
 * rather than values chosen by taste:
 *
 *   - `no_speech_prob > 0.6` **together with** `avg_logprob < -1.0` is upstream's rule for
 *     treating a segment as silence. Either signal alone fires constantly on quiet dialogue,
 *     which is why both are required.
 *   - `compression_ratio > 2.4` is upstream's repetition-loop detector: text that compresses
 *     that well is text that repeats itself.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

/** Both signals must fire before a segment is treated as invented. See the note above. */
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1.0;
const COMPRESSION_RATIO_THRESHOLD = 2.4;

/** A network, HTTP, or shape failure from the transcription call. Message is admin-safe. */
export class SubtitleTranscriptionError extends Error {
  readonly status?: number;
  /** How long the provider asked us to wait, when it said. Drives the worker's backoff. */
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "SubtitleTranscriptionError";
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export type TranscriberOptions = {
  apiKey: string;
  /** Everything before `/audio/transcriptions`. A trailing slash is tolerated. */
  baseUrl: string;
  model: string;
  /**
   * Ten minutes of audio takes a few seconds on Groq and can take a minute elsewhere, so this is
   * generous by default — a timeout that fires early wastes the upload as well as the request.
   */
  timeoutMs?: number;
  /** Overridable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export type TranscriptionInput = {
  audio: Uint8Array;
  /** Sent as the part's filename. The provider reads the container from its extension. */
  fileName: string;
  mimeType: string;
  /** BCP-47 hint, or `null`/omitted to let the provider detect it. */
  language?: string | null;
  /**
   * Text the model should assume immediately precedes this audio.
   *
   * Whisper conditions on it, which is what carries a character's name spelling across a chunk
   * boundary instead of letting the next chunk re-romanise it from scratch.
   */
  prompt?: string;
};

export type TranscriptionResult = {
  /** A tag from `languages.ts`, or `null` when the reported language could not be placed. */
  language: string | null;
  /** As the provider measured it. `null` when it did not say. */
  durationSeconds: number | null;
  /** Chunk-relative, in milliseconds, renumbered over what survived the filter. */
  cues: SubtitleCue[];
};

type VerboseSegment = {
  start?: unknown;
  end?: unknown;
  text?: unknown;
  avg_logprob?: unknown;
  no_speech_prob?: unknown;
  compression_ratio?: unknown;
};

type VerboseResponse = {
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
  error?: { message?: string };
};

/**
 * A number, or `null` for anything that is not one.
 *
 * Deliberately not `Number(value)`: that maps `null` to `0` and `""` to `0`, so a provider that
 * omitted a segment's `start` — or that serialised a missing value as JSON `null` — would place
 * that cue at the beginning of the chunk instead of being rejected. A timestamp that is absent
 * and a timestamp that is zero are different facts.
 */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Whether a segment is the model talking to itself.
 *
 * Absent confidence fields are treated as confident: some OpenAI-compatible providers omit them,
 * and dropping every segment because a provider is terse would be worse than keeping a
 * hallucination.
 */
function isHallucinated(segment: VerboseSegment): boolean {
  const compression = num(segment.compression_ratio);
  if (compression !== null && compression > COMPRESSION_RATIO_THRESHOLD) return true;

  const noSpeech = num(segment.no_speech_prob);
  const logprob = num(segment.avg_logprob);
  if (noSpeech === null || logprob === null) return false;
  return noSpeech > NO_SPEECH_THRESHOLD && logprob < LOGPROB_THRESHOLD;
}

/** Turn a fetch/abort failure into a short sentence an operator can act on. */
function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The transcription request timed out";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return "Could not reach the transcription provider — check the server's outbound network access";
  }
  return message.slice(0, 300);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

export class OpenAiCompatibleTranscriber {
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TranscriberOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Cheap and never-throwing: a key must be present. No network call. */
  async available(): Promise<boolean> {
    return this.apiKey.trim().length > 0;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (this.apiKey.trim().length === 0) {
      throw new SubtitleTranscriptionError("No transcription API key is configured");
    }

    const form = new FormData();
    // A fresh view over the same bytes: Blob wants an ArrayBuffer, and slicing here avoids
    // handing it a buffer that may be a window onto a larger pool.
    form.append(
      "file",
      new Blob([input.audio.slice().buffer as ArrayBuffer], { type: input.mimeType }),
      input.fileName
    );
    form.append("model", this.model);
    // Without this the reply is plain text and the feature has no timings to work with.
    form.append("response_format", "verbose_json");
    // Deterministic: a subtitle track that changes between two runs of the same file is a
    // support conversation nobody can win.
    form.append("temperature", "0");
    form.append("timestamp_granularities[]", "segment");
    if (input.language) form.append("language", input.language);
    if (input.prompt && input.prompt.trim().length > 0) form.append("prompt", input.prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        // Content-Type is deliberately NOT set: fetch has to add the multipart boundary itself.
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      throw new SubtitleTranscriptionError(friendlyError(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as VerboseResponse;
        detail = body?.error?.message ?? "";
      } catch {
        // A provider that fails with HTML has nothing to quote.
      }
      throw new SubtitleTranscriptionError(
        `Transcription failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        { status: response.status, retryAfterMs: retryAfterMs(response) }
      );
    }

    let json: VerboseResponse;
    try {
      json = (await response.json()) as VerboseResponse;
    } catch {
      throw new SubtitleTranscriptionError(
        "The transcription provider returned a response that was not valid JSON"
      );
    }
    if (json.error) {
      throw new SubtitleTranscriptionError(
        `Transcription failed: ${json.error.message ?? "unknown error"}`
      );
    }
    if (!Array.isArray(json.segments)) {
      throw new SubtitleTranscriptionError(
        "The transcription provider returned no segments, so the transcript has no timings — " +
          "check that the configured model supports verbose_json"
      );
    }

    const cues: SubtitleCue[] = [];
    for (const raw of json.segments as VerboseSegment[]) {
      if (!raw || typeof raw !== "object") continue;
      const startSeconds = num(raw.start);
      const endSeconds = num(raw.end);
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (startSeconds === null || endSeconds === null || text.length === 0) continue;
      if (isHallucinated(raw)) continue;
      cues.push({
        idx: cues.length,
        startMs: Math.round(startSeconds * 1000),
        endMs: Math.round(endSeconds * 1000),
        text,
      });
    }

    return {
      language: typeof json.language === "string" ? normalizeLanguageTag(json.language) : null,
      durationSeconds: num(json.duration),
      cues,
    };
  }
}
