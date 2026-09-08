import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { memories } from "@/shared/infrastructure/db/schema";
import { ftsAnyMatchOn, ftsAnyRankOn } from "@/shared/lib/search/fts";
import { normalizeTags, type MemoryType } from "@brain/domain/constants";
import {
  describeCandidate,
  estimateImportance,
  ingestConfidence,
  isDirectiveType,
  mineCandidates,
  requiredSalience,
  type ConversationTurn,
  type IngestCandidate,
  type MinedCandidate,
} from "@brain/domain/ingest/candidate";
import { MIN_SALIENCE, type SalienceSignal } from "@brain/domain/ingest/salience";
import { rankDuplicates, type DuplicateMatch } from "@brain/domain/ingest/similarity";
import {
  DEFAULT_SAMPLE_RATE,
  normalizeSampleRate,
  passesSampling,
} from "@brain/domain/ingest/sampling";
import { createMemory, updateMemory } from "./memory-service";

/**
 * Auto-writeback: the brain writing itself down from a conversation.
 *
 * Every other write in this codebase is something a person or an agent decided to make.
 * This one decides for itself, which makes it the only path that can degrade a brain
 * without anybody noticing. The whole module is therefore built as a series of gates,
 * each one cheap and each one able to explain itself:
 *
 *   candidate → salience → sampling → importance → duplicate → write
 *
 * Four properties are load-bearing:
 *
 * - **Nothing is destroyed.** A duplicate never overwrites the memory it matched. It
 *   either appends (snapshotting a version, as any edit does) or it corroborates —
 *   bumping confidence and touching nothing else. A memory somebody wrote by hand
 *   cannot be flattened by a passing chat message that resembled it.
 * - **Bounded.** At most `maxWrites` writes per call, and the candidates are processed
 *   best-first, so the budget is spent on the strongest material rather than on
 *   whatever happened to be at the top of the transcript.
 * - **Explainable.** Every candidate comes back with its score, the signals that fired
 *   and the reason it was kept or dropped. A pipeline that silently swallows input is
 *   impossible to trust and impossible to tune.
 * - **Reproducible.** No clock and no RNG affect a decision (see
 *   `domain/ingest/sampling.ts`), so the same transcript ingests the same way twice.
 *
 * Cache invalidation and realtime notification are the *caller's* job, exactly as with
 * `rememberMemory` — this layer talks to memory-service and nothing else.
 */

/** Default floor on the estimated importance of anything kept. */
export const MIN_IMPORTANCE = 0.45;
/** Hard ceiling on writes per call. A runaway agent cannot dump a transcript in. */
export const MAX_WRITES_PER_CALL = 5;
/** Hard ceiling on candidates scored per call, so the pure work is bounded too. */
export const MAX_CANDIDATES_PER_CALL = 40;
/** How many full-text neighbours to fuzzy-compare a candidate against. */
const DEDUPE_POOL = 8;
/**
 * Above this containment the candidate's whole vocabulary is already in the existing
 * memory: there is nothing to append, so the match is recorded as corroboration.
 */
const CORROBORATION_CONTAINMENT = 0.9;
/** A memory that has grown past this is never appended to again. */
const MAX_MERGED_CONTENT = 8000;
/** Ceiling on the confidence repetition alone can produce. */
const CORROBORATION_CONFIDENCE_CAP = 0.85;

export type IngestDisposition =
  | "created"
  | "merged"
  | "skipped_duplicate"
  | "skipped_low_salience"
  | "skipped_low_importance"
  | "skipped_sampled_out"
  | "skipped_write_budget";

export type IngestOptions = {
  /** Correlates every memory written from one conversation. Also the sampling seed. */
  sessionId?: string | null;
  projectId?: string | null;
  minSalience?: number;
  minImportance?: number;
  sampleRate?: number;
  maxWrites?: number;
  tags?: string[] | null;
  /** `false` decides everything and writes nothing — a real preview, same gates. */
  commit?: boolean;
};

export type IngestOutcome = {
  disposition: IngestDisposition;
  title: string;
  type: MemoryType;
  salience: number;
  signals: SalienceSignal[];
  importance: number;
  /** The memory created, or the one merged into. Null when nothing was written. */
  memoryId: string | null;
  duplicateOf: { id: string; title: string; score: number } | null;
  /** A standing instruction was written: it will steer every later session. */
  requiresReview: boolean;
  reason: string;
};

export type IngestReport = {
  sessionId: string | null;
  committed: boolean;
  considered: number;
  created: number;
  merged: number;
  skipped: number;
  reviewNeeded: number;
  thresholds: { minSalience: number; minImportance: number; sampleRate: number; maxWrites: number };
  results: IngestOutcome[];
};

type Principal = { userId: string; agentId: string | null; agentName?: string | null };

type PoolRow = {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  type: string;
  confidence: number;
  metadata: unknown;
};

/** Turn raw turns into candidates. Exposed so a caller can preview the mining alone. */
export function candidatesFromTurns(turns: readonly ConversationTurn[]): IngestCandidate[] {
  return mineCandidates(turns).map((mined) => ({
    title: mined.title,
    content: mined.content,
    type: mined.type,
    summary: mined.summary,
    role: mined.role,
    turnIndex: mined.turnIndex,
  }));
}

/**
 * Score, gate and (unless previewing) write a batch of candidates.
 *
 * Candidates arrive in transcript order and are processed in salience order. That
 * reordering is the difference between a write budget that keeps the best five things
 * said and one that keeps the first five.
 */
export async function ingestCandidates(params: {
  brainId: string;
  principal: Principal;
  candidates: readonly IngestCandidate[];
  options?: IngestOptions;
}): Promise<IngestReport> {
  const { brainId, principal } = params;
  const options = params.options ?? {};

  const sessionId = options.sessionId?.trim() || null;
  const minSalience = clamp01(options.minSalience ?? MIN_SALIENCE);
  const minImportance = clamp01(options.minImportance ?? MIN_IMPORTANCE);
  const sampleRate = normalizeSampleRate(options.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const maxWrites = Math.max(
    0,
    Math.min(MAX_WRITES_PER_CALL, Math.trunc(options.maxWrites ?? MAX_WRITES_PER_CALL))
  );
  const commit = options.commit !== false;

  const prepared = params.candidates
    .slice(0, MAX_CANDIDATES_PER_CALL)
    .map((candidate) => prepare(candidate, options.projectId ?? null, options.tags ?? null))
    .filter((candidate) => candidate.content.length > 0)
    // Best first. `importance` breaks a salience tie, so a rule outranks a fact that
    // happened to be phrased with the same markers.
    .sort((a, b) => b.salience.score - a.salience.score || b.importance - a.importance);

  const results: IngestOutcome[] = [];
  let writes = 0;

  for (const candidate of prepared) {
    const outcome = await runOne({
      brainId,
      principal,
      candidate,
      sessionId,
      minSalience,
      minImportance,
      sampleRate,
      commit,
      budgetLeft: maxWrites - writes,
    });
    if (outcome.disposition === "created" || outcome.disposition === "merged") writes += 1;
    results.push(outcome);
  }

  const created = results.filter((r) => r.disposition === "created").length;
  const merged = results.filter((r) => r.disposition === "merged").length;
  return {
    sessionId,
    committed: commit,
    considered: results.length,
    created,
    merged,
    skipped: results.length - created - merged,
    reviewNeeded: results.filter((r) => r.requiresReview).length,
    thresholds: { minSalience, minImportance, sampleRate, maxWrites },
    results,
  };
}

/** One candidate through every gate. The gates are ordered cheapest-first on purpose. */
async function runOne(input: {
  brainId: string;
  principal: Principal;
  candidate: MinedCandidate;
  sessionId: string | null;
  minSalience: number;
  minImportance: number;
  sampleRate: number;
  commit: boolean;
  budgetLeft: number;
}): Promise<IngestOutcome> {
  const { brainId, principal, candidate, sessionId, commit } = input;
  const base = {
    title: candidate.title,
    type: candidate.type,
    salience: candidate.salience.score,
    signals: candidate.salience.signals,
    importance: candidate.importance,
    memoryId: null,
    duplicateOf: null,
    requiresReview: false,
  } satisfies Omit<IngestOutcome, "disposition" | "reason">;

  const required = requiredSalience(candidate.type, input.minSalience);
  if (candidate.salience.score < required) {
    return {
      ...base,
      disposition: "skipped_low_salience",
      reason: isDirectiveType(candidate.type)
        ? `A standing instruction needs salience ≥ ${required}; this scored ${candidate.salience.score}`
        : `Salience ${candidate.salience.score} is below ${required}`,
    };
  }

  if (!passesSampling(candidate.content, sessionId ?? brainId, input.sampleRate)) {
    return {
      ...base,
      disposition: "skipped_sampled_out",
      reason: `Sampling at rate ${input.sampleRate} did not select this candidate`,
    };
  }

  if (candidate.importance < input.minImportance) {
    return {
      ...base,
      disposition: "skipped_low_importance",
      reason: `Importance ${candidate.importance} is below ${input.minImportance}`,
    };
  }

  // Before the database is touched: a candidate that cannot be written does not get a
  // dedupe read either, which is what keeps a 40-turn transcript to `maxWrites` queries.
  if (input.budgetLeft <= 0) {
    return {
      ...base,
      disposition: "skipped_write_budget",
      reason: "The write budget for this call was already spent on stronger candidates",
    };
  }

  const pool = await findDuplicatePool(brainId, candidate);
  const best = rankDuplicates(candidate, pool)[0] ?? null;
  const duplicateOf = best
    ? { id: best.memory.id, title: best.memory.title, score: best.score }
    : null;

  if (best && best.band === "merge") {
    return mergeInto({ brainId, principal, candidate, match: best, sessionId, commit, base });
  }

  const requiresReview = isDirectiveType(candidate.type);
  if (!commit) {
    return {
      ...base,
      duplicateOf,
      requiresReview,
      disposition: "created",
      reason: describeCreate(duplicateOf, true),
    };
  }

  const memory = await createMemory({
    brainId,
    principal,
    data: {
      title: candidate.title,
      content: candidate.content,
      type: candidate.type,
      summary: candidate.summary ?? undefined,
      importance: candidate.importance,
      confidence: ingestConfidence(candidate.salience.score),
      sourceType: "conversation",
      sourceId: sessionId,
      projectId: candidate.projectId ?? undefined,
      tags: candidate.tags ? normalizeTags(candidate.tags) : undefined,
      metadata: provenance(candidate, sessionId, principal),
    },
  });

  return {
    ...base,
    memoryId: memory.id,
    duplicateOf,
    requiresReview,
    disposition: "created",
    reason: describeCreate(duplicateOf, false),
  };
}

function describeCreate(
  duplicateOf: { title: string; score: number } | null,
  preview: boolean
): string {
  const lead = preview ? "Would be created" : "Created";
  return duplicateOf
    ? `${lead}; resembles “${duplicateOf.title}” (${duplicateOf.score}) but not closely enough to merge`
    : `${lead}: nothing in the brain resembles it`;
}

/**
 * The candidate is the same statement as an existing memory. Two outcomes, neither of
 * which loses anything:
 *
 * - **Corroboration.** Every word is already there (or the memory is too long to grow
 *   further), so the text is left exactly as it is and confidence rises a little — the
 *   same thing said twice is weak evidence, so the ceiling is low and it can never pull
 *   a hand-written memory *down*. If confidence is already at or above the ceiling
 *   nothing is written at all.
 * - **Append.** The candidate says it differently or adds a detail, so it is appended
 *   as its own paragraph. That is a content change, so `updateMemory` snapshots a
 *   version first and the previous text stays recoverable.
 */
async function mergeInto(input: {
  brainId: string;
  principal: Principal;
  candidate: MinedCandidate;
  match: DuplicateMatch<PoolRow>;
  sessionId: string | null;
  commit: boolean;
  base: Omit<IngestOutcome, "disposition" | "reason">;
}): Promise<IngestOutcome> {
  const { brainId, principal, candidate, match, sessionId, commit, base } = input;
  const existing = match.memory;
  const duplicateOf = { id: existing.id, title: existing.title, score: match.score };
  const appended = `${existing.content.trimEnd()}\n\n${candidate.content}`;

  const canAppend =
    match.parts.containment < CORROBORATION_CONTAINMENT && appended.length <= MAX_MERGED_CONTENT;
  const nextConfidence = Math.max(
    existing.confidence,
    Math.min(CORROBORATION_CONFIDENCE_CAP, round2(existing.confidence + 0.05))
  );

  if (!canAppend && nextConfidence <= existing.confidence) {
    return {
      ...base,
      memoryId: existing.id,
      duplicateOf,
      disposition: "skipped_duplicate",
      reason: `Already recorded as “${existing.title}” (${match.score}); nothing to add`,
    };
  }

  const reason = canAppend
    ? `Appended to “${existing.title}” (${match.score})`
    : `Corroborated “${existing.title}” (${match.score}); confidence ${existing.confidence} → ${nextConfidence}`;
  // Appending to a rule changes what that rule says in every later session; bumping a
  // memory's confidence does not.
  const requiresReview = canAppend && isDirectiveType(existing.type as MemoryType);

  if (!commit) {
    return {
      ...base,
      memoryId: existing.id,
      duplicateOf,
      requiresReview,
      disposition: "merged",
      reason,
    };
  }

  await updateMemory({
    brainId,
    memoryId: existing.id,
    principal,
    data: canAppend
      ? {
          content: appended,
          confidence: nextConfidence,
          metadata: mergeMetadata(existing.metadata, candidate, sessionId, principal),
        }
      : // Confidence alone is not a content change, so this neither snapshots a version
        // nor re-queues enrichment — a corroboration must not show up as an edit.
        { confidence: nextConfidence },
    changeReason: `Merged from conversation ingest (similarity ${match.score})`,
  });

  return {
    ...base,
    memoryId: existing.id,
    duplicateOf,
    requiresReview,
    disposition: "merged",
    reason,
  };
}

/**
 * The handful of live memories worth fuzzy-comparing against.
 *
 * `ftsAnyMatchOn` — ANY of the terms, not all of them. The AND variant behind the search
 * box is the wrong tool here for the reason documented in `fts.ts`: feeding a whole
 * sentence through it matches almost nothing, and a dedupe pass that finds no candidates
 * silently becomes a duplicate factory. Recall matters; the precision comes from
 * `rankDuplicates` afterwards, in process, where it can be tested.
 */
async function findDuplicatePool(brainId: string, candidate: MinedCandidate): Promise<PoolRow[]> {
  const probe = `${candidate.title} ${candidate.content}`.slice(0, 500);
  return db
    .select({
      id: memories.id,
      title: memories.title,
      content: memories.content,
      summary: memories.summary,
      type: memories.type,
      confidence: memories.confidence,
      metadata: memories.metadata,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        ...(candidate.projectId ? [eq(memories.projectId, candidate.projectId)] : []),
        ftsAnyMatchOn(memories.searchVector, probe)
      )
    )
    .orderBy(desc(ftsAnyRankOn(memories.searchVector, probe)))
    .limit(DEDUPE_POOL);
}

/**
 * Fill in whatever the caller left out. A caller-supplied `type` re-derives importance,
 * because importance is a function of the type and taking the derived one would describe
 * a type nobody asked for.
 */
function prepare(
  candidate: IngestCandidate,
  projectId: string | null,
  tags: string[] | null
): MinedCandidate {
  const derived = describeCandidate(
    candidate.content,
    candidate.role ?? "user",
    candidate.turnIndex ?? null
  );
  const type = candidate.type ?? derived.type;
  return {
    ...derived,
    title: candidate.title?.trim() || derived.title,
    type,
    summary: candidate.summary ?? derived.summary,
    importance: candidate.importance ?? estimateImportance(type, derived.salience.score),
    tags: candidate.tags ?? tags,
    projectId: candidate.projectId ?? projectId,
  };
}

/**
 * The provenance stamp. Written into `memories.metadata` (already `jsonb`) rather than
 * into new columns, so auto-writeback ships without a migration — and `sourceType`
 * `"conversation"` was already in the enum for exactly this.
 */
function provenance(
  candidate: MinedCandidate,
  sessionId: string | null,
  principal: Principal
): Record<string, unknown> {
  return {
    ingest: {
      sessionId,
      agent: principal.agentName ?? null,
      role: candidate.role ?? null,
      turnIndex: candidate.turnIndex ?? null,
      salience: candidate.salience.score,
      signals: candidate.salience.signals,
      inferredType: candidate.type,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * `updateMemory` replaces `metadata` wholesale, so an append has to carry the existing
 * object forward. Anything a human or another tool put there survives; only the `ingest`
 * key is rewritten, with a count of how many times this memory has been corroborated.
 */
function mergeMetadata(
  existing: unknown,
  candidate: MinedCandidate,
  sessionId: string | null,
  principal: Principal
): Record<string, unknown> {
  const previous =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const previousIngest =
    previous.ingest && typeof previous.ingest === "object" && !Array.isArray(previous.ingest)
      ? (previous.ingest as Record<string, unknown>)
      : {};
  const mergeCount = Number(previousIngest.mergeCount);
  const next = provenance(candidate, sessionId, principal).ingest as Record<string, unknown>;
  return {
    ...previous,
    ingest: {
      ...previousIngest,
      ...next,
      mergeCount: (Number.isFinite(mergeCount) ? mergeCount : 0) + 1,
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const DISPOSITION_LABEL: Record<IngestDisposition, string> = {
  created: "created",
  merged: "merged",
  skipped_duplicate: "duplicate",
  skipped_low_salience: "low salience",
  skipped_low_importance: "low importance",
  skipped_sampled_out: "sampled out",
  skipped_write_budget: "budget spent",
};

/**
 * The report as text, for an MCP tool result or a hook that prints to a terminal.
 *
 * Every skipped candidate is listed with its reason. That is deliberate and it is the
 * feature: a writeback pipeline is only tunable if it says out loud what it threw away,
 * and "nothing was saved" is the answer a user is most likely to want explained.
 */
export function renderIngestReport(report: IngestReport): string {
  const verb = report.committed
    ? `${report.created} created, ${report.merged} merged, ${report.skipped} skipped`
    : `${report.created} would be created, ${report.merged} would merge, ${report.skipped} skipped`;
  const lines = [
    `${report.committed ? "Ingest" : "Ingest preview (nothing written)"}: ${verb} of ${report.considered} considered.`,
  ];

  if (report.sessionId) lines.push(`Session: ${report.sessionId}`);
  const t = report.thresholds;
  lines.push(
    `Thresholds: salience ≥ ${t.minSalience}, importance ≥ ${t.minImportance}, sample rate ${t.sampleRate}, max ${t.maxWrites} writes.`
  );

  if (report.results.length > 0) {
    lines.push("");
    for (const item of report.results) {
      const flag = item.requiresReview ? " ⚠ standing instruction — review it" : "";
      lines.push(
        `- [${DISPOSITION_LABEL[item.disposition]}] ${item.type} “${item.title}” (salience ${item.salience}, importance ${item.importance})${flag}`,
        `  ${item.reason}`
      );
    }
  }

  if (report.reviewNeeded > 0) {
    lines.push(
      "",
      `${report.reviewNeeded} of these ${report.committed ? "are" : "would be"} standing instructions, which steer every later session. Tell the user what was recorded.`
    );
  } else if (report.created === 0 && report.merged === 0) {
    lines.push("", "Nothing in this conversation was durable enough to keep.");
  }

  return lines.join("\n");
}



