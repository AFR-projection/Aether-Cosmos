import {
  buildGlossaryPrompt,
  buildGlossarySample,
  parseGlossaryReply,
  type GlossaryEntry,
} from "@files/domain/services/subtitles/glossary";
import {
  buildBatchPayload,
  buildTranslationSystemPrompt,
  parseTranslationReply,
  planTranslationBatches,
  unflattenCueBreaks,
  type TranslationBatch,
} from "@files/domain/services/subtitles/translate-batch";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";

/**
 * Translating a whole track: glossary first, then batches, then retry, then line by line.
 *
 * This is the policy layer, and almost all of it is about a model that does not cooperate. A reply
 * with 39 translations for 40 lines has not made a small mistake — accepting it shifts every
 * remaining line of the film onto the wrong timing, which is a worse outcome than any
 * mistranslation. So a reply that does not match is never patched up. It is retried once with a
 * firmer instruction, and if that fails the batch's lines go one at a time, where a count
 * mismatch is impossible by construction.
 *
 * The ladder, and what each rung costs:
 *
 *   1. **Glossary pass** — one call over a sample of the whole transcript, so a character's name
 *      is rendered the same way in the last act as in the first. A failure here is survivable and
 *      is survived: the glossary becomes empty and translation proceeds without it, because
 *      inconsistent names are much better than no subtitles.
 *   2. **Batch** — forty lines with their neighbours for context. One call per batch.
 *   3. **Retry** — the same batch with the count stated again. One extra call.
 *   4. **Line by line** — one call per line of that batch. Expensive, and it loses the
 *      surrounding context, so it is a last resort and is counted in `degradedBatches`.
 *   5. **Source text** — a line even a single-line request could not translate keeps its original
 *      text and is counted. A visible untranslated line is honest; a missing one looks broken.
 *
 * A `complete` that *throws* is different from a reply that does not parse, and is deliberately
 * not caught: a dead key or a rate limit is not something to degrade around, it is something the
 * job has to fail on so it can be retried. Backoff belongs in the injected `complete`.
 */

/** One call to a chat model. Injected so this whole ladder is testable without a network. */
export type CompleteFn = (input: { system: string; user: string }) => Promise<string>;

export type TranslateCuesResult = {
  /** Same count, same timings, translated text. */
  readonly cues: SubtitleCue[];
  readonly glossary: GlossaryEntry[];
  /** Batches that had to fall back to one line at a time. Worth logging; not a failure. */
  readonly degradedBatches: number;
  /** Lines that kept their source text because nothing could translate them. */
  readonly untranslatedLines: number;
};

export type TranslateCuesInput = {
  cues: readonly SubtitleCue[];
  /** English name of the source language, or `null` to let the model infer it. */
  sourceLanguage: string | null;
  /** English name of the target language. */
  targetLanguage: string;
  complete: CompleteFn;
  /** Called after each batch with a fraction in `(0, 1]`. */
  onProgress?: (fraction: number) => void | Promise<void>;
  batchSize?: number;
  contextCues?: number;
};

/**
 * The glossary, or an empty one.
 *
 * Both failure paths collapse to the same answer on purpose — a provider error and an unparseable
 * reply are equally survivable here, and treating them differently would only add a branch that
 * ends in the same place.
 */
async function resolveGlossary(input: TranslateCuesInput): Promise<GlossaryEntry[]> {
  const sample = buildGlossarySample(input.cues);
  if (sample.length === 0) return [];
  try {
    const reply = await input.complete({
      system: buildGlossaryPrompt({
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
      }),
      user: sample,
    });
    return parseGlossaryReply(reply);
  } catch {
    return [];
  }
}

/** The batch's translations, or `null` if the model's reply could not be matched to it. */
async function attemptBatch(
  complete: CompleteFn,
  system: string,
  batch: TranslationBatch
): Promise<string[] | null> {
  const reply = await complete({ system, user: buildBatchPayload(batch) });
  return parseTranslationReply(reply, batch.cues.length);
}

/**
 * One line, asked for on its own.
 *
 * Numbered `1.` like any other batch so the reply shape never changes — a model that has just
 * failed to keep a count is not the moment to introduce a second output format.
 */
async function translateSingle(
  complete: CompleteFn,
  system: string,
  cue: SubtitleCue
): Promise<string | null> {
  const single: TranslationBatch = { cues: [cue], before: [], after: [], offset: cue.idx };
  const reply = await complete({ system, user: buildBatchPayload(single) });
  const parsed = parseTranslationReply(reply, 1);
  return parsed ? parsed[0] : null;
}

export async function translateCues(input: TranslateCuesInput): Promise<TranslateCuesResult> {
  const { complete, cues } = input;
  if (cues.length === 0) {
    return { cues: [], glossary: [], degradedBatches: 0, untranslatedLines: 0 };
  }

  const glossary = await resolveGlossary(input);
  const system = buildTranslationSystemPrompt({
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    glossary,
  });

  const batches = planTranslationBatches(cues, {
    size: input.batchSize,
    context: input.contextCues,
  });

  const translated: SubtitleCue[] = [];
  let degradedBatches = 0;
  let untranslatedLines = 0;

  for (const [position, batch] of batches.entries()) {
    let texts = await attemptBatch(complete, system, batch);

    if (!texts) {
      // Same batch, same glossary, one sentence more insistent about the count. Restating the
      // constraint is what actually recovers these — a model that lost the count usually keeps
      // it when told the number twice.
      const stricter =
        `${system}\n\nIMPORTANT: the previous attempt returned the wrong number of lines. ` +
        `Return exactly ${batch.cues.length} objects, numbered 1 to ${batch.cues.length}, one per ` +
        `line given. Do not merge or split lines.`;
      texts = await attemptBatch(complete, stricter, batch);
    }

    if (!texts) {
      degradedBatches += 1;
      const oneByOne: string[] = [];
      for (const cue of batch.cues) {
        const single = await translateSingle(complete, system, cue);
        if (single === null) {
          untranslatedLines += 1;
          oneByOne.push(cue.text);
        } else {
          oneByOne.push(single);
        }
      }
      texts = oneByOne;
    }

    const resolved = texts;
    batch.cues.forEach((cue, index) => {
      translated.push({
        idx: cue.idx,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: unflattenCueBreaks(resolved[index]),
      });
    });

    await input.onProgress?.((position + 1) / batches.length);
  }

  return { cues: translated, glossary, degradedBatches, untranslatedLines };
}
