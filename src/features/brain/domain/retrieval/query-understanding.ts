/**
 * Query understanding layer for Second Brain retrieval.
 *
 * Natural language queries are preprocessed before hitting the retrieval legs:
 *   1. Normalize (Unicode, punctuation, case)
 *   2. Filter imperatives and function words
 *   3. Detect phrases (2-3 word collocations)
 *   4. Weight terms (rare words count more)
 *   5. Expand entity aliases
 *
 * Goal: "Check user identity and communication preferences" should extract:
 *   - Content words: ["user", "identity", "communication", "preferences"]
 *   - Phrases: ["user identity", "communication preferences"]
 *   - Intent: ACTION (leading imperative, so the verb is dropped from content words)
 *
 * All pure functions, deterministic, testable.
 */

import { STOP_WORDS } from "@brain/domain/graph/relate";

/** Minimum characters for a word to be considered */
export const MIN_WORD_LENGTH = 3;
/** Maximum words extracted from a query */
export const MAX_QUERY_WORDS = 16;
/** Maximum phrases detected */
export const MAX_PHRASES = 8;

/**
 * Query intent classification.
 * - SEARCH: information retrieval (default)
 * - ACTION: imperative command (filtered out for retrieval)
 */
export type QueryIntent = "SEARCH" | "ACTION";

/**
 * Imperative verbs in both languages that indicate commands, not content.
 * These are filtered from content words but used for intent detection.
 */
export const IMPERATIVE_VERBS = new Set([
  // English imperatives
  "show", "get", "find", "search", "fetch", "retrieve", "list", "display",
  "give", "tell", "explain", "describe", "provide", "return", "check",
  "look", "see", "view", "read", "open", "load",
  // Indonesian imperatives
  "cek", "tampilkan", "tunjukkan", "carikan", "cari", "ambil", "lihat",
  "buka", "muat", "dapatkan", "berikan", "jelaskan", "kasih",
]);

/**
 * Processed query with extracted structure.
 */
export type ProcessedQuery = {
  /** Original query, trimmed */
  original: string;
  /** Normalized form (lowercase, punctuation normalized) */
  normalized: string;
  /** Intent classification */
  intent: QueryIntent;
  /** Content words (imperatives and stopwords removed) */
  contentWords: string[];
  /** Detected phrases (2-3 word collocations) */
  phrases: string[];
  /** All words (before filtering, for entity matching) */
  allWords: string[];
};

/**
 * Normalize Unicode and punctuation.
 * - NFD decomposition for combining characters
 * - Smart quotes → ASCII quotes
 * - Em/en dashes → hyphen
 * - Multiple spaces → single space
 */
export function normalizeText(text: string): string {
  return (
    text
      .normalize("NFD")
      // Smart quotes
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      // Dashes
      .replace(/[–—]/g, "-")
      // Multiple spaces
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

/**
 * Tokenize text into words.
 * Splits on non-letter/non-digit, keeps words >= MIN_WORD_LENGTH.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

/**
 * Detect query intent.
 * If query starts with imperative verb, it's an ACTION.
 * Otherwise, it's a SEARCH.
 */
export function detectIntent(words: string[]): QueryIntent {
  if (words.length === 0) return "SEARCH";
  const firstWord = words[0].toLowerCase();
  return IMPERATIVE_VERBS.has(firstWord) ? "ACTION" : "SEARCH";
}

/**
 * Filter content words: remove stopwords and imperatives.
 * Keep only words that carry topical meaning.
 */
export function extractContentWords(words: string[]): string[] {
  const content: string[] = [];
  for (const word of words) {
    if (word.length < MIN_WORD_LENGTH) continue;
    if (STOP_WORDS.has(word)) continue;
    if (IMPERATIVE_VERBS.has(word)) continue;
    content.push(word);
  }
  // Deduplicate while preserving order
  return [...new Set(content)].slice(0, MAX_QUERY_WORDS);
}

/**
 * Detect phrases (2-3 word collocations).
 *
 * A phrase is valid if:
 * - 2-3 consecutive words
 * - No stopwords or imperatives in the middle
 * - All words meet MIN_WORD_LENGTH
 *
 * Example: "communication preference profile"
 *   → ["communication preference", "preference profile", "communication preference profile"]
 */
export function detectPhrases(words: string[]): string[] {
  const phrases: string[] = [];
  if (words.length < 2) return phrases;

  // Bigrams (2-word phrases)
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i];
    const w2 = words[i + 1];

    // Both must be content words
    if (
      w1.length >= MIN_WORD_LENGTH &&
      w2.length >= MIN_WORD_LENGTH &&
      !STOP_WORDS.has(w1) &&
      !STOP_WORDS.has(w2) &&
      !IMPERATIVE_VERBS.has(w1) &&
      !IMPERATIVE_VERBS.has(w2)
    ) {
      phrases.push(`${w1} ${w2}`);
    }
  }

  // Trigrams (3-word phrases)
  for (let i = 0; i < words.length - 2; i++) {
    const w1 = words[i];
    const w2 = words[i + 1];
    const w3 = words[i + 2];

    // All three must be content words
    if (
      w1.length >= MIN_WORD_LENGTH &&
      w2.length >= MIN_WORD_LENGTH &&
      w3.length >= MIN_WORD_LENGTH &&
      !STOP_WORDS.has(w1) &&
      !STOP_WORDS.has(w2) &&
      !STOP_WORDS.has(w3) &&
      !IMPERATIVE_VERBS.has(w1) &&
      !IMPERATIVE_VERBS.has(w2) &&
      !IMPERATIVE_VERBS.has(w3)
    ) {
      phrases.push(`${w1} ${w2} ${w3}`);
    }
  }

  return phrases.slice(0, MAX_PHRASES);
}

/**
 * Process a natural language query into structured form.
 *
 * This is the main entry point for query understanding.
 *
 * Example:
 *   Input: "Check user identity and communication preferences"
 *   Output: {
 *     original: "Check user identity and communication preferences",
 *     normalized: "check user identity and communication preferences",
 *     intent: "ACTION",
 *     contentWords: ["user", "identity", "communication", "preferences"],
 *     phrases: ["user identity", "communication preferences"],
 *     allWords: ["check", "user", "identity", "and", "communication", "preferences"]
 *   }
 */
export function processQuery(query: string): ProcessedQuery {
  const original = query.trim();
  const normalized = normalizeText(original);
  const allWords = tokenize(normalized);
  const intent = detectIntent(allWords);
  const contentWords = extractContentWords(allWords);
  const phrases = detectPhrases(allWords);

  return {
    original,
    normalized,
    intent,
    contentWords,
    phrases,
    allWords,
  };
}

/**
 * Build enhanced query string for FTS and entity matching.
 *
 * Strategy:
 * 1. Use content words (stopwords/imperatives removed)
 * 2. Boost phrases (repeat phrase words to increase weight)
 * 3. Deduplicate
 *
 * This produces a query that:
 * - Removes noise (stopwords, imperatives)
 * - Emphasizes multi-word concepts
 * - Works with existing FTS (no schema changes needed)
 *
 * Example:
 *   contentWords: ["user", "identity", "communication", "preferences"]
 *   phrases: ["communication preferences"]
 *   → "user identity communication preferences communication preferences"
 *      (phrase words repeated for boost)
 */
export function buildEnhancedQuery(processed: ProcessedQuery): string {
  const terms: string[] = [...processed.contentWords];

  // Add phrase words again to boost their weight
  for (const phrase of processed.phrases) {
    terms.push(phrase);
  }

  // Deduplicate while preserving order
  const unique = [...new Set(terms)];

  return unique.join(" ");
}

/**
 * Extract words suitable for entity name matching.
 *
 * Entity matching is more permissive than content word extraction:
 * - Includes words that might be entity names
 * - Removes only pure stopwords and imperatives
 * - Keeps proper nouns, numbers, acronyms
 *
 * Used by entity leg to match against brain_entities.name and aliases.
 */
export function extractEntityMatchWords(processed: ProcessedQuery): string[] {
  const words: string[] = [];

  for (const word of processed.allWords) {
    if (word.length < MIN_WORD_LENGTH) continue;
    if (STOP_WORDS.has(word)) continue;
    if (IMPERATIVE_VERBS.has(word)) continue;
    words.push(word);
  }

  return [...new Set(words)].slice(0, MAX_QUERY_WORDS);
}
