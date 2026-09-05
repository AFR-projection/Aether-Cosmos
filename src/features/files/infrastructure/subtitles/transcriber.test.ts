import { describe, it, expect, vi } from "vitest";
import {
  OpenAiCompatibleTranscriber,
  SubtitleTranscriptionError,
} from "@files/infrastructure/subtitles/transcriber";

/**
 * The transcription client, tested against a stubbed `fetch` — no network, no key, no bill.
 *
 * Two groups of tests matter more than the rest. The first is the request shape: this is an
 * OpenAI-compatible endpoint, which is the whole reason the base URL is configurable, and every
 * field checked below is one a provider will silently ignore rather than reject if it is spelled
 * wrong — `response_format` most of all, since without `verbose_json` the reply has no timings
 * and the feature has nothing to work with.
 *
 * The second is hallucination filtering. Whisper reports its own confidence per segment, and it
 * invents text over silence and falls into repetition loops in ways those numbers describe. The
 * thresholds used here are Whisper's own decoder defaults, not values picked by taste, and
 * applying them is the difference between a transcript and a transcript with "Thank you for
 * watching" pasted over every quiet scene.
 */

const segment = (over: Partial<Record<string, unknown>> = {}) => ({
  start: 1,
  end: 3,
  text: " Hello",
  avg_logprob: -0.2,
  no_speech_prob: 0.01,
  compression_ratio: 1.5,
  ...over,
});

function stubFetch(body: unknown, init?: { status?: number; text?: string; headers?: HeadersInit }) {
  return vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(init?.text ?? JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      })
  );
}

type StubFetch = ReturnType<typeof stubFetch>;

const audio = () => new Uint8Array([1, 2, 3, 4]);

function make(fetchImpl: StubFetch, over?: Partial<{ apiKey: string; baseUrl: string; model: string }>) {
  return new OpenAiCompatibleTranscriber({
    apiKey: over?.apiKey ?? "sk-test",
    baseUrl: over?.baseUrl ?? "https://api.groq.com/openai/v1",
    model: over?.model ?? "whisper-large-v3-turbo",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

/** The URL and options of the one call the stub received. */
function callOf(fetchImpl: StubFetch): { url: string; init: RequestInit } {
  const [url, init] = fetchImpl.mock.calls[0];
  return { url, init };
}

const authOf = (fetchImpl: StubFetch) =>
  (callOf(fetchImpl).init.headers as Record<string, string>).Authorization;

/** The multipart fields, with binary parts collapsed to a marker. */
function partsOf(fetchImpl: StubFetch): Map<string, string> {
  const body = callOf(fetchImpl).init.body as FormData;
  const out = new Map<string, string>();
  for (const [key, value] of body.entries()) {
    out.set(key, typeof value === "string" ? value : "<binary>");
  }
  return out;
}

describe("OpenAiCompatibleTranscriber request", () => {
  it("posts to the transcriptions path of whatever base URL it was given", async () => {
    const fetchImpl = stubFetch({ language: "english", segments: [segment()] });
    await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "chunk.ogg",
      mimeType: "audio/ogg",
    });
    expect(callOf(fetchImpl).url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(callOf(fetchImpl).init.method).toBe("POST");
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    const fetchImpl = stubFetch({ language: "english", segments: [segment()] });
    await make(fetchImpl, {
      baseUrl: "https://api.openai.com/v1/",
    }).transcribe({ audio: audio(), fileName: "c.ogg", mimeType: "audio/ogg" });
    expect(callOf(fetchImpl).url).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("sends the key as a bearer token and nothing else identifying", async () => {
    const fetchImpl = stubFetch({ language: "english", segments: [segment()] });
    await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(authOf(fetchImpl)).toBe("Bearer sk-test");
  });

  it("asks for the verbose form, which is the only one that carries timings", async () => {
    const fetchImpl = stubFetch({ language: "english", segments: [segment()] });
    await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    const parts = partsOf(fetchImpl);
    expect(parts.get("response_format")).toBe("verbose_json");
    expect(parts.get("model")).toBe("whisper-large-v3-turbo");
    expect(parts.get("temperature")).toBe("0");
    expect(parts.get("file")).toBe("<binary>");
  });

  it("sends a language hint when one is known", async () => {
    const fetchImpl = stubFetch({ language: "japanese", segments: [segment()] });
    await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
      language: "ja",
    });
    expect(partsOf(fetchImpl).get("language")).toBe("ja");
  });

  it("omits the language entirely for auto-detection", async () => {
    const fetchImpl = stubFetch({ language: "japanese", segments: [segment()] });
    await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
      language: null,
    });
    expect(partsOf(fetchImpl).has("language")).toBe(false);
  });

  it("carries the tail of the previous chunk, so names stay spelled the same across a cut", async () => {
    const fetchImpl = stubFetch({ language: "japanese", segments: [segment()] });
    await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
      prompt: "…前のチャンクの終わり",
    });
    expect(partsOf(fetchImpl).get("prompt")).toBe("…前のチャンクの終わり");
  });
});

describe("OpenAiCompatibleTranscriber result", () => {
  it("turns segments into cues measured in milliseconds", async () => {
    const fetchImpl = stubFetch({
      language: "english",
      segments: [segment({ start: 1.25, end: 3.5, text: " Hello there" })],
    });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues).toEqual([{ idx: 0, startMs: 1_250, endMs: 3_500, text: "Hello there" }]);
  });

  it("resolves the language name the provider reports into a tag", async () => {
    const fetchImpl = stubFetch({ language: "japanese", segments: [segment()] });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.language).toBe("ja");
  });

  it("reports no language rather than a code nothing understands", async () => {
    const fetchImpl = stubFetch({ language: "klingon", segments: [segment()] });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.language).toBeNull();
  });

  it("reports the duration the provider measured", async () => {
    const fetchImpl = stubFetch({ language: "english", duration: 600.02, segments: [segment()] });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.durationSeconds).toBe(600.02);
  });

  it("drops a segment the model itself says is silence", async () => {
    // Whisper's own rule: high no-speech probability AND low average log-probability.
    const fetchImpl = stubFetch({
      language: "english",
      segments: [
        segment({ text: " Real speech" }),
        segment({ start: 5, end: 35, text: " Thank you for watching", no_speech_prob: 0.9, avg_logprob: -1.4 }),
      ],
    });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues.map((cue) => cue.text)).toEqual(["Real speech"]);
  });

  it("keeps a confident segment even when the no-speech probability is high", async () => {
    // One signal on its own is not enough — quiet speech trips it constantly.
    const fetchImpl = stubFetch({
      language: "english",
      segments: [segment({ no_speech_prob: 0.9, avg_logprob: -0.2 })],
    });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues).toHaveLength(1);
  });

  it("drops a segment that is a repetition loop", async () => {
    const fetchImpl = stubFetch({
      language: "english",
      segments: [segment(), segment({ start: 4, end: 9, text: " ha ha ha ha ha ha", compression_ratio: 3.1 })],
    });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues).toHaveLength(1);
  });

  it("drops a segment with no text and one whose times make no sense", async () => {
    const fetchImpl = stubFetch({
      language: "english",
      segments: [
        segment({ text: "   " }),
        segment({ start: Number.NaN }),
        segment({ start: 10, end: 12, text: " kept" }),
      ],
    });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues.map((cue) => cue.text)).toEqual(["kept"]);
  });

  it("renumbers the cues it kept, so the indices stay contiguous", async () => {
    const fetchImpl = stubFetch({
      language: "english",
      segments: [segment({ text: "   " }), segment({ start: 4, end: 5, text: " a" }), segment({ start: 6, end: 7, text: " b" })],
    });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues.map((cue) => cue.idx)).toEqual([0, 1]);
  });

  it("returns an empty transcript for a chunk that was genuinely silent", async () => {
    const fetchImpl = stubFetch({ language: "english", segments: [] });
    const result = await make(fetchImpl).transcribe({
      audio: audio(),
      fileName: "c.ogg",
      mimeType: "audio/ogg",
    });
    expect(result.cues).toEqual([]);
  });
});

describe("OpenAiCompatibleTranscriber failures", () => {
  it("refuses to call anything without a key", async () => {
    const fetchImpl = stubFetch({});
    await expect(
      make(fetchImpl, { apiKey: "  " }).transcribe({
        audio: audio(),
        fileName: "c.ogg",
        mimeType: "audio/ogg",
      })
    ).rejects.toBeInstanceOf(SubtitleTranscriptionError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries the HTTP status, so the worker can tell a rate limit from a bad key", async () => {
    const fetchImpl = stubFetch({ error: { message: "Rate limit reached" } }, { status: 429 });
    const error = await make(fetchImpl)
      .transcribe({ audio: audio(), fileName: "c.ogg", mimeType: "audio/ogg" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubtitleTranscriptionError);
    expect((error as SubtitleTranscriptionError).status).toBe(429);
    expect((error as SubtitleTranscriptionError).message).toContain("Rate limit reached");
  });

  it("reads how long the provider asked us to wait", async () => {
    const fetchImpl = stubFetch({}, { status: 429, headers: { "retry-after": "12" } });
    const error = await make(fetchImpl)
      .transcribe({ audio: audio(), fileName: "c.ogg", mimeType: "audio/ogg" })
      .catch((e: unknown) => e);
    expect((error as SubtitleTranscriptionError).retryAfterMs).toBe(12_000);
  });

  it("says so plainly when the reply is not JSON", async () => {
    const fetchImpl = stubFetch(null, { text: "<html>gateway timeout</html>" });
    await expect(
      make(fetchImpl).transcribe({
        audio: audio(),
        fileName: "c.ogg",
        mimeType: "audio/ogg",
      })
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("refuses a reply with no segments, since text without timings is unusable", async () => {
    const fetchImpl = stubFetch({ language: "english", text: "Hello there" });
    await expect(
      make(fetchImpl).transcribe({
        audio: audio(),
        fileName: "c.ogg",
        mimeType: "audio/ogg",
      })
    ).rejects.toThrow(/timings|segments/i);
  });

  it("turns a network failure into a sentence an operator can act on", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      make(fetchImpl).transcribe({
        audio: audio(),
        fileName: "c.ogg",
        mimeType: "audio/ogg",
      })
    ).rejects.toThrow(/outbound network|could not reach/i);
  });

  it("gives up rather than hanging when the provider stops responding", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })
    );
    const transcriber = new OpenAiCompatibleTranscriber({
      apiKey: "sk-test",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transcriber.transcribe({ audio: audio(), fileName: "c.ogg", mimeType: "audio/ogg" })
    ).rejects.toThrow(/timed out/i);
  });
});

describe("OpenAiCompatibleTranscriber.available", () => {
  it("is a key check and never a network call", async () => {
    const fetchImpl = stubFetch({});
    await expect(make(fetchImpl).available()).resolves.toBe(true);
    await expect(
      make(fetchImpl, { apiKey: "" }).available()
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
