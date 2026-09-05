import { describe, it, expect, vi } from "vitest";
import { translateCues } from "@files/application/subtitles/translate-cues";

/**
 * The translation policy: glossary first, then batches, then retry, then line by line.
 *
 * Everything here is about what happens when a model does not cooperate, because that is the
 * whole reason this layer exists. A model that returns 39 translations for 40 lines has not made
 * a small mistake — it has silently shifted every remaining line of the film onto the wrong
 * timing. So a reply that does not match is never patched up: the batch is retried, and if the
 * retry also fails the lines go one at a time, where a mismatch is impossible by construction.
 *
 * The client is injected as a plain `complete` function. No network, no key, and the failure modes
 * are producible on demand — which is the only way to test a retry ladder honestly.
 */

const cue = (idx: number, text = `source ${idx}`) => ({
  idx,
  startMs: idx * 2_000,
  endMs: idx * 2_000 + 1_500,
  text,
});

const track = (count: number) => Array.from({ length: count }, (_, i) => cue(i));

/** The numbered lines a batch payload asks about. */
function linesOf(payload: string): { n: number; text: string }[] {
  const section = payload.split("TRANSLATE THESE")[1] ?? "";
  return [...section.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
}

/**
 * A cooperative model: returns a glossary once, then echoes every line with a prefix.
 *
 * `onBatch` lets a test break one specific batch without having to reimplement the whole fake.
 */
function fakeModel(options?: {
  glossary?: string;
  onBatch?: (call: number, lines: { n: number; text: string }[]) => string | null;
}) {
  let batchCalls = 0;
  return vi.fn(async ({ user }: { system: string; user: string }) => {
    if (!user.includes("TRANSLATE THESE")) {
      return options?.glossary ?? '[{"term":"source","translation":"sumber"}]';
    }
    batchCalls += 1;
    const lines = linesOf(user);
    const override = options?.onBatch?.(batchCalls, lines);
    if (override !== null && override !== undefined) return override;
    return JSON.stringify(lines.map((line) => ({ n: line.n, text: `id:${line.text}` })));
  });
}

const base = { sourceLanguage: "Japanese", targetLanguage: "Indonesian" };

describe("translateCues", () => {
  it("translates every line and leaves the timings untouched", async () => {
    const source = track(3);
    const result = await translateCues({ ...base, cues: source, complete: fakeModel() });
    expect(result.cues).toEqual([
      { idx: 0, startMs: 0, endMs: 1_500, text: "id:source 0" },
      { idx: 1, startMs: 2_000, endMs: 3_500, text: "id:source 1" },
      { idx: 2, startMs: 4_000, endMs: 5_500, text: "id:source 2" },
    ]);
  });

  it("settles the glossary before translating anything, and pins it into every batch", async () => {
    const complete = fakeModel();
    const result = await translateCues({
      ...base,
      cues: track(50),
      complete,
      batchSize: 10,
    });
    expect(result.glossary).toEqual([{ term: "source", translation: "sumber" }]);
    // First call is the glossary; every call after it carries the decision.
    expect(complete.mock.calls[0][0].user).not.toContain("TRANSLATE THESE");
    for (const call of complete.mock.calls.slice(1)) {
      expect(call[0].system).toContain("source → sumber");
    }
  });

  it("carries on without a glossary when that call fails outright", async () => {
    let first = true;
    const inner = fakeModel();
    const complete = vi.fn(async (input: { system: string; user: string }) => {
      if (first && !input.user.includes("TRANSLATE THESE")) {
        first = false;
        throw new Error("provider hiccup");
      }
      return inner(input);
    });
    const result = await translateCues({ ...base, cues: track(2), complete });
    expect(result.glossary).toEqual([]);
    expect(result.cues.map((c) => c.text)).toEqual(["id:source 0", "id:source 1"]);
  });

  it("carries on without a glossary when the reply is not usable", async () => {
    const result = await translateCues({
      ...base,
      cues: track(2),
      complete: fakeModel({ glossary: "I could not identify any terms." }),
    });
    expect(result.glossary).toEqual([]);
    expect(result.cues).toHaveLength(2);
  });

  it("retries a batch whose reply did not line up, and says so more firmly", async () => {
    const complete = fakeModel({
      // First attempt merges two lines into one, which is the failure that breaks sync.
      onBatch: (call, lines) =>
        call === 1 ? JSON.stringify(lines.slice(1).map((l) => ({ n: l.n - 1, text: "merged" }))) : null,
    });
    const result = await translateCues({ ...base, cues: track(3), complete, batchSize: 3 });
    expect(result.cues.map((c) => c.text)).toEqual(["id:source 0", "id:source 1", "id:source 2"]);
    expect(result.degradedBatches).toBe(0);
    // The retry says something the first attempt did not.
    const retry = complete.mock.calls[2][0];
    expect(retry.system).toMatch(/exactly 3/i);
  });

  it("falls back to one line at a time when the retry fails too", async () => {
    const complete = fakeModel({
      onBatch: (call, lines) =>
        // Both batch attempts are wrong; a single-line request is right.
        lines.length > 1 ? JSON.stringify([{ n: 1, text: "collapsed" }]) : null,
    });
    const result = await translateCues({ ...base, cues: track(3), complete, batchSize: 3 });
    expect(result.cues.map((c) => c.text)).toEqual(["id:source 0", "id:source 1", "id:source 2"]);
    expect(result.degradedBatches).toBe(1);
  });

  it("keeps the source text for a line nothing could translate", async () => {
    const result = await translateCues({
      ...base,
      cues: track(2),
      batchSize: 2,
      complete: fakeModel({ onBatch: () => "sorry, I cannot help with that" }),
    });
    expect(result.cues.map((c) => c.text)).toEqual(["source 0", "source 1"]);
    expect(result.untranslatedLines).toBe(2);
    expect(result.degradedBatches).toBe(1);
  });

  it("reports progress that ends at the end", async () => {
    const seen: number[] = [];
    await translateCues({
      ...base,
      cues: track(30),
      batchSize: 10,
      complete: fakeModel(),
      onProgress: (fraction) => {
        seen.push(fraction);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    for (const fraction of seen) {
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it("propagates a provider failure instead of quietly producing the source text", async () => {
    // A rate limit or a dead key is not something to degrade around: the caller has to know,
    // so the job can be retried rather than a whole track saved untranslated.
    const complete = vi.fn(async ({ user }: { system: string; user: string }) => {
      if (user.includes("TRANSLATE THESE")) throw new Error("HTTP 429");
      return "[]";
    });
    await expect(
      translateCues({ ...base, cues: track(2), complete })
    ).rejects.toThrow("HTTP 429");
  });

  it("restores a line break the payload had to flatten", async () => {
    const complete = vi.fn(async ({ user }: { system: string; user: string }) => {
      if (!user.includes("TRANSLATE THESE")) return "[]";
      expect(user).toContain("- Siapa? / - Aku.");
      return JSON.stringify([{ n: 1, text: "- Who? / - Me." }]);
    });
    const result = await translateCues({
      ...base,
      cues: [cue(0, "- Siapa?\n- Aku.")],
      complete,
    });
    expect(result.cues[0].text).toBe("- Who?\n- Me.");
  });

  it("does nothing at all for an empty track", async () => {
    const complete = fakeModel();
    const result = await translateCues({ ...base, cues: [], complete });
    expect(result).toEqual({ cues: [], glossary: [], degradedBatches: 0, untranslatedLines: 0 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("copes with an unknown source language", async () => {
    const result = await translateCues({
      cues: track(1),
      sourceLanguage: null,
      targetLanguage: "Indonesian",
      complete: fakeModel(),
    });
    expect(result.cues[0].text).toBe("id:source 0");
  });
});
