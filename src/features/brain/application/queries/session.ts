import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { memories } from "@/shared/infrastructure/db/schema";
import { ftsMatchOn, ftsRankOn, hasSearchTerms } from "@/shared/lib/search/fts";
import { recallBrainContext, type RecallPackage } from "./recall";

/**
 * The conversation lifecycle: start, turn, end.
 *
 * MCP cannot push into a running conversation, so "the brain injects itself" has to be
 * driven from the client side — a hook that fires at a known moment and whose output the
 * host prepends to the prompt. This module builds the three payloads those moments need,
 * so a hook is one HTTP call and no logic.
 *
 * **No session table, and therefore no migration.** The only thing that lives for the
 * whole session is the client, so the client carries the state: `sessionId` for
 * correlation, and `exclude` — the memory ids it has already been shown. The server stays
 * stateless, which is the property that lets this run behind several app workers, and is
 * exactly why the MCP transport was made stateless in the first place.
 *
 * The per-turn payload is the one with a real cost, because it fires on every prompt.
 * Two things keep it affordable: it is capped at a few short memories, and it renders to
 * the empty string when it has nothing new to say. A hook that prints nothing costs
 * nothing, so the common case — a turn about something the brain has no opinion on — is
 * free rather than merely cheap.
 */

/** Budget for the session-start package. Smaller than a full recall: it lands in a prompt. */
export const SESSION_START_BUDGET = 5000;
/** Memories offered per turn. Three is enough to be useful and small enough to ignore. */
export const SESSION_TURN_LIMIT = 3;
/** Per-memory snippet length in a turn payload. */
export const TURN_SNIPPET_CHARS = 320;
/** Ceiling on how many ids a client may send back as "already seen". */
export const MAX_EXCLUDE = 200;

export type SessionStartPackage = {
  sessionId: string;
  brainId: string;
  brainName: string;
  projectId: string | null;
  topic: string | null;
  /** Everything the agent has now been shown — send this back as `exclude` on turns. */
  memoryIds: string[];
  directiveCount: number;
  /** Ready to prepend to a prompt. Empty only if the brain is empty. */
  text: string;
  recall: RecallPackage;
};

export type SessionTurnMemory = {
  id: string;
  type: string;
  title: string;
  snippet: string;
  importance: number;
};

export type SessionTurnPackage = {
  sessionId: string;
  /** New ids only. The client appends them to its `exclude` list for the next turn. */
  memoryIds: string[];
  memories: SessionTurnMemory[];
  /** `""` when there is nothing new — the whole point of the per-turn hook being cheap. */
  text: string;
};

/** A session id, when the client did not bring one. */
export function newSessionId(): string {
  return `sess_${randomUUID()}`;
}

/**
 * Everything the agent should know before its first substantive turn: the standing
 * rules, plus context for the stated topic. This is `brain_recall` with a session
 * wrapped around it — the wrapper is what makes the *next* call cheap, because the ids
 * returned here are the ids the per-turn call knows not to repeat.
 */
export async function buildSessionStart(params: {
  brainId: string;
  brainName: string;
  sessionId?: string | null;
  topic?: string | null;
  projectId?: string | null;
  charBudget?: number;
}): Promise<SessionStartPackage> {
  const sessionId = params.sessionId?.trim() || newSessionId();
  const topic = params.topic?.trim() || null;

  const recall = await recallBrainContext({
    brainId: params.brainId,
    query: topic ?? undefined,
    projectId: params.projectId ?? undefined,
    charBudget: params.charBudget ?? SESSION_START_BUDGET,
  });

  const memoryIds = [
    ...new Set([
      ...recall.directives.map((item) => item.id),
      ...recall.relevant.map((item) => item.id),
      ...recall.important.map((item) => item.id),
      ...recall.recent.map((item) => item.id),
    ]),
  ];

  const text = [
    `Long-term memory for brain "${params.brainName}" is loaded below (session ${sessionId}).`,
    "Treat the standing instructions as binding for the rest of this session, and the rest",
    "as background you already know. Do not re-fetch it turn by turn; use brain_search when",
    "you need something that is not here.",
    "",
    recall.contextText,
  ].join("\n");

  return {
    sessionId,
    brainId: params.brainId,
    brainName: params.brainName,
    projectId: params.projectId ?? null,
    topic,
    memoryIds,
    directiveCount: recall.directives.length,
    text,
    recall,
  };
}

/**
 * What the brain knows about *this* prompt, minus what it has already said.
 *
 * The AND-matching prefix query is right here, unlike in dedupe: a turn payload is
 * injected without anybody asking for it, so precision matters more than recall. A
 * wrong memory pushed into a prompt is worse than no memory at all — the agent cannot
 * tell that the brain guessed.
 */
export async function buildSessionTurn(params: {
  brainId: string;
  sessionId?: string | null;
  prompt: string;
  exclude?: readonly string[];
  projectId?: string | null;
  limit?: number;
}): Promise<SessionTurnPackage> {
  const sessionId = params.sessionId?.trim() || newSessionId();
  const prompt = params.prompt.trim();
  const limit = Math.max(1, Math.min(SESSION_TURN_LIMIT, params.limit ?? SESSION_TURN_LIMIT));
  const empty: SessionTurnPackage = { sessionId, memoryIds: [], memories: [], text: "" };

  if (!hasSearchTerms(prompt) || !/[\p{L}\p{N}]/u.test(prompt)) return empty;

  const exclude = [...new Set(params.exclude ?? [])].slice(0, MAX_EXCLUDE);
  const rows = await db
    .select({
      id: memories.id,
      type: memories.type,
      title: memories.title,
      summary: memories.summary,
      content: memories.content,
      importance: memories.importance,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, params.brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        ...(params.projectId ? [eq(memories.projectId, params.projectId)] : []),
        ...(exclude.length > 0 ? [notInArray(memories.id, exclude)] : []),
        ftsMatchOn(memories.searchVector, prompt)
      )
    )
    .orderBy(desc(ftsRankOn(memories.searchVector, prompt)), desc(memories.importance))
    .limit(limit);

  if (rows.length === 0) return empty;

  const found: SessionTurnMemory[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    snippet: clip((row.summary?.trim() || row.content).replace(/\s+/g, " ").trim()),
    importance: row.importance,
  }));

  return {
    sessionId,
    memoryIds: found.map((item) => item.id),
    memories: found,
    text: [
      "From your Second Brain, relevant to what was just asked:",
      ...found.map((item) => `- [${item.type}] ${item.title}: ${item.snippet}`),
    ].join("\n"),
  };
}

function clip(text: string): string {
  return text.length > TURN_SNIPPET_CHARS ? `${text.slice(0, TURN_SNIPPET_CHARS - 1)}…` : text;
}
