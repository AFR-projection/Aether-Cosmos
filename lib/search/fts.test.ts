import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { memories } from "@/lib/db/schema";
import { ftsMatchOn, ftsRankOn, hasSearchTerms, prefixTsQuery } from "@/lib/search/fts";

const dialect = new PgDialect();

function compile(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(query);
}

describe("prefixTsQuery", () => {
  it("never inlines the user's text — it is always a bound parameter", () => {
    const evil = "'; DROP TABLE memories; --";
    const { sql, params } = compile(prefixTsQuery(evil));

    expect(params).toContain(evil);
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).toContain("to_tsquery");
  });

  it("strips tsquery operators inside Postgres rather than in JS", () => {
    // The tokenizing/stripping happens in SQL (regexp_replace on [^[:alnum:]]), so
    // a query of pure punctuation yields NULL — no rows — instead of the tsquery
    // `":*"`, which Postgres rejects with a syntax error (a 500 per keystroke).
    const { sql } = compile(prefixTsQuery("!!! ((("));
    expect(sql).toContain("regexp_replace");
    expect(sql).toContain("WHERE t <> ''");
  });
});

describe("ftsMatchOn / ftsRankOn", () => {
  it("targets the column it is handed, not a hardcoded table", () => {
    const match = compile(ftsMatchOn(memories.searchVector, "hello"));
    expect(match.sql).toContain('"search_vector"');
    expect(match.sql).toContain("@@");
    expect(match.params).toContain("hello");

    const rank = compile(ftsRankOn(memories.searchVector, "hello"));
    expect(rank.sql).toContain("ts_rank");
    expect(rank.sql).toContain('"search_vector"');
  });
});

describe("hasSearchTerms", () => {
  it("treats whitespace-only input as no search", () => {
    expect(hasSearchTerms("  ")).toBe(false);
    expect(hasSearchTerms("")).toBe(false);
    expect(hasSearchTerms(null)).toBe(false);
    expect(hasSearchTerms(undefined)).toBe(false);
    expect(hasSearchTerms("a")).toBe(true);
  });
});
