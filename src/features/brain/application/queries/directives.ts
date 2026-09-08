import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { memories } from "@/shared/infrastructure/db/schema";

/**
 * Standing instructions — the user's rules, as a first-class read.
 *
 * A directive is a memory of type `instruction` or `preference`. They are not
 * retrieved like other memories: relevance never applies to them. "Always reply in
 * Indonesian" is not more or less relevant to a task about Postgres than to a task
 * about CSS, so filtering them by the query would silently drop the very rules the
 * agent is supposed to be following.
 *
 * Scope, and why it works this way:
 *  - A directive with no project is brain-wide and always applies.
 *  - A directive attached to a project applies when that project is the context, and
 *    OVERRIDES a brain-wide directive with the same title. That is the whole point of
 *    per-project rules: "commit style" can mean one thing here and another there.
 *  - With NO project named, every directive is returned, each labelled with its
 *    scope. Narrowing that would make a rule someone attached to a project vanish
 *    from every session that did not name the project — a silent loss of a rule the
 *    user believes is in force, which is worse than one extra line of context.
 */

/** How many directives may ride along. Beyond this the user has a config file, not rules. */
export const DIRECTIVE_LIMIT = 12;
/** Per-directive text cap. These land in a system prompt, so they stay short. */
const DIRECTIVE_CHARS = 320;

export type DirectiveScope = "brain" | "project";

export type StandingInstruction = {
  id: string;
  type: string;
  title: string;
  body: string;
  scope: DirectiveScope;
  projectId: string | null;
  importance: number;
  confidence: number;
  updatedAt: string;
};

/** Trimmed, collapsed, lowercased — the key a project directive overrides on. */
function overrideKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DIRECTIVE_CHARS ? `${flat.slice(0, DIRECTIVE_CHARS - 1)}…` : flat;
}

/** The two memory types that carry rules rather than facts. */
export const DIRECTIVE_TYPES = ["instruction", "preference"] as const;

/**
 * Resolves directives to the set actually in force, project overrides applied.
 *
 * Exported separately from the query so the ordering and override rules can be tested
 * without a database: this function is where the semantics live, and the query is
 * only how the rows arrive.
 */
export function resolveDirectives(
  rows: readonly {
    id: string;
    type: string;
    title: string;
    summary: string | null;
    content: string;
    projectId: string | null;
    importance: number;
    confidence: number;
    updatedAt: Date;
  }[],
  projectId: string | null
): StandingInstruction[] {
  const overridden = new Set<string>();
  if (projectId) {
    for (const row of rows) {
      if (row.projectId === projectId) overridden.add(overrideKey(row.title));
    }
  }

  const resolved: StandingInstruction[] = [];
  for (const row of rows) {
    // Loose null check on purpose: a row that arrived without the column at all is a
    // brain-wide rule, not a project one. Reading `undefined` as "scoped" would file
    // every rule under a project that does not exist and hide them all.
    const scoped = row.projectId != null;
    // A brain-wide rule the active project has restated is not in force here.
    if (projectId && !scoped && overridden.has(overrideKey(row.title))) continue;
    resolved.push({
      id: row.id,
      type: row.type,
      title: row.title,
      body: clip(row.summary?.trim() || row.content),
      scope: scoped ? "project" : "brain",
      projectId: row.projectId,
      importance: row.importance,
      confidence: row.confidence,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  // Project rules first — they are the more specific answer — then by importance.
  // Stable within a tier so two equally important rules keep the order they arrived.
  return resolved
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const scope = Number(b.item.scope === "project") - Number(a.item.scope === "project");
      if (scope !== 0) return scope;
      if (b.item.importance !== a.item.importance) return b.item.importance - a.item.importance;
      return a.index - b.index;
    })
    .map((entry) => entry.item)
    .slice(0, DIRECTIVE_LIMIT);
}

/**
 * The directives in force for a brain, optionally within a project.
 *
 * Deliberately its own query rather than a section of `recallBrainContext`: the same
 * rows now feed three surfaces — recall, the MCP handshake instructions, and the
 * session-start prompt — and three copies of "what counts as a standing instruction"
 * would drift apart within a release.
 */
export async function listStandingInstructions(params: {
  brainId: string;
  projectId?: string | null;
}): Promise<StandingInstruction[]> {
  const projectId = params.projectId ?? null;
  const rows = await db
    .select({
      id: memories.id,
      type: memories.type,
      title: memories.title,
      summary: memories.summary,
      content: memories.content,
      projectId: memories.projectId,
      importance: memories.importance,
      confidence: memories.confidence,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, params.brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        inArray(memories.type, [...DIRECTIVE_TYPES]),
        // With a project named, only that project's rules and the brain-wide ones are
        // candidates. With none, everything is — see the note at the top of the file.
        ...(projectId
          ? [or(isNull(memories.projectId), eq(memories.projectId, projectId))]
          : [])
      )
    )
    .orderBy(desc(memories.importance), desc(memories.updatedAt))
    // Fetch a little more than the cap: overrides can remove rows after the fact.
    .limit(DIRECTIVE_LIMIT * 3);

  return resolveDirectives(rows, projectId);
}

/**
 * Compact rendering for a system prompt. One line per rule, scope marked only when
 * it is a project rule — the common case needs no annotation, and a prefix on every
 * line would cost more tokens than it explains.
 */
export function renderDirectives(directives: readonly StandingInstruction[]): string {
  if (directives.length === 0) return "";
  return directives
    .map((item) => `- ${item.scope === "project" ? "[project] " : ""}${item.title}: ${item.body}`)
    .join("\n");
}

/** Count of rules in force, for the audit trail and the connect payload. */
export async function countStandingInstructions(brainId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        inArray(memories.type, [...DIRECTIVE_TYPES])
      )
    );
  return row?.total ?? 0;
}
