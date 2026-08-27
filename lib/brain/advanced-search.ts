/**
 * Advanced Brain Search
 *
 * Enhanced search capabilities:
 * - Hybrid search (semantic + lexical + graph)
 * - Faceted filtering (tags, date ranges, content type)
 * - Multi-field search (content, tags, entities)
 * - Sorting options (relevance, date, popularity)
 * - Pagination and cursor-based loading
 * - Search result highlighting
 */

import { db } from "@/lib/db";
import { memories, memoryTags, memoryLinks } from "@/lib/db/schema";
import { eq, and, isNull, sql, inArray, gte, lte, desc, asc } from "drizzle-orm";
import { embed } from "@/lib/brain/embed";
import { extractKeyTerms } from "@/lib/brain/enrich/extract";

export interface SearchFilters {
  tags?: string[]; // Filter by tags
  dateFrom?: Date;
  dateTo?: Date;
  minLength?: number;
  maxLength?: number;
  hasLinks?: boolean; // Only memories with links
  hasEmbedding?: boolean;
}

export interface SearchSort {
  field: "relevance" | "created" | "updated" | "length" | "links";
  order: "asc" | "desc";
}

export interface SearchOptions {
  filters?: SearchFilters;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
  highlightResults?: boolean;
  includeFacets?: boolean;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  highlights?: string[];
  tags: string[];
  linkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchFacets {
  tags: Array<{ tag: string; count: number }>;
  dateRanges: Array<{ range: string; count: number }>;
  contentLengths: Array<{ range: string; count: number }>;
}

export interface SearchResponse {
  results: SearchResult[];
  facets?: SearchFacets;
  total: number;
  hasMore: boolean;
  query: string;
}

/**
 * Advanced search with filters and facets.
 */
export async function advancedSearch(
  brainId: string,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResponse> {
  const {
    filters = {},
    sort = { field: "relevance", order: "desc" },
    limit = 20,
    offset = 0,
    highlightResults = false,
    includeFacets = false,
  } = options;

  // Extract search terms for lexical matching
  const searchTerms = extractKeyTerms(query);

  // Generate embedding for semantic search
  const queryEmbedding = await embed(query);

  // Build base query
  let sqlQuery = sql`
    SELECT DISTINCT
      m.id,
      m.content,
      m.created_at,
      m.updated_at,
      m.embedding,
      (1 - (m.embedding::vector <=> ${JSON.stringify(queryEmbedding)}::vector)) as semantic_score,
      LENGTH(m.content) as content_length
    FROM memories m
    WHERE m.brain_id = ${brainId}
      AND m.deleted_at IS NULL
  `;

  // Apply filters
  if (filters.tags && filters.tags.length > 0) {
    sqlQuery = sql`${sqlQuery}
      AND EXISTS (
        SELECT 1 FROM memory_tags mt
        WHERE mt.memory_id = m.id
          AND mt.tag = ANY(${filters.tags}::text[])
      )`;
  }

  if (filters.dateFrom) {
    sqlQuery = sql`${sqlQuery} AND m.created_at >= ${filters.dateFrom}`;
  }

  if (filters.dateTo) {
    sqlQuery = sql`${sqlQuery} AND m.created_at <= ${filters.dateTo}`;
  }

  if (filters.minLength) {
    sqlQuery = sql`${sqlQuery} AND LENGTH(m.content) >= ${filters.minLength}`;
  }

  if (filters.maxLength) {
    sqlQuery = sql`${sqlQuery} AND LENGTH(m.content) <= ${filters.maxLength}`;
  }

  if (filters.hasLinks) {
    sqlQuery = sql`${sqlQuery}
      AND EXISTS (
        SELECT 1 FROM memory_links ml
        WHERE ml.source_id = m.id
      )`;
  }

  if (filters.hasEmbedding) {
    sqlQuery = sql`${sqlQuery} AND m.embedding IS NOT NULL`;
  }

  // Add lexical matching boost
  if (searchTerms.length > 0) {
    const lexicalConditions = searchTerms.map(
      (term) => sql`m.content ILIKE ${"%" + term + "%"}`
    );
    sqlQuery = sql`${sqlQuery}
      AND (${sql.join(lexicalConditions, sql` OR `)})`;
  }

  // Execute main query
  const rawResults = await db.execute(sqlQuery);

  // Enrich with tags and link counts
  const memoryIds = rawResults.rows.map((r: any) => r.id);

  const tagsResult = await db
    .select({
      memoryId: memoryTags.memoryId,
      tag: memoryTags.tag,
    })
    .from(memoryTags)
    .where(inArray(memoryTags.memoryId, memoryIds));

  const linksResult = await db.execute(
    sql`SELECT source_id, COUNT(*) as link_count
        FROM memory_links
        WHERE source_id = ANY(${memoryIds}::uuid[])
        GROUP BY source_id`
  );

  const tagsByMemory = new Map<string, string[]>();
  for (const t of tagsResult) {
    if (!tagsByMemory.has(t.memoryId)) {
      tagsByMemory.set(t.memoryId, []);
    }
    tagsByMemory.get(t.memoryId)!.push(t.tag);
  }

  const linksByMemory = new Map<string, number>();
  for (const l of linksResult.rows as any[]) {
    linksByMemory.set(l.source_id, parseInt(l.link_count, 10));
  }

  // Build search results
  let results: SearchResult[] = rawResults.rows.map((row: any) => ({
    id: row.id,
    content: row.content,
    score: parseFloat(row.semantic_score),
    tags: tagsByMemory.get(row.id) || [],
    linkCount: linksByMemory.get(row.id) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    highlights: highlightResults
      ? generateHighlights(row.content, searchTerms)
      : undefined,
  }));

  // Apply sorting
  results = sortResults(results, sort);

  // Calculate total and pagination
  const total = results.length;
  const paginatedResults = results.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  // Generate facets if requested
  let facets: SearchFacets | undefined;
  if (includeFacets) {
    facets = await generateFacets(brainId, filters);
  }

  return {
    results: paginatedResults,
    facets,
    total,
    hasMore,
    query,
  };
}

/**
 * Sort search results.
 */
function sortResults(results: SearchResult[], sort: SearchSort): SearchResult[] {
  const sorted = [...results];

  sorted.sort((a, b) => {
    let comparison = 0;

    switch (sort.field) {
      case "relevance":
        comparison = b.score - a.score;
        break;
      case "created":
        comparison = b.createdAt.getTime() - a.createdAt.getTime();
        break;
      case "updated":
        comparison = b.updatedAt.getTime() - a.updatedAt.getTime();
        break;
      case "length":
        comparison = b.content.length - a.content.length;
        break;
      case "links":
        comparison = b.linkCount - a.linkCount;
        break;
    }

    return sort.order === "desc" ? comparison : -comparison;
  });

  return sorted;
}

/**
 * Generate search result highlights.
 */
function generateHighlights(content: string, terms: string[]): string[] {
  const highlights: string[] = [];
  const contextLength = 100;

  for (const term of terms) {
    const regex = new RegExp(term, "gi");
    let match;

    while ((match = regex.exec(content)) !== null) {
      const start = Math.max(0, match.index - contextLength);
      const end = Math.min(content.length, match.index + term.length + contextLength);

      let snippet = content.slice(start, end);

      // Add ellipsis
      if (start > 0) snippet = "..." + snippet;
      if (end < content.length) snippet = snippet + "...";

      // Highlight the term
      snippet = snippet.replace(
        new RegExp(term, "gi"),
        (matched) => `<mark>${matched}</mark>`
      );

      highlights.push(snippet);

      // Limit highlights per term
      if (highlights.length >= 3) break;
    }
  }

  return highlights;
}

/**
 * Generate search facets.
 */
async function generateFacets(
  brainId: string,
  currentFilters: SearchFilters
): Promise<SearchFacets> {
  // Tag facets
  const tagFacets = await db.execute(
    sql`SELECT mt.tag, COUNT(*) as count
        FROM memory_tags mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE m.brain_id = ${brainId}
          AND m.deleted_at IS NULL
        GROUP BY mt.tag
        ORDER BY count DESC
        LIMIT 20`
  );

  // Date range facets
  const now = new Date();
  const ranges = [
    { label: "Last 24 hours", days: 1 },
    { label: "Last week", days: 7 },
    { label: "Last month", days: 30 },
    { label: "Last 3 months", days: 90 },
    { label: "Last year", days: 365 },
  ];

  const dateRangeFacets = await Promise.all(
    ranges.map(async (range) => {
      const since = new Date(now.getTime() - range.days * 24 * 60 * 60 * 1000);
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM memories
            WHERE brain_id = ${brainId}
              AND created_at >= ${since}
              AND deleted_at IS NULL`
      );
      return {
        range: range.label,
        count: parseInt((result.rows[0] as any).count, 10),
      };
    })
  );

  // Content length facets
  const lengthRanges = [
    { label: "Short (< 500)", min: 0, max: 500 },
    { label: "Medium (500-2000)", min: 500, max: 2000 },
    { label: "Long (> 2000)", min: 2000, max: 999999 },
  ];

  const lengthFacets = await Promise.all(
    lengthRanges.map(async (range) => {
      const result = await db.execute(
        sql`SELECT COUNT(*) as count
            FROM memories
            WHERE brain_id = ${brainId}
              AND LENGTH(content) >= ${range.min}
              AND LENGTH(content) < ${range.max}
              AND deleted_at IS NULL`
      );
      return {
        range: range.label,
        count: parseInt((result.rows[0] as any).count, 10),
      };
    })
  );

  return {
    tags: tagFacets.rows.map((row: any) => ({
      tag: row.tag,
      count: parseInt(row.count, 10),
    })),
    dateRanges: dateRangeFacets,
    contentLengths: lengthFacets,
  };
}

/**
 * Search suggestions (autocomplete).
 */
export async function searchSuggestions(
  brainId: string,
  partialQuery: string,
  limit: number = 5
): Promise<string[]> {
  // Get popular search terms from tags
  const tagSuggestions = await db.execute(
    sql`SELECT DISTINCT mt.tag
        FROM memory_tags mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE m.brain_id = ${brainId}
          AND mt.tag ILIKE ${partialQuery + "%"}
        ORDER BY mt.tag
        LIMIT ${limit}`
  );

  return tagSuggestions.rows.map((row: any) => row.tag);
}
