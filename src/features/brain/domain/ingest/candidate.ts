/**
 * From a conversation turn to something a memory can be made of.
 *
 * The ingest pipeline is handed either explicit candidates (an agent decided what was
 * worth keeping) or raw turns (a lifecycle hook shipped the transcript and nothing has
 * decided anything yet). This module is the second path: it proposes a title, a type and
 * an importance for a block of prose, so a hook that knows nothing about the brain's
 * schema can still feed it.
 *
 * Everything here is a guess, and the guesses are deliberately conservative:
 *
 * - The title is *extracted*, never invented. Summarising needs a model, and this runs
 *   on the request path with no provider configured; a clipped first clause is honest
 *   about being a clipped first clause.
 * - `type` defaults to `fact`. The interesting types (`instruction`, `preference`) are
 *   only claimed when the text says so in words, because those two are injected into
 *   every future session and a wrong guess there is expensive.
 * - Importance is derived from the type and the salience, not from the length. Long is
 *   not important; a one-line rule outranks three paragraphs of context.
 */

import type { MemoryType } from "@brain/domain/constants";
import {
  DIRECTIVE_SALIENCE_FLOOR,
  normalizeTurnText,
  scoreSalience,
  type SalienceSignal,
  type SalienceVerdict,
  type TurnRole,
} from "./salience";

/** A raw conversation turn as a lifecycle hook sends it. */
export type ConversationTurn = {
  role: TurnRole;
  text: string;
};

/** What the pipeline consumes. An agent may supply these directly and skip mining. */
export type IngestCandidate = {
  title?: string | null;
  content: string;
  type?: MemoryType | null;
  summary?: string | null;
  importance?: number | null;
  tags?: string[] | null;
  projectId?: string | null;
  role?: TurnRole | null;
  /** Index in the transcript this came from, kept for provenance. */
  turnIndex?: number | null;
};

export const TITLE_CHARS = 70;
export const SUMMARY_CHARS = 240;
/** A transcript longer than this is trimmed to its tail — the end is where decisions land. */
export const MAX_MINED_TURNS = 60;

/** The two types that become standing instructions, and so face the higher bar. */
export const DIRECTIVE_MEMORY_TYPES: readonly MemoryType[] = ["instruction", "preference"];

export function isDirectiveType(type: MemoryType): boolean {
  return DIRECTIVE_MEMORY_TYPES.includes(type);
}

const INSTRUCTION_MARKERS = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bfrom now on\b/i,
  /\bmust\b/i,
  /\bdon'?t\b/i,
  /\b(make|be) sure to\b/i,
  /\bthe rule is\b/i,
  /\bselalu\b/i,
  /\bjangan\b/i,
  /\bharus\b/i,
  /\bwajib\b/i,
  /\bbiasakan\b/i,
  /\bmulai sekarang\b/i,
  /\bpastikan\b/i,
];

const PREFERENCE_MARKERS = [
  /\bprefer(s|red)?\b/i,
  /\bi (like|love|hate)\b/i,
  /\b(i'?d |would )?rather\b/i,
  /\bfavourite|favorite\b/i,
  /\blebih suka\b/i,
  /\blebih enak\b/i,
  /\bmending\b/i,
  /\b(gua|gue|saya|aku) suka\b/i,
  /\bsukanya\b/i,
];

const DECISION_MARKERS = [
  /\bwe decided\b/i,
  /\bdecided to\b/i,
  /\bwe('ll| will) use\b/i,
  /\bgoing with\b/i,
  /\bsettled on\b/i,
  /\bthe plan is\b/i,
  /\bkita (pakai|gunakan|pilih|jadi)\b/i,
  /\bdiputuskan\b/i,
  /\bkeputusan\b/i,
];

const PROCEDURE_MARKERS = [
  /\bstep \d\b/i,
  /^\s*\d+[.)]\s/m,
  /\bfirst\b[\s\S]{0,80}\bthen\b/i,
  /\bafter that\b/i,
  /\blangkah\b/i,
  /\bcaranya\b/i,
  /\burutan(nya)?\b/i,
  /\bsetelah itu\b/i,
];

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Ordered most-specific first. A sentence that both states a rule and names a choice is
 * a rule — the rule is the part that stays true.
 */
export function inferMemoryType(text: string): MemoryType {
  const normalized = normalizeTurnText(text);
  if (matchesAny(INSTRUCTION_MARKERS, normalized)) return "instruction";
  if (matchesAny(PREFERENCE_MARKERS, normalized)) return "preference";
  if (matchesAny(DECISION_MARKERS, normalized)) return "decision";
  if (matchesAny(PROCEDURE_MARKERS, text)) return "procedure";
  return "fact";
}

/** Clip on a word boundary, with an ellipsis, so nothing ends mid-word. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A title taken from the text itself: the first sentence, minus the conversational
 * opener it probably starts with, clipped to something a list can render.
 */
export function synthesizeTitle(text: string): string {
  const normalized = normalizeTurnText(text)
    // Drop a leading fenced block: it is never a good title.
    .replace(/^```[\s\S]*?```\s*/, "")
    .replace(
      /^(ok(ay)?|oke|jadi|so|btw|anyway|hey|hi|halo|hai|bro|eh|nah|well|listen|note|catat|inget|ingat)[,:\s]+/i,
      ""
    )
    .trim();
  const sentence = normalized.split(/(?<=[.!?])\s+|\n/)[0] ?? normalized;
  const title = clip(sentence.trim() || normalized, TITLE_CHARS);
  return title || "Untitled note";
}

/**
 * Importance on the brain's own 0..1 scale (`memories.importance`, default 0.5,
 * `IMPORTANT_THRESHOLD` 0.7 in recall).
 *
 * A type floor plus a salience bonus, and nothing else. It stays under 0.7 unless the
 * text is both a rule and strongly salient, so auto-ingested material does not crowd
 * out the memories a person marked important by hand.
 */
export function estimateImportance(type: MemoryType, salience: number): number {
  const floor =
    type === "instruction"
      ? 0.58
      : type === "preference"
        ? 0.54
        : type === "decision"
          ? 0.5
          : type === "procedure"
            ? 0.46
            : 0.4;
  return Math.round(Math.min(0.95, floor + salience * 0.28) * 100) / 100;
}

/**
 * Confidence for an auto-ingested memory, on the same 0..1 scale as `memories.confidence`
 * (default 0.9 for something a person wrote).
 *
 * Capped below that on purpose. Nobody confirmed this; a machine inferred it from a
 * sentence. `brain_health` counts low-confidence-important memories, so the cap is also
 * what makes auto-ingested material show up as something to review.
 */
export function ingestConfidence(salience: number): number {
  return Math.round(Math.min(0.8, 0.45 + salience * 0.4) * 100) / 100;
}

export type MinedCandidate = IngestCandidate & {
  title: string;
  type: MemoryType;
  importance: number;
  salience: SalienceVerdict;
};

/**
 * Turn a transcript into candidates, scored but not yet gated — the gate belongs to
 * `ingestCandidates`, which is the only place that also knows the caller's thresholds.
 *
 * Only the tail is read. A long session's early turns are setup; its late turns are what
 * was concluded, and reading all of a 500-turn transcript to keep three sentences is
 * work nobody asked for.
 */
export function mineCandidates(
  turns: readonly ConversationTurn[],
  options: { maxTurns?: number } = {}
): MinedCandidate[] {
  const limit = Math.max(1, Math.min(MAX_MINED_TURNS, options.maxTurns ?? MAX_MINED_TURNS));
  const tail = turns.slice(-limit);
  const offset = turns.length - tail.length;

  return tail.map((turn, index) => describeCandidate(turn.text, turn.role, offset + index));
}

/** Score and shape one block of text. Shared by the mining path and the explicit path. */
export function describeCandidate(
  text: string,
  role: TurnRole = "user",
  turnIndex: number | null = null
): MinedCandidate {
  const salience = scoreSalience(text, role);
  const type = inferMemoryType(text);
  const content = normalizeTurnText(text);
  return {
    title: synthesizeTitle(text),
    content,
    type,
    summary: content.length > SUMMARY_CHARS ? clip(content, SUMMARY_CHARS) : null,
    importance: estimateImportance(type, salience.score),
    role,
    turnIndex,
    salience,
  };
}

/**
 * The salience bar this candidate has to clear, given the caller's floor. A candidate
 * that would become a standing instruction is held to `DIRECTIVE_SALIENCE_FLOOR` even
 * when the caller asked for something lower — the caller can be more strict, never less.
 */
export function requiredSalience(type: MemoryType, minSalience: number): number {
  return isDirectiveType(type) ? Math.max(minSalience, DIRECTIVE_SALIENCE_FLOOR) : minSalience;
}

export type { SalienceSignal, SalienceVerdict, TurnRole };
