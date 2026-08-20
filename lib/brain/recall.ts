import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brainEntities, brainRelationships, memories } from "@/lib/db/schema";
import { ftsMatchOn, ftsRankOn } from "@/lib/search/fts";

/**
 * brain_recall — "what long-term context should I know before doing this task?"
 *
 * This is the read side of the agent memory protocol. It is deliberately BOUNDED:
 * an agent's context window is the scarce resource, so recall returns a small,
 * ranked package rather than the brain. Every section has a row cap and every
 * text field is truncated, then the whole package is trimmed to a character
 * budget (§27, §59).
 *
 * Sections, in the order they earn their place in a prompt:
 *  1. directives  — instructions + preferences, the user's standing rules
 *  2. relevant    — full-text hits for the task at hand
 *  3. important   — high-importance memories regardless of the query
 *  4. recent      — what changed lately
 *  5. entities    — graph nodes matching the query, with their edges
 */

export const RECALL_CHAR_BUDGET = 6000;
const SNIPPET_CHARS = 400;
const DIRECTIVE_LIMIT = 8;
const RELEVANT_LIMIT = 8;
const IMPORTANT_LIMIT = 5;
const RECENT_LIMIT = 5;
const ENTITY_LIMIT = 8;
const IMPORTANT_THRESHOLD = 0.7;

export type RecalledMemory = {
  id: string;
  type: string;
  title: string;
  snippet: string;
  importance: number;
  confidence: number;
  updatedAt: string;
};

export type RecalledEntity = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  relationships: { type: string; direction: "outgoing" | "incoming"; entity: string }[];
};

export type RecallPackage = {
  brainId: string;
  projectId: string | null;
  query: string | null;
  directives: RecalledMemory[];
  relevant: RecalledMemory[];
  important: RecalledMemory[];
  recent: RecalledMemory[];
  entities: RecalledEntity[];
  truncated: boolean;
  contextText: string;
};

function snippet(memory: { summary: string | null; content: string }): string {
  const text = (memory.summary?.trim() || memory.content).replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
}

function toRecalled(row: {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  content: string;
  importance: number;
  confidence: number;
  updatedAt: Date;
}): RecalledMemory {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    snippet: snippet(row),
    importance: row.importance,
    confidence: row.confidence,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const recallColumns = {
  id: memories.id,
  type: memories.type,
  title: memories.title,
  summary: memories.summary,
  content: memories.content,
  importance: memories.importance,
  confidence: memories.confidence,
  updatedAt: memories.updatedAt,
};

/**
 * Live (not deleted, not archived) memories of this brain, optionally narrowed to
 * one project. Standing instructions and preferences deliberately IGNORE the
 * project filter — they are brain-wide rules that apply to every task.
 */
function liveMemories(brainId: string, projectId?: string | null) {
  return and(
    eq(memories.brainId, brainId),
    isNull(memories.deletedAt),
    isNull(memories.archivedAt),
    ...(projectId ? [eq(memories.projectId, projectId)] : [])
  );
}

export async function recallBrainContext(params: {
  brainId: string;
  query?: string;
  projectId?: string;
  charBudget?: number;
}): Promise<RecallPackage> {
  const { brainId } = params;
  const query = params.query?.trim() || null;
  const projectId = params.projectId ?? null;

  const [directiveRows, relevantRows, importantRows, recentRows] = await Promise.all([
    db
      .select(recallColumns)
      .from(memories)
      .where(and(liveMemories(brainId), inArray(memories.type, ["instruction", "preference"])))
      .orderBy(desc(memories.importance), desc(memories.updatedAt))
      .limit(DIRECTIVE_LIMIT),

    query
      ? db
          .select(recallColumns)
          .from(memories)
          .where(and(liveMemories(brainId, projectId), ftsMatchOn(memories.searchVector, query)))
          .orderBy(
            desc(ftsRankOn(memories.searchVector, query)),
            desc(memories.importance)
          )
          .limit(RELEVANT_LIMIT)
      : Promise.resolve([]),

    db
      .select(recallColumns)
      .from(memories)
      .where(
        and(
          liveMemories(brainId, projectId),
          sql`${memories.importance} >= ${IMPORTANT_THRESHOLD}`
        )
      )
      .orderBy(desc(memories.importance), desc(memories.updatedAt))
      .limit(IMPORTANT_LIMIT),

    db
      .select(recallColumns)
      .from(memories)
      .where(liveMemories(brainId, projectId))
      .orderBy(desc(memories.updatedAt))
      .limit(RECENT_LIMIT),
  ]);

  // Deduplicate across sections: a memory already shown as a directive or a
  // relevant hit must not burn budget again under "important" or "recent".
  const seen = new Set<string>();
  const take = (rows: typeof directiveRows): RecalledMemory[] => {
    const out: RecalledMemory[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(toRecalled(row));
    }
    return out;
  };

  const directives = take(directiveRows);
  const relevant = take(relevantRows);
  const important = take(importantRows);
  const recent = take(recentRows);
  const entities = query ? await recallEntities(brainId, query) : [];

  const budget = params.charBudget ?? RECALL_CHAR_BUDGET;
  const rendered = renderContext({ query, directives, relevant, important, recent, entities });
  const truncated = rendered.length > budget;

  return {
    brainId,
    projectId,
    query,
    directives,
    relevant,
    important,
    recent,
    entities,
    truncated,
    contextText: truncated ? `${rendered.slice(0, budget - 1)}…` : rendered,
  };
}

/**
 * Graph nodes whose name matches any word of the query, plus their edges. Uses a
 * word-boundary regex so "redis" matches the entity "Redis" without also dragging
 * in every node that merely contains those letters.
 */
async function recallEntities(brainId: string, query: string): Promise<RecalledEntity[]> {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  if (words.length === 0) return [];

  const pattern = `(^|[^[:alnum:]])(${words.join("|")})([^[:alnum:]]|$)`;
  const nodes = await db
    .select()
    .from(brainEntities)
    .where(
      and(
        eq(brainEntities.brainId, brainId),
        sql`${brainEntities.name} ~* ${pattern}`
      )
    )
    .orderBy(desc(brainEntities.updatedAt))
    .limit(ENTITY_LIMIT);

  if (nodes.length === 0) return [];

  const ids = nodes.map((node) => node.id);
  const edges = await db
    .select({
      sourceId: brainRelationships.sourceEntityId,
      targetId: brainRelationships.targetEntityId,
      type: brainRelationships.relationshipType,
    })
    .from(brainRelationships)
    .where(
      and(
        eq(brainRelationships.brainId, brainId),
        or(
          inArray(brainRelationships.sourceEntityId, ids),
          inArray(brainRelationships.targetEntityId, ids)
        )
      )
    )
    .limit(ENTITY_LIMIT * 5);

  // Resolve the far end of every edge, including nodes outside the matched set.
  const referenced = new Set<string>();
  for (const edge of edges) {
    referenced.add(edge.sourceId);
    referenced.add(edge.targetId);
  }
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const unknown = [...referenced].filter((id) => !names.has(id));
  if (unknown.length > 0) {
    const extra = await db
      .select({ id: brainEntities.id, name: brainEntities.name })
      .from(brainEntities)
      .where(and(eq(brainEntities.brainId, brainId), inArray(brainEntities.id, unknown)));
    for (const row of extra) names.set(row.id, row.name);
  }

  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    description: node.description,
    relationships: edges
      .filter((edge) => edge.sourceId === node.id || edge.targetId === node.id)
      .map((edge) => {
        const outgoing = edge.sourceId === node.id;
        const otherId = outgoing ? edge.targetId : edge.sourceId;
        return {
          type: edge.type,
          direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
          entity: names.get(otherId) ?? "unknown",
        };
      }),
  }));
}

/** Compact plain-text rendering an agent can drop straight into a system prompt. */
function renderContext(pkg: {
  query: string | null;
  directives: RecalledMemory[];
  relevant: RecalledMemory[];
  important: RecalledMemory[];
  recent: RecalledMemory[];
  entities: RecalledEntity[];
}): string {
  const lines: string[] = ["Brain context:"];

  const section = (heading: string, items: RecalledMemory[]) => {
    if (items.length === 0) return;
    lines.push("", heading);
    for (const item of items) {
      lines.push(`- [${item.type}] ${item.title}: ${item.snippet}`);
    }
  };

  section("Standing instructions and preferences:", pkg.directives);
  if (pkg.query) section(`Relevant to "${pkg.query}":`, pkg.relevant);
  section("Important long-term memories:", pkg.important);
  section("Recently updated:", pkg.recent);

  if (pkg.entities.length > 0) {
    lines.push("", "Related knowledge graph:");
    for (const entity of pkg.entities) {
      const edges = entity.relationships
        .map((rel) =>
          rel.direction === "outgoing"
            ? `--${rel.type}--> ${rel.entity}`
            : `<--${rel.type}-- ${rel.entity}`
        )
        .join("; ");
      lines.push(`- ${entity.name} (${entity.type})${edges ? ` ${edges}` : ""}`);
    }
  }

  if (lines.length === 1) lines.push("", "(this brain has no memories yet)");
  return lines.join("\n");
}
