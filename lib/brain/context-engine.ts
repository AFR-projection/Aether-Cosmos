import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as applicationDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { brainEntities, memories, memoryLinks, memoryMentions } from "@/lib/db/schema";
import { detectConflicts, type ConflictPair } from "./consolidation-service";
import { STOP_WORDS } from "./graph/relate";
import type { MemoryType } from "./constants";
import { RESULT_LIMIT_MAX, retrieveMemories, type RetrievalLeg } from "./retrieval/retrieve";
import type { GraphEvidence } from "./retrieval/retrieve";
import type { RetrievalReason } from "./retrieval/score";
import { TOKEN_MODEL, estimateTokens, truncateToTokens, usableTokenBudget } from "./tokens";

/**
 * Token-aware context engine (P3).
 *
 * Retrieval answers "what is relevant"; this module answers the question an agent
 * actually asks: *given this much room, what should I be told?* The two are not the
 * same job. A ranked list of 60 memories is useless to a caller with 2000 tokens,
 * and sending 100 memories when 8 would do is a cost the caller pays on every turn.
 *
 * The pipeline is the one P3 specifies, in order:
 *
 *   1. **retrieve** — `retrieveMemories`, whose graph leg already expands to the
 *      neighbours of the strongest hits, so expansion is not repeated here;
 *   2. **load** — full text for the shortlist only. The candidate pool deliberately
 *      carries `contentChars` instead of bodies, so this is the one place a memory's
 *      text is read, and only for rows that could plausibly be selected;
 *   3. **detect redundancy** — a lower-ranked memory that repeats what a selected one
 *      already says is dropped, with the id it duplicates recorded;
 *   4. **prioritize and pack** — greedy in rank order under a real token budget;
 *   5. **explain** — graph edges among the selected memories, contradictions that
 *      involve them, and provenance on request.
 *
 * The budget is enforced against {@link estimateTokens} over the *rendered text*,
 * not over a character count and not by summing per-part estimates: every candidate
 * block is measured against the text it would actually produce, so
 * `estimateTokens(contextText) <= usableBudget` holds by construction. The
 * tokenizer is the documented deterministic approximation in `tokens.ts`; the 10%
 * tolerance it reserves is what covers the difference against a real BPE vocabulary.
 *
 * Nothing here writes. Recording that a memory was selected is P10's job and
 * belongs to the caller that used it, not to the act of assembling context.
 */

type ContextDb = PostgresJsDatabase<typeof schema>;

export const CONTEXT_VERSION = "context-v1";

/** Budgets a caller may ask for. Defaults suit one agent turn, not a whole brain. */
export const CONTEXT_TOKEN_BUDGET_DEFAULT = 2_000;
export const CONTEXT_TOKEN_BUDGET_MIN = 200;
export const CONTEXT_TOKEN_BUDGET_MAX = 32_000;

export const CONTEXT_MAX_MEMORIES_DEFAULT = 12;
export const CONTEXT_MAX_MEMORIES_MAX = 40;

/**
 * How many ranked candidates get their text loaded, as a multiple of
 * `maxMemories`. Greater than one on purpose: redundancy and the budget both reject
 * candidates, and a shortlist with no slack would return fewer memories than asked
 * for whenever either one fires.
 */
export const SHORTLIST_FACTOR = 3;

/** Ceiling on one memory's share of the package, so a long body cannot own it. */
export const MEMORY_TOKENS_MAX = 220;
/** Below this a body is a fragment rather than knowledge; the memory is skipped. */
export const MEMORY_TOKENS_MIN = 40;

/** The echoed task line is a label, not a payload. */
export const TASK_ECHO_TOKENS = 40;

/**
 * Jaccard overlap of distinctive words above which a candidate is considered to say
 * what a selected memory already said. High on purpose: two memories about the same
 * subject are not redundant, two memories with the same *content* are.
 */
export const REDUNDANCY_THRESHOLD = 0.82;
/** Fewer distinctive words than this makes an overlap ratio meaningless. */
export const REDUNDANCY_MIN_WORDS = 6;
/** Words per memory that take part in the comparison. Bounds the pairwise cost. */
export const REDUNDANCY_WORDS_MAX = 200;

/** Reserved shares of the budget so the explanation sections always have room. */
export const GRAPH_SECTION_SHARE = 0.15;
export const CONTRADICTION_SECTION_SHARE = 0.1;
export const PROVENANCE_SECTION_SHARE = 0.12;

export const GRAPH_EDGE_MAX = 40;
export const GRAPH_ENTITY_MAX = 12;
export const CONTRADICTION_MAX = 10;
export const CONTEXT_OMITTED_MAX = 25;

export type ContextParams = {
  brainId: string;
  /** What the caller is trying to do. Drives retrieval; echoed back as a label. */
  task: string;
  tokenBudget?: number;
  maxMemories?: number;
  includeGraph?: boolean;
  includeProvenance?: boolean;
  projectId?: string | null;
  types?: readonly MemoryType[];
  /** Extra graph roots, e.g. the memory a caller is currently looking at. */
  seedMemoryIds?: readonly string[];
  now?: Date;
};

/** Why a ranked candidate is not in the package. Always one of these, never blank. */
export type ContextOmitReason =
  /** Did not make the shortlist retrieval loaded text for. */
  | "rank"
  /** `maxMemories` was already met by stronger candidates. */
  | "max_memories"
  /** Repeats what a selected memory already says. */
  | "redundant"
  /** What was left of the budget could not hold a useful amount of its text. */
  | "budget";

export type ContextOmission = {
  id: string;
  title: string;
  /** Position in the ranked retrieval, so "why not this one" is answerable. */
  rank: number;
  score: number;
  whyMatched: RetrievalReason[];
  reason: ContextOmitReason;
  /** The selected memory it duplicates. Set only when reason is `redundant`. */
  redundantWithId?: string;
  /** Tokens its body needed. Set only when reason is `budget`. */
  tokens?: number;
};

export type ContextProvenance = {
  sourceType: string;
  sourceId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  enrichedAt: Date | null;
  confidence: number;
  importance: number;
  confirmationCount: number;
  lastConfirmedAt: Date | null;
  validityState: string;
  supersededById: string | null;
};

export type ContextMemory = {
  id: string;
  type: string;
  title: string;
  /** The text that is actually in the package — already truncated if it had to be. */
  text: string;
  truncated: boolean;
  /** Tokens this memory's rendered block costs, under {@link TOKEN_MODEL}. */
  tokens: number;
  score: number;
  rank: number;
  whyMatched: RetrievalReason[];
  legs: RetrievalLeg[];
  /** Query entities this memory holds mention spans for. Evidence, not inference. */
  entities: { entityId: string; name: string; mentions: number }[];
  /** How the graph walk reached it, when it was the graph leg that found it. */
  graph: GraphEvidence | null;
  provenance?: ContextProvenance;
};

export type ContextGraph = {
  /**
   * Explicit memory→memory links where BOTH endpoints are in the package. An edge
   * to something the caller cannot see is a dangling reference, not context.
   */
  edges: { sourceId: string; targetId: string; linkType: string }[];
  /** Entity nodes more than one selected memory mentions, most-shared first. */
  entities: { entityId: string; name: string; type: string; memoryIds: string[] }[];
};

export type ContextPackage = {
  brainId: string;
  task: string;
  /** The tokenizer the estimates below come from, so a caller can calibrate. */
  tokenModel: string;
  /** What the caller asked for. */
  tokenBudget: number;
  /** What the packer was allowed to use, after the documented tolerance. */
  usableBudget: number;
  /** `estimateTokens(contextText)`. Never exceeds `usableBudget`. */
  tokensUsed: number;
  memories: ContextMemory[];
  omitted: ContextOmission[];
  graph: ContextGraph | null;
  /** Reported, never resolved (P6). Only pairs involving a selected memory. */
  contradictions: ConflictPair[];
  /** Size of the retrieval pool the selection was made from. */
  candidates: number;
  semanticAvailable: boolean;
  /** True when anything at all was dropped — for budget, redundancy or the cap. */
  truncated: boolean;
  /** The package as text, ready to drop into a prompt. */
  contextText: string;
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(raw, min), max);
}

/**
 * Distinctive words of a memory, for the redundancy comparison.
 *
 * The same stop-word list the graph model uses, so "two memories share a word" can
 * never mean "they both said `yang`". Bounded, because this feeds a pairwise loop.
 */
export function distinctiveWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return new Set(words.slice(0, REDUNDANCY_WORDS_MAX));
}

/** Overlap of two word sets, [0, 1]. Zero when either side is too small to judge. */
export function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size < REDUNDANCY_MIN_WORDS || b.size < REDUNDANCY_MIN_WORDS) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Full text plus the provenance scalars, for the shortlist only.
 *
 * The tenant scope is re-applied even though the ids came from retrieval: an id list
 * is not an authorization decision, and this is the statement that actually reads
 * memory bodies. `archivedAt` is deliberately not re-checked here — retrieval owns
 * that filter, and re-applying it would break `includeArchived`.
 */
const contextColumns = {
  id: memories.id,
  type: memories.type,
  title: memories.title,
  summary: memories.summary,
  content: memories.content,
  sourceType: memories.sourceType,
  sourceId: memories.sourceId,
  createdByUserId: memories.createdBy,
  createdByAgentId: memories.createdByAgent,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
  enrichedAt: memories.enrichedAt,
  confidence: memories.confidence,
  importance: memories.importance,
  confirmationCount: memories.confirmationCount,
  lastConfirmedAt: memories.lastConfirmedAt,
  validityState: memories.validityState,
  supersededById: memories.supersededById,
};

type ContextRow = {
  id: string;
  type: MemoryType;
  title: string;
  summary: string | null;
  content: string;
  sourceType: string;
  sourceId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  enrichedAt: Date | null;
  confidence: number;
  importance: number;
  confirmationCount: number;
  lastConfirmedAt: Date | null;
  validityState: string;
  supersededById: string | null;
};

async function loadContextRows(
  db: ContextDb,
  brainId: string,
  ids: readonly string[]
): Promise<Map<string, ContextRow>> {
  if (ids.length === 0) return new Map();

  const rows = (await db
    .select(contextColumns)
    .from(memories)
    .where(
      and(eq(memories.brainId, brainId), isNull(memories.deletedAt), inArray(memories.id, [...ids]))
    )) as ContextRow[];

  return new Map(rows.map((row) => [row.id, row]));
}

/** Explicit links whose two endpoints are both in the package. Bounded and ordered. */
async function loadContextEdges(
  db: ContextDb,
  brainId: string,
  ids: readonly string[]
): Promise<ContextGraph["edges"]> {
  if (ids.length < 2) return [];
  const selected = [...ids];

  const rows = await db
    .select({
      sourceId: memoryLinks.sourceMemoryId,
      targetId: memoryLinks.targetMemoryId,
      linkType: memoryLinks.linkType,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.targetType, "memory"),
        inArray(memoryLinks.sourceMemoryId, selected),
        inArray(memoryLinks.targetMemoryId, selected)
      )
    )
    .orderBy(asc(memoryLinks.createdAt), asc(memoryLinks.id))
    .limit(GRAPH_EDGE_MAX);

  return rows
    .filter((row): row is { sourceId: string; targetId: string; linkType: string } =>
      Boolean(row.targetId)
    )
    .map((row) => ({ sourceId: row.sourceId, targetId: row.targetId, linkType: row.linkType }));
}

/**
 * Entity nodes that more than one selected memory mentions.
 *
 * This is the part of the graph a caller cannot infer from the memories themselves:
 * it says which of them are talking about the same thing. Read from stored mention
 * spans, so every membership claim is backed by an offset in someone's text.
 */
async function loadSharedEntities(
  db: ContextDb,
  brainId: string,
  ids: readonly string[]
): Promise<ContextGraph["entities"]> {
  if (ids.length < 2) return [];

  const memoryIds = sql<string[]>`array_agg(distinct ${memoryMentions.memoryId})`;
  const shared = sql<number>`count(distinct ${memoryMentions.memoryId})::int`;

  const rows = await db
    .select({
      entityId: brainEntities.id,
      name: brainEntities.name,
      type: brainEntities.type,
      memoryIds,
    })
    .from(memoryMentions)
    .innerJoin(brainEntities, eq(brainEntities.id, memoryMentions.entityId))
    .where(
      and(
        eq(memoryMentions.brainId, brainId),
        eq(brainEntities.brainId, brainId),
        inArray(memoryMentions.memoryId, [...ids])
      )
    )
    .groupBy(brainEntities.id, brainEntities.name, brainEntities.type)
    .having(sql`count(distinct ${memoryMentions.memoryId}) > 1`)
    .orderBy(sql`${shared} desc`, asc(brainEntities.name))
    .limit(GRAPH_ENTITY_MAX);

  return rows.map((row) => ({
    entityId: row.entityId,
    name: row.name,
    type: row.type,
    // Sorted so the same graph renders identically on every request.
    memoryIds: [...(row.memoryIds ?? [])].sort(),
  }));
}

/**
 * The budget itself.
 *
 * Every append is measured against the *whole* rendering, not against the block in
 * isolation, because block estimates are not additive — a newline between two blocks
 * is itself a token. `tokens()` is therefore always exactly
 * `estimateTokens(text())`, which is the property the budget guarantee rests on.
 */
function budgetWriter(limit: number) {
  const parts: string[] = [];
  let tokens = 0;

  return {
    tokens: () => tokens,
    remaining: (cap = limit) => Math.max(0, Math.min(cap, limit) - tokens),
    /** Appends only if the result still fits. Returns the cost, or null if it did not. */
    tryAppend(block: string, cap = limit): number | null {
      const rendered = parts.length === 0 ? block : `${parts.join("\n")}\n${block}`;
      const total = estimateTokens(rendered);
      if (total > Math.min(cap, limit)) return null;
      parts.push(block);
      const cost = total - tokens;
      tokens = total;
      return cost;
    },
    text: () => parts.join("\n"),
  };
}

/**
 * The body of one memory, within an allowance.
 *
 * Preference order is content, then the author's own summary, then truncated
 * content. The summary is tried before truncation because a hand-written précis of
 * the whole memory beats the first 60% of it; truncation is the last resort, and
 * either way `truncated` records that the caller is not seeing everything.
 */
function memoryBody(row: ContextRow, allowance: number): { text: string; truncated: boolean } {
  const content = row.content.trim();
  if (estimateTokens(content) <= allowance) return { text: content, truncated: false };

  const summary = row.summary?.trim();
  if (summary && estimateTokens(summary) <= allowance) return { text: summary, truncated: true };

  return { text: truncateToTokens(content, allowance), truncated: true };
}

const MEMORY_HEADING = "Relevant memories (most relevant first):";

/**
 * One memory's headline: what it is, how strongly it matched, and why.
 *
 * `whyMatched` comes straight from the scorer, so the label is the audited reason
 * the memory is here — not a phrase written for the occasion.
 */
function memoryHeadline(
  item: { score: { score: number; whyMatched: RetrievalReason[] }; entityEvidence: { name: string }[] },
  position: number,
  row: ContextRow
): string {
  const why = item.score.whyMatched.length > 0 ? item.score.whyMatched.join(", ") : "quality";
  const entities = item.entityEvidence.slice(0, 3).map((entity) => entity.name);
  const evidence = entities.length > 0 ? ` · mentions ${entities.join(", ")}` : "";
  return `[${position}] (${row.type}) ${row.title} · relevance ${item.score.score.toFixed(
    2
  )} via ${why}${evidence}`;
}

/**
 * Append a section, dropping lines from the end until it fits.
 *
 * Trimming rather than skipping matters: a caller that asked for the graph should get
 * as much of it as the budget allows, and the return value says how much arrived.
 */
function appendSection(
  writer: ReturnType<typeof budgetWriter>,
  heading: string,
  lines: readonly string[]
): number {
  for (let count = lines.length; count > 0; count -= 1) {
    const block = ["", heading, ...lines.slice(0, count)].join("\n");
    if (writer.tryAppend(block) != null) return count;
  }
  return 0;
}

function isoDay(value: Date | null): string | null {
  if (!value) return null;
  const time = value instanceof Date ? value : new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}

function provenanceOf(row: ContextRow): ContextProvenance {
  return {
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    createdByUserId: row.createdByUserId,
    createdByAgentId: row.createdByAgentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    enrichedAt: row.enrichedAt,
    confidence: row.confidence,
    importance: row.importance,
    confirmationCount: row.confirmationCount,
    lastConfirmedAt: row.lastConfirmedAt,
    validityState: row.validityState,
    supersededById: row.supersededById,
  };
}

/** One provenance line per selected memory, keyed to its position in the package. */
function provenanceLine(position: number, provenance: ContextProvenance): string {
  const parts = [
    `[${position}]`,
    `source ${provenance.sourceType}${provenance.createdByAgentId ? " (agent)" : ""}`,
    `confidence ${provenance.confidence.toFixed(2)}`,
    `importance ${provenance.importance.toFixed(2)}`,
    provenance.validityState,
  ];
  const created = isoDay(provenance.createdAt);
  if (created) parts.push(`created ${created}`);
  if (provenance.confirmationCount > 0) parts.push(`confirmed ${provenance.confirmationCount}x`);
  if (provenance.supersededById) parts.push("superseded");
  if (!provenance.enrichedAt) parts.push("not yet enriched");
  return `- ${parts.join(" · ")}`;
}

/**
 * Build a token-bounded context package for one task.
 *
 * Read-only. The guarantee the caller gets is narrow and checkable:
 * `estimateTokens(contextText) <= usableTokenBudget(tokenBudget)`, with every
 * dropped candidate listed in `omitted` together with the reason it was dropped.
 */
export async function buildContext(
  db: ContextDb,
  params: ContextParams
): Promise<ContextPackage> {
  const task = (params.task ?? "").trim();
  const now = params.now ?? new Date();
  const tokenBudget = clampInt(
    params.tokenBudget,
    CONTEXT_TOKEN_BUDGET_DEFAULT,
    CONTEXT_TOKEN_BUDGET_MIN,
    CONTEXT_TOKEN_BUDGET_MAX
  );
  const usable = usableTokenBudget(tokenBudget);
  const maxMemories = clampInt(
    params.maxMemories,
    CONTEXT_MAX_MEMORIES_DEFAULT,
    1,
    CONTEXT_MAX_MEMORIES_MAX
  );

  const retrieval = await retrieveMemories(db, {
    brainId: params.brainId,
    query: task.length > 0 ? task : null,
    projectId: params.projectId,
    types: params.types,
    seedMemoryIds: params.seedMemoryIds,
    limit: Math.min(maxMemories * SHORTLIST_FACTOR, RESULT_LIMIT_MAX),
    now,
  });

  const rows = await loadContextRows(
    db,
    params.brainId,
    retrieval.results.map((item) => item.id)
  );

  // Contradictions are detected across the whole shortlist, not just the selection:
  // a memory that contradicts one being handed over is worth naming even when it did
  // not make the cut itself. Reported only — never resolved here (P6).
  const shortlistRows = retrieval.results
    .map((item) => rows.get(item.id))
    .filter((row): row is ContextRow => row != null);
  const conflicts = detectConflicts(shortlistRows, CONTRADICTION_MAX);

  // Reserved so the sections a caller explicitly asked for cannot be crowded out by
  // memory bodies. Reserve that goes unused is NOT handed back to the memories: a
  // second packing pass would make the selection depend on how big the graph turned
  // out to be, and the same request would stop returning the same package.
  const reserve =
    (params.includeGraph ? Math.floor(usable * GRAPH_SECTION_SHARE) : 0) +
    (conflicts.length > 0 ? Math.floor(usable * CONTRADICTION_SECTION_SHARE) : 0) +
    (params.includeProvenance ? Math.floor(usable * PROVENANCE_SECTION_SHARE) : 0);
  const memoryLimit = Math.max(0, usable - reserve);

  const writer = budgetWriter(usable);
  const header =
    task.length > 0
      ? `Brain context for task: "${truncateToTokens(task, TASK_ECHO_TOKENS)}"`
      : "Brain context:";
  writer.tryAppend(header);

  const omitted: ContextOmission[] = [];
  const selected: ContextMemory[] = [];
  const selectedWords: { id: string; words: Set<string> }[] = [];
  let dropped = false;

  const omit = (
    item: (typeof retrieval.results)[number],
    reason: ContextOmitReason,
    extra: { redundantWithId?: string; tokens?: number } = {}
  ) => {
    dropped = true;
    if (omitted.length >= CONTEXT_OMITTED_MAX) return;
    omitted.push({
      id: item.id,
      title: item.memory.title,
      rank: item.rank,
      score: item.score.score,
      whyMatched: item.score.whyMatched,
      reason,
      ...extra,
    });
  };

  for (const item of retrieval.results) {
    const row = rows.get(item.id);
    // The loader re-applies the tenant scope, so an id it did not return is one this
    // caller may not see. It is not an omission worth reporting — it never existed
    // for this request.
    if (!row) continue;

    if (selected.length >= maxMemories) {
      omit(item, "max_memories");
      continue;
    }

    const words = distinctiveWords(`${row.title}\n${row.summary ?? ""}\n${row.content}`);
    const duplicate = selectedWords.find(
      (candidate) => wordOverlap(candidate.words, words) >= REDUNDANCY_THRESHOLD
    );
    if (duplicate) {
      omit(item, "redundant", { redundantWithId: duplicate.id });
      continue;
    }

    // The heading rides along with the first memory, so a package that could not
    // afford a single body never renders a heading with nothing under it.
    const prefix = selected.length === 0 ? `${MEMORY_HEADING}\n` : "";
    const headline = memoryHeadline(item, selected.length + 1, row);
    const overhead = estimateTokens(`${prefix}${headline}`) + 2;
    const allowance = Math.min(MEMORY_TOKENS_MAX, writer.remaining(memoryLimit) - overhead);

    if (allowance < MEMORY_TOKENS_MIN) {
      omit(item, "budget", { tokens: estimateTokens(row.content) });
      continue;
    }

    const body = memoryBody(row, allowance);
    const block = `${prefix}${headline}\n${body.text}`;
    const cost = writer.tryAppend(block, memoryLimit);
    if (cost == null) {
      omit(item, "budget", { tokens: estimateTokens(block) });
      continue;
    }

    if (body.truncated) dropped = true;
    selected.push({
      id: row.id,
      type: row.type,
      title: row.title,
      text: body.text,
      truncated: body.truncated,
      tokens: cost,
      score: item.score.score,
      rank: item.rank,
      whyMatched: item.score.whyMatched,
      legs: item.legs,
      entities: item.entityEvidence.map((entity) => ({
        entityId: entity.entityId,
        name: entity.name,
        mentions: entity.mentions,
      })),
      graph: item.graphEvidence,
      provenance: params.includeProvenance ? provenanceOf(row) : undefined,
    });
    selectedWords.push({ id: row.id, words });
  }

  // Candidates that never reached the shortlist. Same reporting shape, so "why is X
  // not in my context" has one answer regardless of where X fell out.
  for (const item of retrieval.omitted) omit(item, "rank");

  if (selected.length === 0) {
    writer.tryAppend(
      retrieval.candidates > 0
        ? "(nothing fit the token budget)"
        : "(no memory in this brain matched)"
    );
  }

  const positions = new Map(selected.map((memory, index) => [memory.id, index + 1]));
  const selectedIds = selected.map((memory) => memory.id);

  let graph: ContextGraph | null = null;
  if (params.includeGraph) {
    const [edges, entities] = await Promise.all([
      loadContextEdges(db, params.brainId, selectedIds),
      loadSharedEntities(db, params.brainId, selectedIds),
    ]);
    graph = { edges, entities };

    // Positions, not ids: both endpoints are listed above with their titles, so this
    // stays readable without spending tokens on repeating a UUID twice per edge.
    const lines = [
      ...edges.map(
        (edge) =>
          `- [${positions.get(edge.sourceId)}] --${edge.linkType}--> [${positions.get(
            edge.targetId
          )}]`
      ),
      ...entities.map((entity) => {
        const where = entity.memoryIds
          .map((id) => positions.get(id))
          .filter((position) => position != null)
          .map((position) => `[${position}]`)
          .join(", ");
        return `- ${entity.name} (${entity.type}) mentioned in ${where}`;
      }),
    ];
    if (appendSection(writer, "Knowledge graph:", lines) < lines.length) dropped = true;
  }

  const selectedSet = new Set(selectedIds);
  const contradictions = conflicts.filter(
    (pair) => selectedSet.has(pair.memoryId) || selectedSet.has(pair.conflictsWithId)
  );

  if (contradictions.length > 0) {
    const lines = contradictions.map(
      (pair) =>
        `- "${pair.memoryTitle}" vs "${pair.conflictsWithTitle}" (overlap ${pair.overlap}): ${pair.reason}`
    );
    if (
      appendSection(writer, "Possible contradictions (reported, not resolved):", lines) <
      lines.length
    ) {
      dropped = true;
    }
  }

  if (params.includeProvenance && selected.length > 0) {
    const lines = selected.map((memory, index) =>
      provenanceLine(index + 1, memory.provenance ?? provenanceOf(rows.get(memory.id)!))
    );
    if (appendSection(writer, "Provenance:", lines) < lines.length) dropped = true;
  }

  const contextText = writer.text();

  return {
    brainId: params.brainId,
    task,
    tokenModel: TOKEN_MODEL,
    tokenBudget,
    usableBudget: usable,
    tokensUsed: writer.tokens(),
    memories: selected,
    omitted,
    graph,
    contradictions,
    candidates: retrieval.candidates,
    semanticAvailable: retrieval.semanticAvailable,
    truncated: dropped,
    contextText,
  };
}

/**
 * Service entry point, on the application's connection.
 *
 * The engine itself takes its database as an argument so it can be exercised without
 * one; callers that already have a request-scoped connection should keep using
 * {@link buildContext} directly.
 */
export function buildBrainContext(params: ContextParams): Promise<ContextPackage> {
  return buildContext(applicationDb, params);
}
