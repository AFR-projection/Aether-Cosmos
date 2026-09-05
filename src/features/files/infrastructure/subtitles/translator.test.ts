import { describe, it, expect, vi } from "vitest";
import {
  ChatCompletionTranslator,
  SubtitleTranslationError,
} from "@files/infrastructure/subtitles/translator";

/**
 * The chat-completions client the translation passes go through.
 *
 * Deliberately dumb: one call is one request, it returns the assistant's text, and it knows
 * nothing about glossaries, batches or retries. All of that is policy, it lives in
 * `@files/application/subtitles/translate-cues.ts`, and keeping it out of here is what makes both
 * halves testable — the policy against a fake `complete`, and this against a fake `fetch`.
 *
 * The one piece of provider-specific behaviour is the privacy flag, and the test below pins the
 * condition rather than the flag: `provider.data_collection` is an OpenRouter field, and sending
 * an unrecognised top-level parameter to OpenAI is a 400. So it goes out only when the configured
 * base URL is actually OpenRouter.
 */

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

const reply = (content: string) => ({ choices: [{ message: { role: "assistant", content } }] });

function make(
  fetchImpl: StubFetch,
  over?: Partial<{ apiKey: string; baseUrl: string; model: string }>
) {
  return new ChatCompletionTranslator({
    apiKey: over?.apiKey ?? "sk-test",
    baseUrl: over?.baseUrl ?? "https://openrouter.ai/api/v1",
    model: over?.model ?? "google/gemini-2.5-flash",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function callOf(fetchImpl: StubFetch): { url: string; init: RequestInit } {
  const [url, init] = fetchImpl.mock.calls[0];
  return { url, init };
}

const authOf = (fetchImpl: StubFetch) =>
  (callOf(fetchImpl).init.headers as Record<string, string>).Authorization;

const bodyOf = (fetchImpl: StubFetch) =>
  JSON.parse(callOf(fetchImpl).init.body as string) as Record<string, unknown> & {
    messages?: unknown;
  };

describe("ChatCompletionTranslator request", () => {
  it("posts to the chat-completions path of whatever base URL it was given", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl).complete({ system: "s", user: "u" });
    expect(callOf(fetchImpl).url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(callOf(fetchImpl).init.method).toBe("POST");
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl, {
      baseUrl: "https://api.openai.com/v1/",
    }).complete({ system: "s", user: "u" });
    expect(callOf(fetchImpl).url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends the key as a bearer token", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl).complete({ system: "s", user: "u" });
    expect(authOf(fetchImpl)).toBe("Bearer sk-test");
  });

  it("sends the two messages in the order a chat model expects", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl).complete({ system: "rules", user: "lines" });
    expect(bodyOf(fetchImpl).messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "lines" },
    ]);
  });

  it("asks for a deterministic answer, so re-running a file gives the same subtitles", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl).complete({ system: "s", user: "u" });
    const body = bodyOf(fetchImpl);
    expect(body.temperature).toBe(0);
    expect(body.model).toBe("google/gemini-2.5-flash");
  });

  it("asks OpenRouter not to retain the dialogue it is being sent", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl).complete({ system: "s", user: "u" });
    expect(bodyOf(fetchImpl).provider).toEqual({ data_collection: "deny" });
  });

  it("leaves that field out for a provider that would reject it", async () => {
    const fetchImpl = stubFetch(reply("done"));
    await make(fetchImpl, {
      baseUrl: "https://api.openai.com/v1",
    }).complete({ system: "s", user: "u" });
    expect(bodyOf(fetchImpl).provider).toBeUndefined();
  });
});

describe("ChatCompletionTranslator result", () => {
  it("returns the assistant's text", async () => {
    const fetchImpl = stubFetch(reply('[{"n":1,"text":"satu"}]'));
    const out = await make(fetchImpl).complete({ system: "s", user: "u" });
    expect(out).toBe('[{"n":1,"text":"satu"}]');
  });

  it("reads content a provider split into parts rather than a bare string", async () => {
    const fetchImpl = stubFetch({
      choices: [{ message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }],
    });
    const out = await make(fetchImpl).complete({ system: "s", user: "u" });
    expect(out).toBe("hello");
  });
});

describe("ChatCompletionTranslator failures", () => {
  it("refuses to call anything without a key", async () => {
    const fetchImpl = stubFetch(reply("x"));
    await expect(
      make(fetchImpl, { apiKey: " " }).complete({ system: "s", user: "u" })
    ).rejects.toBeInstanceOf(SubtitleTranslationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries the HTTP status and the provider's own message", async () => {
    const fetchImpl = stubFetch({ error: { message: "Insufficient credits" } }, { status: 402 });
    const error = await make(fetchImpl)
      .complete({ system: "s", user: "u" })
      .catch((e: unknown) => e);
    expect((error as SubtitleTranslationError).status).toBe(402);
    expect((error as SubtitleTranslationError).message).toContain("Insufficient credits");
  });

  it("reads how long the provider asked us to wait", async () => {
    const fetchImpl = stubFetch({}, { status: 429, headers: { "retry-after": "5" } });
    const error = await make(fetchImpl)
      .complete({ system: "s", user: "u" })
      .catch((e: unknown) => e);
    expect((error as SubtitleTranslationError).retryAfterMs).toBe(5_000);
  });

  it("says so plainly when the reply is not JSON", async () => {
    const fetchImpl = stubFetch(null, { text: "<html>502</html>" });
    await expect(
      make(fetchImpl).complete({ system: "s", user: "u" })
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("refuses a reply with no choices, and one whose message is empty", async () => {
    for (const body of [{ choices: [] }, reply("   "), { choices: [{ message: {} }] }]) {
      const fetchImpl = stubFetch(body);
      await expect(
        make(fetchImpl).complete({ system: "s", user: "u" })
      ).rejects.toThrow(/empty|no reply/i);
    }
  });

  it("surfaces an error the provider put in a 200 body", async () => {
    const fetchImpl = stubFetch({ error: { message: "model unavailable" } });
    await expect(
      make(fetchImpl).complete({ system: "s", user: "u" })
    ).rejects.toThrow(/model unavailable/);
  });

  it("turns a network failure into a sentence an operator can act on", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      make(fetchImpl).complete({ system: "s", user: "u" })
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
    const translator = new ChatCompletionTranslator({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(translator.complete({ system: "s", user: "u" })).rejects.toThrow(/timed out/i);
  });
});

describe("ChatCompletionTranslator.available", () => {
  it("is a key check and never a network call", async () => {
    const fetchImpl = stubFetch(reply("x"));
    await expect(make(fetchImpl).available()).resolves.toBe(true);
    await expect(
      make(fetchImpl, { apiKey: "" }).available()
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
