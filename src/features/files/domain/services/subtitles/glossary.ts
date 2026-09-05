/**
 * Deciding a film's proper nouns once, before translating any of it.
 *
 * Subtitles are translated forty lines at a time, and a batch has no memory of the batches
 * before it. Left alone, that means every batch independently decides how to render a
 * character's name, a place, or a piece of invented terminology — so the same person is spelled
 * three different ways over two hours. That inconsistency is the loudest tell of machine
 * subtitles, louder than any individual mistranslation, because a reader can follow an awkward
 * sentence and cannot follow a character whose name keeps changing.
 *
 * So there is a pass before the passes: a sample of the transcript goes to the model once, it
 * decides the terms, and every batch afterwards is handed the answer.
 *
 * **The sample spans the whole film.** Not its opening. A name introduced in the third act is
 * exactly as much of a consistency problem as one from the first scene, and a sample taken from
 * the front would never see it. Sampling is by stride rather than by slice for that reason, and
 * `glossary.test.ts` pins it.
 *
 * Nothing here calls a model. These are the strings sent and the parser for what comes back;
 * the call lives in `../../../infrastructure/subtitles/translator.ts`.
 */

/** How much transcript the glossary pass reads. A few thousand characters is enough to see the
 *  recurring names and cheap enough to spend on a pass that produces no subtitles of its own. */
export const GLOSSARY_SAMPLE_CHARS = 6_000;

/**
 * Most terms worth pinning.
 *
 * The glossary is repeated into the system prompt of EVERY batch, so its length is paid once per
 * batch rather than once per film. A hundred-odd terms covers a cast and its vocabulary; beyond
 * that the list stops being a glossary and starts being a second transcript.
 */
export const MAX_GLOSSARY_ENTRIES = 120;

/** One term whose rendering is settled for the whole film. */
export type GlossaryEntry = {
  readonly term: string;
  readonly translation: string;
};

type TimedText = { readonly text: string };

/**
 * A representative sample of the transcript, in speaking order and inside `maxChars`.
 *
 * Cues are taken at a stride computed from the average line length, which is what makes the
 * sample span the film instead of its first few minutes. A transcript that already fits is sent
 * whole. A single line longer than the entire budget is truncated rather than dropped — a very
 * long cue is usually a wall of on-screen text, and the first `maxChars` of it still carry names.
 */
export function buildGlossarySample(
  cues: readonly TimedText[],
  maxChars: number = GLOSSARY_SAMPLE_CHARS
): string {
  const texts = cues.map((cue) => cue.text.trim()).filter((text) => text.length > 0);
  if (texts.length === 0) return "";

  const joined = texts.join("\n");
  if (joined.length <= maxChars) return joined;

  const average = Math.max(1, Math.round(joined.length / texts.length));
  const target = Math.max(1, Math.floor(maxChars / (average + 1)));
  const stride = Math.max(1, Math.floor(texts.length / target));

  const picked: string[] = [];
  let used = 0;
  for (let index = 0; index < texts.length; index += stride) {
    const line = texts[index];
    const cost = picked.length === 0 ? line.length : line.length + 1;
    if (used + cost > maxChars) {
      // Nothing has fitted yet, so the first line is longer than the whole budget.
      if (picked.length === 0) return line.slice(0, maxChars);
      break;
    }
    picked.push(line);
    used += cost;
  }
  return picked.join("\n");
}

/**
 * What to ask the model for, given a sample.
 *
 * The instruction to leave a name alone when the target language would normally keep it is the
 * one clause that matters most in practice: a translator asked for "the Indonesian for 竈門炭治郎"
 * will happily invent one, and a subtitle that renames the protagonist is worse than a subtitle
 * that transliterates him.
 */
export function buildGlossaryPrompt(input: {
  sourceLanguage: string | null;
  targetLanguage: string;
}): string {
  const from = input.sourceLanguage ?? "the language of the transcript";
  return [
    `You are preparing to subtitle a video from ${from} into ${input.targetLanguage}.`,
    "",
    "From the transcript excerpts below, list the terms whose rendering must stay identical",
    "everywhere they appear: character and person names, place names, organisations, titles,",
    "and invented or technical vocabulary specific to this work.",
    "",
    "Rules:",
    `- Give the ${input.targetLanguage} rendering you want used every time.`,
    "- Transliterate a personal name rather than translating its meaning, and keep it in its",
    "  original script when that is what readers of the target language would expect.",
    "- Include a term only if it recurs or would be ambiguous on its own.",
    "- Do not include ordinary words, greetings, or numbers.",
    "",
    'Reply with JSON only: [{"term":"…","translation":"…"}]. An empty array is a valid answer.',
  ].join("\n");
}

/**
 * The first JSON value in a model's reply.
 *
 * Models fence their JSON, preface it with a sentence, or both, however firmly they were asked
 * not to. Parsing the whole reply first and only then looking for a bracketed span keeps the
 * common case exact and the messy case recoverable.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to span extraction
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

/** The array inside whatever shape the model chose to wrap it in. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

/**
 * A glossary from the model's reply, or an empty one.
 *
 * Never throws and never propagates a partial term: an entry missing either side of itself would
 * pin a name to nothing, and a glossary is only useful if every line in it is an instruction.
 * The first spelling of a repeated term wins, so the list stays a function.
 */
export function parseGlossaryReply(raw: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();

  for (const item of asArray(extractJson(raw))) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const term = typeof record.term === "string" ? record.term.trim() : "";
    const translation = typeof record.translation === "string" ? record.translation.trim() : "";
    if (term.length === 0 || translation.length === 0) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    entries.push({ term, translation });
    if (entries.length >= MAX_GLOSSARY_ENTRIES) break;
  }

  return entries;
}

/** The glossary as the lines that go into every batch's system prompt. */
export function formatGlossary(entries: readonly GlossaryEntry[]): string {
  return entries.map((entry) => `${entry.term} → ${entry.translation}`).join("\n");
}
