/**
 * The protocol for translating a subtitle track in batches.
 *
 * One failure mode dominates everything else here: a model that merges two subtitle lines into
 * one, or splits one into two, shifts every line after it onto the wrong timing. A clumsy word
 * choice is a local flaw a viewer reads past; a line count that does not match is the rest of the
 * film out of sync. So {@link parseTranslationReply} matches the reply one-to-one against the
 * batch it answered and refuses anything else — refusing is what triggers the retry, and a
 * best-effort merge is exactly the thing that must never happen.
 *
 * Batches carry their neighbours as read-only context for the opposite reason. A sentence that
 * runs across a cue boundary — which is most sentences, since cues are cut on pauses rather than
 * on grammar — is unreadable when each half is translated without the other. The payload
 * therefore has two kinds of line and labels them differently, and the model is told plainly
 * which kind it is being asked to produce.
 *
 * Nothing here calls a model. The strings are built and parsed here; the call lives in
 * `../../../infrastructure/subtitles/translator.ts`.
 */

import { formatGlossary, type GlossaryEntry } from "./glossary";
import type { SubtitleCue } from "./vtt";

/**
 * Lines per request.
 *
 * Big enough that a feature-length film is tens of requests rather than hundreds, small enough
 * that a model reliably returns the same number of lines it was given — which is the constraint
 * that actually sets this number. Past roughly fifty, count mismatches start appearing.
 */
export const TRANSLATE_BATCH_CUES = 40;

/** Neighbouring lines sent for context on each side of a batch. */
export const TRANSLATE_CONTEXT_CUES = 3;

/**
 * How a line break inside a cue is written when the cue is flattened onto one numbered line.
 *
 * Two-speaker dialogue is the case that matters: `- A` / `- B` is two utterances, and a model
 * shown them joined by a space translates them as one.
 */
const BREAK_SEPARATOR = " / ";

/** One request's worth of work, plus the lines either side of it. */
export type TranslationBatch = {
  /** The lines to translate, in order. Numbered from 1 in the payload. */
  readonly cues: readonly SubtitleCue[];
  /** Lines immediately preceding, for context only. */
  readonly before: readonly SubtitleCue[];
  /** Lines immediately following, for context only. */
  readonly after: readonly SubtitleCue[];
  /** Position of this batch's first line in the whole track, for progress reporting. */
  readonly offset: number;
};

/**
 * A track split into batches, each knowing its neighbours.
 *
 * Context is drawn from the full track rather than from the previous batch's *translation*, so
 * batches remain independent: one failed request is one retry, not a broken chain.
 */
export function planTranslationBatches(
  cues: readonly SubtitleCue[],
  options?: { size?: number; context?: number }
): TranslationBatch[] {
  const size = Math.max(1, Math.round(options?.size ?? TRANSLATE_BATCH_CUES));
  const context = Math.max(0, Math.round(options?.context ?? TRANSLATE_CONTEXT_CUES));

  const batches: TranslationBatch[] = [];
  for (let offset = 0; offset < cues.length; offset += size) {
    const end = Math.min(offset + size, cues.length);
    batches.push({
      cues: cues.slice(offset, end),
      before: cues.slice(Math.max(0, offset - context), offset),
      after: cues.slice(end, Math.min(cues.length, end + context)),
      offset,
    });
  }
  return batches;
}

/** A cue's text on one line, with any internal break shown as a separator. */
export function flattenCueBreaks(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(BREAK_SEPARATOR);
}

/**
 * The separator turned back into a real break.
 *
 * A translation that already came back with a line break keeps it. A legitimate " / " inside
 * dialogue becomes a break it did not ask for, which is a cosmetic cost accepted knowingly: the
 * alternative is losing every speaker change, and a spurious break reads as a style choice while
 * a lost one reads as a mistranslation.
 */
export function unflattenCueBreaks(text: string): string {
  return text.split(BREAK_SEPARATOR).map((part) => part.trim()).join("\n");
}

/**
 * The standing instructions for every batch of one track.
 *
 * Built once per track and reused, which is why the glossary lives in the system prompt rather
 * than the payload: with prompt caching on the provider's side, an unchanging prefix is the
 * cheap half of every request.
 */
export function buildTranslationSystemPrompt(input: {
  sourceLanguage: string | null;
  targetLanguage: string;
  glossary: readonly GlossaryEntry[];
}): string {
  const from = input.sourceLanguage ?? "the language of the source lines";
  const lines = [
    `You are a professional subtitler translating from ${from} into ${input.targetLanguage}.`,
    "",
    "Rules, in order of importance:",
    "1. Return exactly one translation per numbered line. Never merge two lines into one and",
    "   never split one line into two — the timings are fixed and a different count puts the",
    "   rest of the film out of sync.",
    `2. Write natural, idiomatic ${input.targetLanguage} as a viewer would read it, not a`,
    "   word-for-word gloss. Keep it short: this is text on screen, not prose.",
    "3. Keep the register of the original — casual speech stays casual, formal stays formal.",
    "4. Preserve a leading dash and the ` / ` separator: they mark who is speaking.",
    "5. Leave song lyrics, on-screen signs and untranslatable interjections as they are rather",
    "   than inventing content for them.",
    "6. Translate the numbered lines only. The surrounding lines are there so you can see the",
    "   sentence they belong to.",
  ];

  const glossary = formatGlossary(input.glossary);
  if (glossary.length > 0) {
    lines.push(
      "",
      "Glossary — use these renderings every single time, without variation:",
      glossary
    );
  }

  lines.push(
    "",
    'Reply with JSON only, no commentary: [{"n":1,"text":"…"},{"n":2,"text":"…"}]'
  );
  return lines.join("\n");
}

/**
 * One batch as the text of a request.
 *
 * The context sections are omitted entirely when empty rather than sent as empty headings: a
 * heading with nothing under it invites a model to fill it in.
 */
export function buildBatchPayload(batch: TranslationBatch): string {
  const sections: string[] = [];

  if (batch.before.length > 0) {
    sections.push(
      "PRECEDING LINES (context — do not translate):",
      batch.before.map((cue) => `… ${flattenCueBreaks(cue.text)}`).join("\n"),
      ""
    );
  }

  sections.push(
    `TRANSLATE THESE ${batch.cues.length} LINES:`,
    batch.cues.map((cue, index) => `${index + 1}. ${flattenCueBreaks(cue.text)}`).join("\n")
  );

  if (batch.after.length > 0) {
    sections.push(
      "",
      "FOLLOWING LINES (context — do not translate):",
      batch.after.map((cue) => `… ${flattenCueBreaks(cue.text)}`).join("\n")
    );
  }

  sections.push("", `Return exactly ${batch.cues.length} numbered translations.`);
  return sections.join("\n");
}

/** The first JSON value in a reply, however the model decided to wrap it. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // try the other bracket shape
      }
    }
  }
  return null;
}

function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The batch's translations in the batch's order, or `null`.
 *
 * `null` is not an error to log and move past — it is the signal to retry the batch, and after
 * that to fall back to translating its lines one at a time. Every refusal below is a case where
 * accepting the reply would put text against the wrong timing:
 *
 *  - a different number of lines than were sent,
 *  - a line number missing, repeated, or outside the batch,
 *  - a line that came back blank, which would show as a gap where speech is.
 *
 * A bare array of strings is accepted when its length matches exactly. It carries no numbering to
 * check, so it is only trusted on that one condition.
 */
export function parseTranslationReply(raw: string, expected: number): string[] | null {
  if (expected === 0) return [];

  const items = asArray(extractJson(raw));
  if (!items || items.length !== expected) return null;

  // The unnumbered shape: only usable because the length already matched.
  if (items.every((item) => typeof item === "string")) {
    const texts = (items as string[]).map((text) => text.trim());
    return texts.every((text) => text.length > 0) ? texts : null;
  }

  const byNumber = new Map<number, string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const n = typeof record.n === "number" ? record.n : Number(record.n);
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!Number.isInteger(n) || n < 1 || n > expected) return null;
    if (byNumber.has(n)) return null;
    if (text.length === 0) return null;
    byNumber.set(n, text);
  }

  if (byNumber.size !== expected) return null;
  return Array.from({ length: expected }, (_, index) => byNumber.get(index + 1)!);
}
