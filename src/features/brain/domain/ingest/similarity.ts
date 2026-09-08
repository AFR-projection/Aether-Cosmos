/**
 * Fuzzy duplicate detection, in process.
 *
 * `brain_remember` already refuses to make twins with the *same title*. Auto-writeback
 * cannot lean on that: nothing writes the same title twice by accident, it writes
 * "Deploy notes", then "Notes on deploying", then "How we deploy". Exact matching sees
 * three memories; a reader sees one fact recorded three times.
 *
 * Two deliberate non-choices:
 *
 * - **Not `pg_trgm`.** Postgres would do this better and faster, but it needs an
 *   extension and therefore a migration, and a similarity threshold that lives in SQL
 *   cannot be unit-tested without a database. The candidate set is already narrowed to
 *   a handful of rows by full-text search, so comparing them in JS costs nothing
 *   measurable and the bands below can be argued about in a test file.
 * - **Not embeddings.** The brain has them (2.0), but they are optional, provider-backed
 *   and asynchronously backfilled. Dedupe has to work on a brain that has never had an
 *   embedding, on the very first ingest, offline.
 *
 * Dice over character trigrams handles the cases that actually show up — word order
 * changes, plurals, a different preposition — and it never claims two unrelated
 * sentences are the same, which is the failure that would silently merge memories.
 */

/** Lowercase, unaccented, punctuation stripped, whitespace collapsed. */
export function normalizeForCompare(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * English and Indonesian function words. Dropped before token comparison so "notes on
 * deploying" and "notes for the deploy" are not judged different by their prepositions.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "in",
  "is", "it", "its", "of", "on", "or", "our", "that", "the", "then", "this", "to", "was",
  "we", "were", "what", "when", "which", "with", "you", "your",
  "adalah", "akan", "aku", "atau", "bahwa", "buat", "dan", "dari", "di", "dengan",
  "gua", "gue", "ini", "itu", "juga", "ke", "kita", "pada", "saja", "saya", "sudah",
  "untuk", "yang", "ya", "aja", "nya", "kalo", "kalau",
]);

const TRIGRAM = 3;

/** Content tokens, stop words and one-character noise removed. */
export function contentTokens(text: string): string[] {
  return normalizeForCompare(text)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Character trigrams of the normalized string, padded so short strings still have some. */
function trigrams(text: string): Set<string> {
  const padded = ` ${normalizeForCompare(text)} `;
  const out = new Set<string>();
  for (let i = 0; i + TRIGRAM <= padded.length; i += 1) {
    out.add(padded.slice(i, i + TRIGRAM));
  }
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Dice coefficient over character trigrams: 1 identical, 0 nothing in common. */
export function trigramSimilarity(a: string, b: string): number {
  return round(dice(trigrams(a), trigrams(b)));
}

/**
 * Jaccard over content tokens. Complements the trigram score: trigrams reward shared
 * spelling, tokens reward shared vocabulary, and a pair that scores on both is the same
 * statement rather than two statements about the same subject.
 */
export function tokenOverlap(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return round(shared / (left.size + right.size - shared));
}

/**
 * Containment: how much of the *shorter* text's vocabulary the longer one already has.
 *
 * This is the case Jaccard gets wrong and that matters most here. A one-line candidate
 * against an existing memory that has been refined over weeks scores low on Jaccard
 * purely because the existing memory is longer — yet if every word of the candidate is
 * already in there, writing it again adds nothing.
 */
export function containment(a: string, b: string): number {
  const left = new Set(contentTokens(a));
  const right = new Set(contentTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return round(shared / small.size);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Merge at or above this: the two are the same statement. */
export const MERGE_AT = 0.82;
/** Report at or above this: worth a human's attention, not worth blocking a write. */
export const REPORT_AT = 0.5;

export type DuplicateBand = "merge" | "report" | "distinct";

export type DuplicateVerdict = {
  score: number;
  band: DuplicateBand;
  /** The three components, so a report can say *why* two memories were called the same. */
  parts: { title: number; body: number; containment: number };
};

export type ComparableMemory = { title: string; content?: string | null; summary?: string | null };

/**
 * How likely it is that `candidate` is already recorded as `existing`.
 *
 * The title dominates (0.45): a memory's title is the claim, its body is the evidence,
 * and two memories with the same claim are the same memory however differently the
 * evidence is written. Containment gets the smallest share (0.2) because it is the most
 * generous of the three — on its own it would merge a specific new detail into the
 * general memory that happens to contain all its words.
 */
export function duplicateScore(
  candidate: ComparableMemory,
  existing: ComparableMemory
): DuplicateVerdict {
  const candidateBody = bodyOf(candidate);
  const existingBody = bodyOf(existing);

  const title = trigramSimilarity(candidate.title, existing.title);
  const body = Math.max(
    tokenOverlap(candidateBody, existingBody),
    trigramSimilarity(candidateBody, existingBody)
  );
  const contained = containment(candidateBody, existingBody);

  const score = round(title * 0.45 + body * 0.35 + contained * 0.2);
  return { score, band: bandOf(score), parts: { title, body, containment: contained } };
}

function bodyOf(memory: ComparableMemory): string {
  return [memory.title, memory.summary ?? "", memory.content ?? ""].join(" ");
}

export function bandOf(score: number): DuplicateBand {
  if (score >= MERGE_AT) return "merge";
  if (score >= REPORT_AT) return "report";
  return "distinct";
}

export type DuplicateMatch<T extends ComparableMemory> = DuplicateVerdict & { memory: T };

/**
 * Every existing memory that resembles the candidate, best first, `report` band and up.
 * The caller merges into `[0]` when its band is `merge` and otherwise attaches the list
 * to the created memory as `possibleDuplicates` — the same "report, never enforce"
 * policy `brain_remember` already applies to its own near neighbours.
 */
export function rankDuplicates<T extends ComparableMemory>(
  candidate: ComparableMemory,
  existing: readonly T[]
): DuplicateMatch<T>[] {
  return existing
    .map((memory) => ({ ...duplicateScore(candidate, memory), memory }))
    .filter((match) => match.band !== "distinct")
    .sort((a, b) => b.score - a.score);
}
