import type { GraphNode } from "./types";

/**
 * The filter/group query language.
 *
 * Obsidian's graph filter is one text box that also drives group colours, so the
 * same compiled query has to serve both. Grammar, deliberately tiny:
 *
 *   word              substring of label / detail / tag
 *   "two words"       same, quoted so the space is kept
 *   type:person       entity type or memory type
 *   kind:memory       node kind (memory | entity)
 *   tag:release        memory tag
 *   project:apollo    project name (substring)
 *   is:orphan         no visible edge      is:linked   at least one
 *   -term             negation, on any of the above
 *
 * Terms are ANDed. An empty query matches everything, which is what makes the
 * default "no filter" state free.
 */

export type FilterField = "text" | "type" | "kind" | "tag" | "project" | "is";

export type FilterTerm = {
  field: FilterField;
  value: string;
  negate: boolean;
};

export type CompiledQuery = {
  raw: string;
  terms: FilterTerm[];
  /** True when the query cannot exclude anything, so callers can skip the walk. */
  matchesEverything: boolean;
};

export const EMPTY_QUERY: CompiledQuery = { raw: "", terms: [], matchesEverything: true };

const FIELDS: Record<string, FilterField> = {
  type: "type",
  kind: "kind",
  tag: "tag",
  project: "project",
  is: "is",
};

/** Splits on whitespace but keeps "quoted phrases" together. */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const token = match[1] ?? match[2] ?? "";
    if (token) tokens.push(token);
  }
  return tokens;
}

export function parseGraphQuery(raw: string): CompiledQuery {
  const trimmed = raw.trim();
  if (!trimmed) return { ...EMPTY_QUERY, raw };

  const terms: FilterTerm[] = [];
  for (const token of tokenize(trimmed)) {
    const negate = token.startsWith("-") && token.length > 1;
    const body = negate ? token.slice(1) : token;

    const separator = body.indexOf(":");
    if (separator > 0) {
      const field = FIELDS[body.slice(0, separator).toLowerCase()];
      const value = body.slice(separator + 1).trim().toLowerCase();
      // `type:` with nothing after it is a half-typed query, not a filter that
      // matches nothing — dropping it keeps the graph stable while typing.
      if (field && value) {
        terms.push({ field, value, negate });
        continue;
      }
      if (field) continue;
    }

    terms.push({ field: "text", value: body.toLowerCase(), negate });
  }

  return { raw, terms, matchesEverything: terms.length === 0 };
}

function termMatches(term: FilterTerm, node: GraphNode, degree: number): boolean {
  switch (term.field) {
    case "text":
      return node.searchText.includes(term.value);
    case "type":
      return node.type === term.value;
    case "kind":
      return node.kind === term.value;
    case "tag":
      return node.tags.some((tag) => tag.toLowerCase() === term.value);
    case "project":
      return !!node.projectName && node.projectName.toLowerCase().includes(term.value);
    case "is":
      if (term.value === "orphan") return degree === 0;
      if (term.value === "linked") return degree > 0;
      if (term.value === "memory") return node.kind === "memory";
      if (term.value === "entity") return node.kind === "entity";
      return false;
    default:
      return false;
  }
}

/**
 * `degree` is passed in rather than read off the node because `is:orphan` has to
 * mean "no *visible* edge" — the count changes as other filters hide neighbours.
 */
export function matchesQuery(
  query: CompiledQuery,
  node: GraphNode,
  degree: number
): boolean {
  if (query.matchesEverything) return true;
  for (const term of query.terms) {
    const hit = termMatches(term, node, degree);
    if (term.negate ? hit : !hit) return false;
  }
  return true;
}

/** Human-readable echo of a query, for the group chips in the sidebar. */
export function describeQuery(query: CompiledQuery): string {
  if (query.matchesEverything) return "every node";
  return query.terms
    .map((term) => {
      const body = term.field === "text" ? `“${term.value}”` : `${term.field}:${term.value}`;
      return term.negate ? `not ${body}` : body;
    })
    .join(" · ");
}
