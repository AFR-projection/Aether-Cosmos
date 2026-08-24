import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { files } from "@/lib/db/schema";

/**
 * Full-text search helpers over files.search_vector.
 *
 * We build a PREFIX tsquery so partial words match: typing "tat" finds "tattoo",
 * "inv rep" finds "invoice report", etc. Each whitespace-separated term becomes a
 * `term:*` prefix lexeme, all AND-ed together.
 *
 * Injection-safe: the raw query is passed as a bound parameter and never
 * concatenated into SQL. Inside Postgres we lowercase, split on whitespace, and
 * strip every non-alphanumeric character (POSIX `[^[:alnum:]]`) from each token
 * before handing it to `to_tsquery` — so tsquery operators the user might type
 * (`:& | ! ( )`) can't reach the parser and cause errors. POSIX classes are used
 * instead of `\w`/`\s` because backslash escapes are swallowed by Postgres string
 * literals.
 *
 * The 'simple' config matches the generated column in the schema (language-
 * agnostic, no stemming) which suits filenames + mixed-language content.
 */

const TS_CONFIG = "simple";

/** True when the query has at least one non-whitespace character. */
export function hasSearchTerms(q: string | undefined | null): q is string {
  return !!q && q.trim().length > 0;
}

/**
 * Builds `to_tsquery('simple', 'a:* & b:* …')` from free-text input, entirely
 * inside SQL so the user string stays a bound parameter. Returns a tsquery
 * expression usable by both the match (`@@`) and rank (`ts_rank`) helpers.
 *
 * If every token strips down to empty (e.g. the query is all punctuation), the
 * inner aggregate is NULL → `@@ NULL` is NULL → no rows match, which is the
 * desired "nothing found" behaviour.
 */
export function prefixTsQuery(q: string): SQL {
  return sql`to_tsquery(${TS_CONFIG}, (
    SELECT string_agg(t || ':*', ' & ')
    FROM (
      SELECT regexp_replace(word, '[^[:alnum:]]', '', 'g') AS t
      FROM unnest(regexp_split_to_array(lower(trim(${q})), '[[:space:]]+')) AS word
    ) tokens
    WHERE t <> ''
  ))`;
}

/**
 * Same construction as {@link prefixTsQuery} but OR-ing the lexemes instead of
 * AND-ing them: `to_tsquery('simple', 'a:* | b:* …')`.
 *
 * PHASE 2 (relate candidate probes) needs "any of these terms" recall, not the
 * "all of these terms" precision the search box wants. Feeding a whole memory
 * title+summary through the AND variant matches essentially nothing, which is
 * exactly the wrong behaviour for a candidate generator.
 *
 * Same injection story as the AND variant: `q` stays a bound parameter and every
 * token is stripped to `[[:alnum:]]` inside Postgres before reaching the parser.
 */
export function anyPrefixTsQuery(q: string): SQL {
  return sql`to_tsquery(${TS_CONFIG}, (
    SELECT string_agg(t || ':*', ' | ')
    FROM (
      SELECT regexp_replace(word, '[^[:alnum:]]', '', 'g') AS t
      FROM unnest(regexp_split_to_array(lower(trim(${q})), '[[:space:]]+')) AS word
    ) tokens
    WHERE t <> ''
  ))`;
}

/**
 * A `tsvector @@ to_tsquery(...)` prefix-match condition for the WHERE clause,
 * against any generated tsvector column (files, memories, ...).
 */
export function ftsMatchOn(column: SQLWrapper, q: string): SQL {
  return sql`${column} @@ ${prefixTsQuery(q)}`;
}

/** WHERE-clause condition matching ANY term in `q` (see {@link anyPrefixTsQuery}). */
export function ftsAnyMatchOn(column: SQLWrapper, q: string): SQL {
  return sql`${column} @@ ${anyPrefixTsQuery(q)}`;
}

/** Relevance score for the OR variant, for ORDER BY. Pair with ftsAnyMatchOn. */
export function ftsAnyRankOn(column: SQLWrapper, q: string): SQL<number> {
  return sql<number>`ts_rank(${column}, ${anyPrefixTsQuery(q)})`;
}

/**
 * Relevance score (ts_rank) for ORDER BY against any tsvector column.
 * Higher = more relevant. Pair with ftsMatchOn so only matching rows are ranked.
 */
export function ftsRankOn(column: SQLWrapper, q: string): SQL<number> {
  return sql<number>`ts_rank(${column}, ${prefixTsQuery(q)})`;
}

/**
 * A `tsvector @@ to_tsquery(...)` prefix-match condition for the WHERE clause.
 */
export function ftsMatch(q: string): SQL {
  return ftsMatchOn(files.searchVector, q);
}

/**
 * Relevance score (ts_rank) for ORDER BY. Higher = more relevant.
 * Pair with ftsMatch so only matching rows are ranked.
 */
export function ftsRank(q: string): SQL<number> {
  return ftsRankOn(files.searchVector, q);
}
