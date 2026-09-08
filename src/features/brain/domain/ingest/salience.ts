/**
 * Salience: is this sentence still true after the conversation ends?
 *
 * Auto-writeback is the one feature that can quietly ruin a brain. Every other write
 * is something a person or an agent chose to make; this one happens by itself, so the
 * gate in front of it is the whole design. A brain full of "ok thanks" and "run the
 * tests again" is worse than an empty one — the retrieval layer has to rank against
 * that noise on every single recall.
 *
 * So the scorer is a weighted sum over *named* signals rather than a single opaque
 * heuristic. Two reasons: a rejected candidate can say why it was rejected (the
 * report from `ingestCandidates` carries the signal list), and each weight can be
 * argued about on its own instead of being retuned by feel.
 *
 * Bilingual on purpose. This brain's owner writes half in Indonesian and half in
 * English, often in the same sentence — an English-only marker table would drop
 * "selalu jawab pakai bahasa Indonesia", which is exactly the kind of rule that
 * matters most.
 *
 * Nothing here touches the database or the clock, so the calibration below is
 * asserted on real sentences in salience.test.ts rather than trusted.
 */

/** A tuple, not a `readonly TurnRole[]`, so `z.enum(TURN_ROLES)` accepts it at the edge. */
export const TURN_ROLES = ["user", "assistant", "system", "tool"] as const;

export type TurnRole = (typeof TURN_ROLES)[number];

export const SALIENCE_SIGNALS = [
  "durability",
  "decision",
  "identity",
  "correction",
  "specificity",
  "question",
  "ephemeral",
  "pleasantry",
  "too_short",
  "too_long",
  "code_dump",
] as const;

export type SalienceSignal = (typeof SALIENCE_SIGNALS)[number];

/**
 * Positive weights are what makes a statement durable; negative ones are what makes
 * it conversational. `pleasantry` and `too_short` are the harshest because they are
 * the two highest-volume kinds of turn in any real transcript.
 */
const SIGNAL_WEIGHT: Record<SalienceSignal, number> = {
  durability: 0.3,
  decision: 0.24,
  identity: 0.22,
  correction: 0.16,
  specificity: 0.1,
  question: -0.3,
  ephemeral: -0.22,
  pleasantry: -0.4,
  too_short: -0.35,
  too_long: -0.15,
  code_dump: -0.3,
};

/**
 * What a turn is worth before anything is read out of it. An assistant starts lower
 * than a user: the user states facts about their own world, the assistant mostly
 * restates them, and a brain that remembers its own agent's prose starts citing
 * itself as a source. Tool output starts near zero — it is a log, not knowledge.
 */
const ROLE_BASE: Record<TurnRole, number> = {
  user: 0.4,
  assistant: 0.26,
  system: 0.18,
  tool: 0.05,
};

/** The default bar for keeping a candidate at all. */
export const MIN_SALIENCE = 0.45;

/**
 * The higher bar for a candidate that would become a standing instruction.
 *
 * An `instruction` or `preference` is not just another memory: it is injected into the
 * system prompt of every future session by `buildAgentInstructions`. A wrong fact is
 * one bad recall; a wrong rule is every session from now on. So the type that costs
 * the most to get wrong is the one that has to clear the highest bar.
 */
export const DIRECTIVE_SALIENCE_FLOOR = 0.62;

const SHORT_CHARS = 24;
const LONG_CHARS = 1200;

const DURABILITY = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bevery time\b/i,
  /\bby default\b/i,
  /\b(make|be) sure to\b/i,
  /\bremember (that|to)\b/i,
  /\bkeep in mind\b/i,
  /\bthe rule is\b/i,
  /\bdon'?t ever\b/i,
  /\bselalu\b/i,
  /\bjangan\b/i,
  /\bharus\b/i,
  /\bwajib\b/i,
  /\bbiasakan\b/i,
  /\bmulai sekarang\b/i,
  /\bke depan(nya)?\b/i,
  /\bsetiap kali\b/i,
  /\bingat\b/i,
  /\bpastikan\b/i,
  /\bdefault(nya)?\b/i,
];

const DECISION = [
  /\bwe decided\b/i,
  /\bdecided to\b/i,
  /\blet'?s go with\b/i,
  /\bgoing with\b/i,
  /\bwe('ll| will) use\b/i,
  /\bsettled on\b/i,
  /\bthe plan is\b/i,
  /\bagreed to\b/i,
  /\bkita pakai\b/i,
  /\bkita gunakan\b/i,
  /\bkita pilih\b/i,
  /\bkita jadi\b/i,
  /\bjadinya pakai\b/i,
  /\bdiputuskan\b/i,
  /\bkeputusan\b/i,
  /\bsepakat\b/i,
];

const IDENTITY = [
  /\bmy name is\b/i,
  /\bi work (at|on|with)\b/i,
  /\bmy (role|stack|setup|machine|server|project)\b/i,
  /\bour (stack|setup|convention)\b/i,
  /\bi use\b/i,
  /\bi'?m on\b/i,
  /\bwe run\b/i,
  /\bnama (gua|gue|saya|aku)\b/i,
  /\b(gua|gue|saya|aku) (pakai|pake)\b/i,
  /\b(stack|server|setup|projek|proyek|laptop) (gua|gue|saya|aku)\b/i,
  /\b(gua|gue|saya|aku) kerja\b/i,
];

const CORRECTION = [
  /\bactually\b/i,
  /\bthat'?s wrong\b/i,
  /\bcorrection\b/i,
  /\binstead of\b/i,
  /\bi meant\b/i,
  /\bnot .{1,30}\bbut\b/i,
  /\bsebenarnya\b/i,
  /\bbukan\b/i,
  /\bsalah\b/i,
  /\bmaksud (gua|gue|saya|aku)\b/i,
  /\bralat\b/i,
  /\bharusnya\b/i,
];

const EPHEMERAL = [
  /\brun (the|this|it)\b/i,
  /\bfix (this|that|it)\b/i,
  /\bcheck (this|that|it)\b/i,
  /\btry again\b/i,
  /\bopen (the|this)\b/i,
  /\blook at (this|that|the)\b/i,
  /\bcan you\b/i,
  /\bshow me\b/i,
  /\bone more time\b/i,
  /\breal quick\b/i,
  /\bcoba\b/i,
  /\bjalanin\b/i,
  /\bcek\b/i,
  /\bbuka\b/i,
  /\bli[ha]t\b/i,
  /\bbentar\b/i,
  /\btolong\b/i,
  /\blanjut\b/i,
];

const INTERROGATIVE =
  /^(what|why|how|where|when|who|which|can|could|would|should|does|do|did|is|are|apa|apakah|kenapa|ngapain|gimana|bagaimana|kapan|dimana|di mana|siapa|bisa|udah|sudah|berapa)\b/i;

/** Words that carry no content on their own. Used to decide "this turn is only noise". */
const PLEASANTRY_WORDS =
  /\b(thanks?|thank you|thx|ty|ok|okay|okey|k|great|nice|cool|perfect|awesome|got it|understood|sure|yes|yep|no|nope|please|bro|sis|dude|man|makasih|terima kasih|makasi|thanks ya|sip|oke|okelah|mantap|mantul|bagus|keren|wokee|woke|siap|yoi|yup|iya|ya|udah|gas|lanjut|betul|bener)\b/gi;

/** A fenced code block, and the shapes a pasted stack trace or source file takes. */
const FENCE = /```[\s\S]*?(```|$)/g;
const CODE_LINE =
  /^\s*(?:[{}();]|\/\/|#|<\/?\w|import |export |const |let |var |function |class |def |return |at [\w.$]+\(|[\w$.]+\s*[:=]\s*[^\s]|\w+\s*\([^)]*\)\s*[{;])/;

const SPECIFICITY = [
  /\bv?\d+\.\d+(\.\d+)?\b/,
  /[\w-]+\/[\w./-]*\w\.\w{1,6}\b/,
  /\/(opt|etc|usr|var|home|srv|mnt)\//,
  /\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b/,
  /https?:\/\/\S+/i,
  /\b\d+(\.\d+)?\s?(ms|s|m|h|gb|mb|kb|gib|mib|tb|%|rpm|qps|req|port|px|k)\b/i,
  /`[^`\n]{2,}`/,
];

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Collapsed whitespace. Every length threshold is measured on this form. */
export function normalizeTurnText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when the turn is *only* politeness. Deliberately not "contains thanks": "ok, so
 * the plan is to move to Aiven" opens with a pleasantry and is the most important
 * sentence in the transcript. What is tested is the residue — strip the filler words
 * and the punctuation, and see whether anything is left.
 */
function isPleasantryOnly(normalized: string): boolean {
  const residue = normalized
    .replace(PLEASANTRY_WORDS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return residue.length < 12;
}

/** Share of the text that sits inside a fence, plus how many lines look like source. */
function codeWeight(text: string): number {
  let fenced = 0;
  for (const match of text.matchAll(FENCE)) fenced += match[0].length;
  const lines = text.split("\n");
  const codeLines = lines.filter((line) => CODE_LINE.test(line)).length;
  const fencedShare = text.length > 0 ? fenced / text.length : 0;
  const lineShare = lines.length > 0 ? codeLines / lines.length : 0;
  return Math.max(fencedShare, codeLines >= 3 ? lineShare : 0);
}

export type SalienceVerdict = {
  /** 0..1, rounded to 3 places so a report reads like a number and not a float. */
  score: number;
  /** Every signal that fired, in table order — the reason a candidate lived or died. */
  signals: SalienceSignal[];
};

/**
 * Score one turn. `role` matters as much as the words: the same sentence is worth more
 * from the person whose brain this is than from the agent talking to them.
 */
export function scoreSalience(text: string, role: TurnRole = "user"): SalienceVerdict {
  const normalized = normalizeTurnText(text);
  if (!normalized) return { score: 0, signals: ["too_short"] };

  const fired = new Set<SalienceSignal>();

  if (matchesAny(DURABILITY, normalized)) fired.add("durability");
  if (matchesAny(DECISION, normalized)) fired.add("decision");
  if (matchesAny(IDENTITY, normalized)) fired.add("identity");
  if (matchesAny(CORRECTION, normalized)) fired.add("correction");
  if (matchesAny(SPECIFICITY, normalized)) fired.add("specificity");

  if (/\?\s*$/.test(normalized) || INTERROGATIVE.test(normalized)) fired.add("question");
  if (matchesAny(EPHEMERAL, normalized)) fired.add("ephemeral");
  if (isPleasantryOnly(normalized)) fired.add("pleasantry");
  if (normalized.length < SHORT_CHARS) fired.add("too_short");
  if (normalized.length > LONG_CHARS) fired.add("too_long");
  if (codeWeight(text) > 0.6) fired.add("code_dump");

  let score = ROLE_BASE[role] ?? ROLE_BASE.user;
  for (const signal of fired) score += SIGNAL_WEIGHT[signal];

  return {
    score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    signals: SALIENCE_SIGNALS.filter((signal) => fired.has(signal)),
  };
}
