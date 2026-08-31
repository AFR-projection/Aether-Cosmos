import { STOP_WORDS } from "@brain/domain/graph/relate";
import type { BrainEntityType } from "@brain/domain/constants";

/**
 * Deterministic entity extraction.
 *
 * Every entity this module reports is backed by a literal span of the memory that
 * produced it, so the graph can always answer "why is this node here?" with a
 * quote rather than a shrug. There is no model, no sampling and no randomness:
 * the same text yields byte-identical output on every run, which is what makes
 * re-enrichment idempotent and the graph auditable.
 *
 * ## Rules, in descending trust
 *
 * 1. **Known entity** — the name or an alias of an entity that already exists in
 *    this brain. The user (or an earlier extraction) already vouched for it.
 * 2. **Lexicon** — a curated vocabulary of technologies and products, each with a
 *    declared type. Small and explicit; it never guesses a type.
 * 3. **Alias definition** — the text itself defines the alias, as in
 *    "Model Context Protocol (MCP)". The parenthesis *is* the evidence.
 * 4. **Proper-noun phrase** — two or more consecutive capitalized words.
 * 5. **Acronym** — a short all-caps run.
 * 6. **Proper noun** — a single capitalized word, accepted only when it also
 *    appears capitalized away from a sentence boundary. Without that check every
 *    sentence's first word becomes an entity.
 *
 * ## What it deliberately will not do
 *
 * It will not invent aliases ("Cloudflare R2" never spawns a bare "R2" unless the
 * text writes it), will not infer a type it has no rule for (unclassified nodes
 * are `other`, not a guess), and will not extract from title-cased headings where
 * capitalization carries no signal. A missing entity is recoverable; a fabricated
 * one silently corrupts every graph query built on top of it.
 */

/** Recorded in `brain_entities.extracted_by` and `memory_mentions.extracted_by`. */
export const EXTRACTOR_VERSION = "deterministic-v1";

export type ExtractionField = "title" | "summary" | "content";

export type ExtractedMention = {
  field: ExtractionField;
  /** The literal matched text, kept verbatim. */
  surface: string;
  startOffset: number;
  endOffset: number;
};

export type ExtractedEntity = {
  /** Canonical display name — the longest surface form observed. */
  name: string;
  type: BrainEntityType;
  /** Only aliases the text itself defined. Never generated. */
  aliases: string[];
  confidence: number;
  /** Which rule fired, e.g. `known`, `lexicon`, `proper-noun-phrase`. */
  rule: string;
  mentions: ExtractedMention[];
};

export type KnownEntity = {
  name: string;
  type: BrainEntityType;
  aliases?: string[] | null;
};

export type ExtractionInput = {
  title: string;
  summary?: string | null;
  content: string;
  /** Entities already curated in this brain. The strongest available signal. */
  known?: readonly KnownEntity[];
};

export type ExtractionResult = {
  entities: ExtractedEntity[];
  extractedBy: string;
  /** Candidates rejected by the filters. Surfaced so tuning is measurable. */
  dropped: number;
};

/** Per-rule confidence. Fixed constants, so a node's score is explainable. */
export const EXTRACTION_CONFIDENCE = {
  known: 1,
  lexicon: 0.9,
  aliasDefinition: 0.85,
  properNounPhrase: 0.7,
  acronym: 0.6,
  properNoun: 0.55,
} as const;

/** Below this a candidate is not worth a graph node. */
export const EXTRACTION_MIN_CONFIDENCE = 0.55;
/** Hard caps: enrichment must stay bounded regardless of memory size. */
export const MAX_ENTITIES_PER_MEMORY = 24;
export const MAX_MENTIONS_PER_ENTITY = 12;
/** Collection ceiling per candidate, so a pathological document stays bounded. */
const MENTION_COLLECT_CAP = 64;
const MIN_NAME_CHARS = 2;
const MAX_NAME_CHARS = 80;
const MAX_PHRASE_WORDS = 5;
/** Scanning cost ceiling. Content is bounded upstream; this bounds us too. */
const MAX_FIELD_CHARS = 20_000;
/**
 * A title where this share of words is capitalized is treated as title-cased, and
 * capitalization stops being evidence there.
 */
const TITLE_CASE_RATIO = 0.6;
/**
 * The same guard for prose fields, deliberately far stricter. Ordinary Indonesian
 * or English prose that names two or three things per sentence can easily reach
 * 0.6; only a body that is *entirely* capitalized carries no signal.
 */
const PROSE_TITLE_CASE_RATIO = 0.9;

/**
 * Curated vocabulary. Additive by design: an unknown technology simply falls
 * through to the proper-noun rules as `other` rather than being mistyped.
 */
const LEXICON: ReadonlyArray<readonly [string, BrainEntityType]> = [
  ["PostgreSQL", "technology"], ["Postgres", "technology"], ["pgvector", "technology"],
  ["Redis", "technology"], ["BullMQ", "technology"], ["Docker", "technology"],
  ["Kubernetes", "technology"], ["Next.js", "technology"], ["React", "technology"],
  ["TypeScript", "technology"], ["JavaScript", "technology"], ["Node.js", "technology"],
  ["Drizzle ORM", "technology"], ["Drizzle", "technology"], ["Vitest", "technology"],
  ["Tailwind CSS", "technology"], ["Tiptap", "technology"], ["SQLite", "technology"],
  ["MySQL", "technology"], ["MongoDB", "technology"], ["Nginx", "technology"],
  ["Cloudflare R2", "product"], ["Cloudflare", "organization"],
  ["Amazon S3", "product"], ["AWS", "organization"], ["Vercel", "organization"],
  ["GitHub", "organization"], ["GitLab", "organization"], ["Anthropic", "organization"],
  ["OpenAI", "organization"], ["Claude", "product"], ["Obsidian", "product"],
  ["Model Context Protocol", "technology"], ["MCP", "technology"],
  ["Second Brain", "concept"], ["Aether Cosmos ByAFR", "product"],
  ["Aether Cosmos", "product"],
];

/** Words that mark the next proper noun as a person. */
const PERSON_TITLES = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam",
  "pak", "bapak", "bpk", "bu", "ibu", "mas", "mbak", "kak", "om", "tante",
]);

/** Suffixes and prefixes that mark a proper noun as an organization. */
const ORG_SUFFIXES = new Set([
  "inc", "ltd", "llc", "llp", "corp", "corporation", "gmbh", "bv", "ab", "sa",
  "tbk", "foundation", "group", "holdings", "labs", "studio", "studios",
]);
const ORG_PREFIXES = new Set(["pt", "cv", "ud"]);

/**
 * All-caps runs that are emphasis or markup, not acronyms. The user writes
 * emphatic Indonesian in caps ("JANGAN", "PENTING"), which would otherwise become
 * entity nodes.
 */
const ACRONYM_BLOCKLIST = new Set([
  "OK", "TODO", "FIXME", "NOTE", "WARNING", "ERROR", "DEBUG", "INFO", "NULL",
  "TRUE", "FALSE", "AND", "OR", "NOT", "THE", "YES", "NO",
  "JANGAN", "HARUS", "PENTING", "WAJIB", "SEMUA", "TIDAK", "BUKAN", "TETAP",
]);

const WORD_CHAR = /[\p{L}\p{N}]/u;
/** Inner characters that keep "Next.js", "O'Brien" and "snake_case" whole. */
const WORD_INNER = /[\p{L}\p{N}.&'’_-]/u;
const SENTENCE_BREAK = new Set([".", "!", "?", "\n", "\r", ";", ":", "•", "|"]);

type Word = {
  text: string;
  start: number;
  end: number;
  /** True when nothing but a sentence boundary precedes this word. */
  sentenceStart: boolean;
};

type Candidate = {
  key: string;
  name: string;
  type: BrainEntityType;
  aliases: Set<string>;
  confidence: number;
  rule: string;
  mentions: ExtractedMention[];
};

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function isCapitalized(word: string): boolean {
  const first = word[0];
  if (first === undefined) return false;
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

function isAcronym(word: string): boolean {
  return /^[A-Z][A-Z0-9]{1,5}$/.test(word);
}

/** Tokenize into words with byte offsets and sentence-boundary flags. */
function splitWords(text: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  let sentenceStart = true;

  while (i < text.length) {
    const ch = text[i];
    if (WORD_CHAR.test(ch)) {
      let j = i + 1;
      while (j < text.length && WORD_INNER.test(text[j])) j += 1;
      // Give back trailing punctuation so "Redis." yields "Redis" and the period
      // is still seen as a sentence break on the next pass.
      let end = j;
      while (end > i && !WORD_CHAR.test(text[end - 1])) end -= 1;
      out.push({ text: text.slice(i, end), start: i, end, sentenceStart });
      sentenceStart = false;
      i = end;
      continue;
    }
    if (SENTENCE_BREAK.has(ch)) sentenceStart = true;
    i += 1;
  }
  return out;
}

/**
 * True when capitalization in this field carries no information — a title-cased
 * heading. Lexicon and known-entity matching still run; the capitalization-based
 * rules are skipped.
 *
 * The threshold differs by field on purpose. Titles are routinely title-cased, so
 * a modest ratio is enough. Prose is not: applying the same threshold to content
 * would silence extraction on any short paragraph that happens to mention two
 * names, which is exactly the paragraph worth extracting from.
 */
function isTitleCased(words: readonly Word[], ratio: number): boolean {
  const cased = words.filter((word) => /\p{L}/u.test(word.text));
  if (cased.length < 3) return false;
  const caps = cased.filter((word) => isCapitalized(word.text)).length;
  return caps / cased.length >= ratio;
}

/** Every whole-word, case-insensitive occurrence of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  const hay = haystack.toLowerCase();
  const target = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(target, from);
    if (at < 0) return found;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + target.length])) {
      found.push(at);
    }
    from = at + 1;
  }
}

function addCandidate(
  into: Map<string, Candidate>,
  params: {
    name: string;
    type: BrainEntityType;
    confidence: number;
    rule: string;
    aliases?: readonly string[];
    mention: ExtractedMention;
  }
): void {
  const name = params.name.trim().replace(/\s+/g, " ");
  const key = normalizeName(name);
  if (!key) return;

  let candidate = into.get(key);
  if (!candidate) {
    candidate = {
      key,
      name,
      type: params.type,
      aliases: new Set<string>(),
      confidence: params.confidence,
      rule: params.rule,
      mentions: [],
    };
    into.set(key, candidate);
  } else if (params.confidence > candidate.confidence) {
    candidate.confidence = params.confidence;
    candidate.rule = params.rule;
    // A concrete type from a more trusted rule wins; `other` never overwrites one.
    if (params.type !== "other") candidate.type = params.type;
  } else if (candidate.type === "other" && params.type !== "other") {
    candidate.type = params.type;
  }

  if (name.length > candidate.name.length) candidate.name = name;
  for (const alias of params.aliases ?? []) {
    const trimmed = alias.trim();
    if (trimmed && normalizeName(trimmed) !== key) candidate.aliases.add(trimmed);
  }

  const duplicate = candidate.mentions.some(
    (mention) =>
      mention.field === params.mention.field &&
      mention.startOffset === params.mention.startOffset
  );
  if (!duplicate && candidate.mentions.length < MENTION_COLLECT_CAP) {
    candidate.mentions.push(params.mention);
  }
}

/**
 * One searchable term. `term` is what we look for, `name` is the canonical node it
 * belongs to — matching the alias "MCP" must not create a second node next to
 * "Model Context Protocol".
 */
type VocabEntry = {
  term: string;
  name: string;
  type: BrainEntityType;
  rule: string;
  confidence: number;
  aliases?: readonly string[];
};

/** Rules 1 + 2: exact whole-word matches against vocabularies with declared types. */
function matchVocabulary(
  into: Map<string, Candidate>,
  field: ExtractionField,
  text: string,
  vocabulary: readonly VocabEntry[]
): void {
  for (const entry of vocabulary) {
    for (const at of occurrences(text, entry.term)) {
      addCandidate(into, {
        name: entry.name,
        type: entry.type,
        confidence: entry.confidence,
        rule: entry.rule,
        aliases: entry.aliases,
        mention: {
          field,
          surface: text.slice(at, at + entry.term.length),
          startOffset: at,
          endOffset: at + entry.term.length,
        },
      });
    }
  }
}

/**
 * Rule 3: "Model Context Protocol (MCP)". The parenthesis is the evidence for the
 * alias, so the alias is recorded rather than invented.
 */
const ALIAS_DEFINITION =
  /(\p{Lu}[\p{L}\p{N}.&'’-]*(?:[ ]\p{Lu}[\p{L}\p{N}.&'’-]*){1,4})[ ]*\([ ]*(\p{Lu}[\p{L}\p{N}.-]{1,11})[ ]*\)/gu;

function matchAliasDefinitions(
  into: Map<string, Candidate>,
  field: ExtractionField,
  text: string
): void {
  ALIAS_DEFINITION.lastIndex = 0;
  for (;;) {
    const match = ALIAS_DEFINITION.exec(text);
    if (!match) break;
    const [, name, alias] = match;
    addCandidate(into, {
      name,
      type: "other",
      confidence: EXTRACTION_CONFIDENCE.aliasDefinition,
      rule: "alias-definition",
      aliases: [alias],
      mention: {
        field,
        surface: name,
        startOffset: match.index,
        endOffset: match.index + name.length,
      },
    });
  }
}

type Run = { words: Word[]; firstIndex: number; start: number; end: number };

/** Maximal spans of consecutive capitalized words separated by a single space. */
function properNounRuns(words: readonly Word[], text: string): Run[] {
  const runs: Run[] = [];
  let current: Word[] = [];
  let firstIndex = 0;

  const flush = () => {
    if (current.length > 0) {
      runs.push({
        words: current,
        firstIndex,
        start: current[0].start,
        end: current[current.length - 1].end,
      });
      current = [];
    }
  };

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!isCapitalized(word.text)) {
      flush();
      continue;
    }
    if (current.length > 0 && text.slice(current[current.length - 1].end, word.start) !== " ") {
      flush();
    }
    if (current.length === 0) firstIndex = i;
    current.push(word);
  }
  flush();
  return runs;
}

function bare(word: string): string {
  return word.toLowerCase().replace(/[.]/g, "");
}

/**
 * Type for a proper-noun run, from surrounding evidence only. No evidence means
 * `other` — never a guess.
 */
function inferRunType(run: Run, words: readonly Word[]): BrainEntityType {
  const previous = words[run.firstIndex - 1];
  if (previous && PERSON_TITLES.has(bare(previous.text))) return "person";

  const first = bare(run.words[0].text);
  if (ORG_PREFIXES.has(first)) return "organization";

  const last = bare(run.words[run.words.length - 1].text);
  if (ORG_SUFFIXES.has(last)) return "organization";

  const next = words[run.firstIndex + run.words.length];
  if (next && ORG_SUFFIXES.has(bare(next.text))) return "organization";

  return "other";
}

const FIELD_ORDER: Record<ExtractionField, number> = { title: 0, summary: 1, content: 2 };

/**
 * When two candidates claim overlapping text, the longer span wins.
 *
 * This is what keeps "Cloudflare R2" from also producing a bare "Cloudflare" node
 * for the same three words. Longest-first is deterministic: ties break on
 * confidence, then field order, then offset, then name.
 *
 * Confidence has to outrank the name comparison. When a known-entity alias and the
 * lexicon claim the identical span — "MCP" resolving to the brain's own
 * `Model Context Protocol` node — alphabetical order would hand the span to the
 * lexicon and leave the canonical node with no evidence at all, so the brain would
 * grow a second node for something it already knows.
 */
function resolveOverlaps(candidates: Candidate[]): void {
  type Claim = { candidate: Candidate; mention: ExtractedMention };
  const claims: Claim[] = [];
  for (const candidate of candidates) {
    for (const mention of candidate.mentions) claims.push({ candidate, mention });
  }

  claims.sort((a, b) => {
    const lengthA = a.mention.endOffset - a.mention.startOffset;
    const lengthB = b.mention.endOffset - b.mention.startOffset;
    if (lengthA !== lengthB) return lengthB - lengthA;
    if (a.candidate.confidence !== b.candidate.confidence) {
      return b.candidate.confidence - a.candidate.confidence;
    }
    if (a.mention.field !== b.mention.field) {
      return FIELD_ORDER[a.mention.field] - FIELD_ORDER[b.mention.field];
    }
    if (a.mention.startOffset !== b.mention.startOffset) {
      return a.mention.startOffset - b.mention.startOffset;
    }
    return a.candidate.key.localeCompare(b.candidate.key);
  });

  const kept = new Map<ExtractionField, ExtractedMention[]>();
  const survivors = new Map<Candidate, ExtractedMention[]>();

  for (const claim of claims) {
    const field = claim.mention.field;
    const existing = kept.get(field) ?? [];
    const collides = existing.some(
      (other) =>
        claim.mention.startOffset < other.endOffset &&
        other.startOffset < claim.mention.endOffset
    );
    if (collides) continue;
    existing.push(claim.mention);
    kept.set(field, existing);
    const list = survivors.get(claim.candidate) ?? [];
    list.push(claim.mention);
    survivors.set(claim.candidate, list);
  }

  for (const candidate of candidates) {
    candidate.mentions = (survivors.get(candidate) ?? []).sort(
      (a, b) =>
        FIELD_ORDER[a.field] - FIELD_ORDER[b.field] || a.startOffset - b.startOffset
    );
  }
}

/** Names that are grammar rather than knowledge. */
function isNoise(candidate: Candidate): boolean {
  if (candidate.name.length < MIN_NAME_CHARS) return true;
  if (candidate.name.length > MAX_NAME_CHARS) return true;
  if (!/\p{L}/u.test(candidate.name)) return true;
  const parts = candidate.key.split(" ");
  return parts.every((part) => STOP_WORDS.has(part));
}

function buildVocabulary(known: readonly KnownEntity[] | undefined): VocabEntry[] {
  const vocabulary: VocabEntry[] = [];

  for (const entity of known ?? []) {
    const name = entity.name?.trim();
    if (!name) continue;
    vocabulary.push({
      term: name,
      name,
      type: entity.type,
      rule: "known",
      confidence: EXTRACTION_CONFIDENCE.known,
    });
    for (const alias of entity.aliases ?? []) {
      const trimmed = alias?.trim();
      if (!trimmed) continue;
      vocabulary.push({
        term: trimmed,
        name,
        type: entity.type,
        rule: "known-alias",
        confidence: EXTRACTION_CONFIDENCE.known,
        aliases: [trimmed],
      });
    }
  }

  for (const [term, type] of LEXICON) {
    vocabulary.push({
      term,
      name: term,
      type,
      rule: "lexicon",
      confidence: EXTRACTION_CONFIDENCE.lexicon,
    });
  }

  // Longest term first so "Cloudflare R2" is claimed before "Cloudflare".
  return vocabulary.sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
}

/**
 * Extract entities and their evidence spans from one memory.
 *
 * Pure and total: it never throws, never touches the database, and returns the
 * same result for the same input. Callers persist the mentions alongside the
 * entities so every edge stays traceable.
 */
export function extractEntities(input: ExtractionInput): ExtractionResult {
  const fields: Array<[ExtractionField, string]> = [
    ["title", (input.title ?? "").slice(0, MAX_FIELD_CHARS)],
    ["summary", (input.summary ?? "").slice(0, MAX_FIELD_CHARS)],
    ["content", (input.content ?? "").slice(0, MAX_FIELD_CHARS)],
  ];

  const vocabulary = buildVocabulary(input.known);
  const wordsByField = new Map<ExtractionField, Word[]>();

  // A single capitalized word only counts when it also appears capitalized away
  // from a sentence boundary somewhere in this memory.
  const confirmedCaps = new Set<string>();
  for (const [field, text] of fields) {
    const words = splitWords(text);
    wordsByField.set(field, words);
    for (const word of words) {
      if (!word.sentenceStart && isCapitalized(word.text)) {
        confirmedCaps.add(word.text.toLowerCase());
      }
    }
  }

  const candidates = new Map<string, Candidate>();

  for (const [field, text] of fields) {
    if (!text) continue;
    const words = wordsByField.get(field) ?? [];

    matchVocabulary(candidates, field, text, vocabulary);
    matchAliasDefinitions(candidates, field, text);

    for (const word of words) {
      if (!isAcronym(word.text) || ACRONYM_BLOCKLIST.has(word.text)) continue;
      addCandidate(candidates, {
        name: word.text,
        type: "other",
        confidence: EXTRACTION_CONFIDENCE.acronym,
        rule: "acronym",
        mention: {
          field,
          surface: word.text,
          startOffset: word.start,
          endOffset: word.end,
        },
      });
    }

    // Capitalization is meaningless in a title-cased heading.
    const ratio = field === "title" ? TITLE_CASE_RATIO : PROSE_TITLE_CASE_RATIO;
    if (isTitleCased(words, ratio)) continue;

    for (const run of properNounRuns(words, text)) {
      const count = run.words.length;
      if (count > MAX_PHRASE_WORDS) continue;

      let runWords = run.words;
      let type = inferRunType(run, words);
      // "Pak Andi" names Andi; the honorific is a form of address, not part of
      // the name, so it is stripped and used purely as the type signal.
      if (runWords.length > 1 && PERSON_TITLES.has(bare(runWords[0].text))) {
        runWords = runWords.slice(1);
        type = "person";
      }

      const start = runWords[0].start;
      const end = runWords[runWords.length - 1].end;
      const surface = text.slice(start, end);
      if (runWords.length === 1) {
        const word = runWords[0];
        if (word.sentenceStart && !confirmedCaps.has(word.text.toLowerCase())) continue;
        if (isAcronym(word.text)) continue; // already handled, with a better score
      }

      addCandidate(candidates, {
        name: surface,
        type,
        confidence:
          runWords.length > 1
            ? EXTRACTION_CONFIDENCE.properNounPhrase
            : EXTRACTION_CONFIDENCE.properNoun,
        rule: runWords.length > 1 ? "proper-noun-phrase" : "proper-noun",
        mention: { field, surface, startOffset: start, endOffset: end },
      });
    }
  }

  const collected = [...candidates.values()];
  resolveOverlaps(collected);

  const kept = collected.filter(
    (candidate) =>
      candidate.mentions.length > 0 &&
      candidate.confidence >= EXTRACTION_MIN_CONFIDENCE &&
      !isNoise(candidate)
  );

  kept.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.mentions.length - a.mentions.length ||
      a.key.localeCompare(b.key)
  );

  const entities = kept.slice(0, MAX_ENTITIES_PER_MEMORY).map((candidate) => ({
    name: candidate.name,
    type: candidate.type,
    aliases: [...candidate.aliases].sort((a, b) => a.localeCompare(b)),
    confidence: candidate.confidence,
    rule: candidate.rule,
    mentions: candidate.mentions.slice(0, MAX_MENTIONS_PER_ENTITY),
  }));

  return {
    entities,
    extractedBy: EXTRACTOR_VERSION,
    dropped: collected.length - entities.length,
  };
}







