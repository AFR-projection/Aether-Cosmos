import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { MEMORY_TYPES } from "@brain/domain/constants";
import { BrainError } from "@brain/domain/errors";
import { searchMemories, listMemories } from "@brain/application/commands/memory-service";
import { buildBrainContext } from "@brain/application/queries/context-engine";
import { requireGrant, type McpPrincipal } from "./principal";

/**
 * Advanced MCP tools for sophisticated Brain operations (Phase 2 enhancement).
 *
 * These tools provide:
 * - Batch operations for efficiency
 * - Analytics and insights
 * - Query suggestions and memory recommendations
 * - Export/import for portability
 * - Semantic search status and controls
 *
 * Every tool respects the same authorization and audit trail as the core tools.
 */

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  if (error instanceof BrainError) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code }) }],
      isError: true,
    };
  }
  console.error("brain mcp advanced tool failed", error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "Internal error", code: "INTERNAL" }) }],
    isError: true,
  };
}

const brainIdArg = {
  brainId: z
    .string()
    .uuid()
    .optional()
    .describe("Target brain. Omit to use the default brain this credential can access."),
};

export function registerAdvancedBrainMcpTools(server: McpServer, principal: McpPrincipal): void {
  // ── batch operations ──────────────────────────────────────────────────────

  server.registerTool(
    "brain_batch_search",
    {
      description:
        "Execute multiple search queries in parallel and return aggregated results. More efficient than calling brain_search repeatedly. Use for exploring multiple related topics at once or validating query variations.",
      inputSchema: z.object({
        ...brainIdArg,
        queries: z
          .array(z.string().trim().min(1).max(300))
          .min(1)
          .max(10)
          .describe("List of search queries to execute in parallel."),
        limit: z.number().int().min(1).max(20).optional().describe("Results per query (default 5)."),
        deduplicate: z
          .boolean()
          .optional()
          .describe("Remove memories that appear in multiple result sets (default true)."),
      }),
    },
    async ({ brainId, queries, limit, deduplicate }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.search");
        const perQueryLimit = limit ?? 5;
        const shouldDedupe = deduplicate ?? true;

        // Execute all queries in parallel
        const results = await Promise.all(
          queries.map(async (query) => {
            const memories = await searchMemories({
              brainId: grant.brainId,
              query,
              limit: perQueryLimit,
            });
            return { query, count: memories.length, memories };
          })
        );

        // Deduplicate across result sets if requested
        const seen = new Set<string>();
        const deduped = results.map((result) => ({
          ...result,
          memories: result.memories
            .filter((m) => {
              if (!shouldDedupe) return true;
              if (seen.has(m.id)) return false;
              seen.add(m.id);
              return true;
            })
            .map((m) => ({
              id: m.id,
              type: m.type,
              title: m.title,
              snippet: (m.summary ?? m.content).slice(0, 200),
              importance: m.importance,
            })),
        }));

        await audit(grant.brainId, "memory.batch_search", {
          queries: queries.length,
          totalResults: deduped.reduce((sum, r) => sum + r.memories.length, 0),
        });

        return ok({
          results: deduped,
          totalQueries: queries.length,
          uniqueMemories: seen.size,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_batch_context",
    {
      description:
        "Build context packages for multiple tasks in parallel. Use when you have several independent subtasks and need focused context for each. Returns one package per task, each with its own token budget.",
      inputSchema: z.object({
        ...brainIdArg,
        tasks: z
          .array(
            z.object({
              task: z.string().trim().min(1).max(500),
              tokenBudget: z.number().int().min(200).max(8000).optional(),
            })
          )
          .min(1)
          .max(5)
          .describe("List of tasks to build context for."),
      }),
    },
    async ({ brainId, tasks }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");

        const contexts = await Promise.all(
          tasks.map(async ({ task, tokenBudget }) => {
            const context = await buildBrainContext({
              brainId: grant.brainId,
              task,
              tokenBudget: tokenBudget ?? 2000,
            });
            return {
              task,
              memoriesSelected: context.memories.length,
              tokensUsed: context.tokensUsed,
              truncated: context.truncated,
              // Don't return full contextText for batch - just metadata
              topMemories: context.memories.slice(0, 3).map((m) => ({
                id: m.id,
                title: m.title,
                relevance: m.score,
              })),
            };
          })
        );

        await audit(grant.brainId, "memory.batch_context", {
          tasks: tasks.length,
          totalMemories: contexts.reduce((sum, c) => sum + c.memoriesSelected, 0),
        });

        return ok({ contexts });
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── analytics and insights ────────────────────────────────────────────────

  server.registerTool(
    "brain_analytics",
    {
      description:
        "Get usage analytics and quality metrics for the brain: memory distribution by type, tag frequency, recency patterns, confidence distribution, and retrieval effectiveness. Read-only, no writes.",
      inputSchema: z.object({
        ...brainIdArg,
        period: z
          .enum(["7d", "30d", "90d", "all"])
          .optional()
          .describe("Time window for recency analysis (default '30d')."),
      }),
    },
    async ({ brainId, period }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");

        // Query memory distribution and quality metrics
        const [allMemories] = await Promise.all([
          listMemories({
            brainId: grant.brainId,
            limit: 1000, // Sample for analytics
          }),
        ]);

        const memories = allMemories.memories;

        // Compute distributions
        const byType = memories.reduce(
          (acc, m) => {
            acc[m.type] = (acc[m.type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        const byImportance = {
          high: memories.filter((m) => m.importance >= 0.7).length,
          medium: memories.filter((m) => m.importance >= 0.4 && m.importance < 0.7).length,
          low: memories.filter((m) => m.importance < 0.4).length,
        };

        const byConfidence = {
          high: memories.filter((m) => m.confidence >= 0.8).length,
          medium: memories.filter((m) => m.confidence >= 0.5 && m.confidence < 0.8).length,
          low: memories.filter((m) => m.confidence < 0.5).length,
        };

        // Tag frequency
        const tagFreq: Record<string, number> = {};
        memories.forEach((m) => {
          m.tags.forEach((tag) => {
            tagFreq[tag] = (tagFreq[tag] || 0) + 1;
          });
        });
        const topTags = Object.entries(tagFreq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([tag, count]) => ({ tag, count }));

        // Recency analysis
        const now = Date.now();
        const cutoff =
          period === "7d"
            ? 7 * 24 * 60 * 60 * 1000
            : period === "90d"
              ? 90 * 24 * 60 * 60 * 1000
              : 30 * 24 * 60 * 60 * 1000;

        const recentlyUpdated =
          period === "all"
            ? memories.length
            : memories.filter((m) => now - m.updatedAt.getTime() < cutoff).length;

        await audit(grant.brainId, "brain.analytics", { period: period ?? "30d" });

        return ok({
          summary: {
            totalMemories: memories.length,
            recentlyUpdated,
            period: period ?? "30d",
          },
          distribution: {
            byType,
            byImportance,
            byConfidence,
          },
          tags: {
            uniqueTags: Object.keys(tagFreq).length,
            topTags,
          },
          quality: {
            avgImportance: memories.reduce((sum, m) => sum + m.importance, 0) / memories.length || 0,
            avgConfidence: memories.reduce((sum, m) => sum + m.confidence, 0) / memories.length || 0,
          },
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_suggest_queries",
    {
      description:
        "Generate query suggestions based on recent brain activity, common patterns, and gaps in coverage. Use when you're not sure what to ask or want to explore what the brain knows about.",
      inputSchema: z.object({
        ...brainIdArg,
        context: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe("Optional context for tailored suggestions (e.g., 'authentication', 'deployment')."),
        limit: z.number().int().min(3).max(10).optional().describe("Number of suggestions (default 5)."),
      }),
    },
    async ({ brainId, context, limit }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");

        // Get recent memories and extract themes
        const recent = await listMemories({
          brainId: grant.brainId,
          limit: 50,
        });

        // Extract keywords from recent memories
        const keywords = new Set<string>();
        recent.memories.forEach((m) => {
          m.tags.forEach((tag) => keywords.add(tag));
          // Extract title words
          m.title
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .forEach((w) => keywords.add(w));
        });

        // Generate suggestions based on context or recent activity
        const suggestions: string[] = [];
        const keywordArray = Array.from(keywords).slice(0, 20);

        if (context) {
          suggestions.push(
            `What do we know about ${context}?`,
            `Recent changes related to ${context}`,
            `How does ${context} connect to other components?`,
            `Best practices for ${context}`
          );
        } else {
          // Generic explorations
          suggestions.push(
            "What are the most important decisions made recently?",
            "Show me high-confidence facts I should review",
            "What contradictions or conflicts exist?"
          );

          // Add tag-based suggestions
          if (keywordArray.length > 0) {
            suggestions.push(`What do we know about ${keywordArray[0]}?`);
            if (keywordArray.length > 1) {
              suggestions.push(`How does ${keywordArray[0]} relate to ${keywordArray[1]}?`);
            }
          }
        }

        await audit(grant.brainId, "brain.suggest_queries", { context: context ?? null });

        return ok({
          suggestions: suggestions.slice(0, limit ?? 5),
          basedOn: context ? "context" : "recent_activity",
          recentThemes: keywordArray.slice(0, 10),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── semantic search controls ──────────────────────────────────────────────

  server.registerTool(
    "brain_semantic_status",
    {
      description:
        "Check semantic search availability: whether embeddings are enabled, which provider/model is active, how many memories are embedded, and backfill progress. Read-only.",
      inputSchema: z.object({
        ...brainIdArg,
      }),
    },
    async ({ brainId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");

        // Import dynamically to avoid circular dependencies
        const { embeddingsAvailable } = await import("@brain/infrastructure/providers/resolve");
        const { getPublicEmbeddingConfig } = await import("@brain/infrastructure/providers/config");
        const { db } = await import("@/shared/infrastructure/db");
        const { eq, sql } = await import("drizzle-orm");
        const { memories } = await import("@/shared/infrastructure/db/schema");

        const [available, config, stats] = await Promise.all([
          embeddingsAvailable(),
          getPublicEmbeddingConfig(),
          db
            .select({
              total: sql<number>`count(*)::int`,
              embedded: sql<number>`count(*) FILTER (WHERE embedding IS NOT NULL)::int`,
            })
            .from(memories)
            .where(eq(memories.brainId, grant.brainId))
            .then((rows) => rows[0] || { total: 0, embedded: 0 }),
        ]);

        await audit(grant.brainId, "brain.semantic_status", {});

        return ok({
          available,
          config: {
            provider: config.provider,
            model: config.model,
            dimensions: config.dimensions,
            enabled: config.enabled,
            hasApiKey: config.hasApiKey,
          },
          stats: {
            totalMemories: stats.total,
            embedded: stats.embedded,
            pending: stats.total - stats.embedded,
            coverage: stats.total > 0 ? Math.round((stats.embedded / stats.total) * 100) : 0,
          },
          recommendation: available
            ? "Semantic search is enabled and ready. Use brain_context or brain_recall for best results."
            : config.enabled
              ? "Semantic search is enabled but not available. Check API key and model configuration."
              : "Semantic search is disabled. Enable it from /brain/settings to get semantic retrieval.",
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── export and portability ────────────────────────────────────────────────

  server.registerTool(
    "brain_export_memories",
    {
      description:
        "Export memories in a portable JSON format. Returns a snapshot of selected memories with all metadata, suitable for backup, migration, or external analysis. Does not include embeddings (those are provider-specific).",
      inputSchema: z.object({
        ...brainIdArg,
        type: z.enum(MEMORY_TYPES).optional().describe("Export only memories of this type."),
        projectId: z.string().uuid().optional().describe("Export only memories from this project."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum memories to export."),
        format: z.enum(["json", "markdown"]).optional().describe("Export format (default 'json')."),
      }),
    },
    async ({ brainId, type, projectId, limit, format }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");

        const memories = await listMemories({
          brainId: grant.brainId,
          type,
          projectId,
          limit: limit ?? 100,
        });

        const exportFormat = format ?? "json";

        if (exportFormat === "markdown") {
          // Export as markdown for readability
          const markdown = memories.memories
            .map((m) => {
              return [
                `# ${m.title}`,
                `**Type:** ${m.type}`,
                `**Importance:** ${m.importance} | **Confidence:** ${m.confidence}`,
                `**Tags:** ${m.tags.join(", ")}`,
                `**Updated:** ${m.updatedAt.toISOString()}`,
                "",
                m.summary || m.content,
                "",
                "---",
                "",
              ].join("\n");
            })
            .join("\n");

          await audit(grant.brainId, "memory.export", {
            count: memories.memories.length,
            format: "markdown",
          });

          return ok({
            format: "markdown",
            count: memories.memories.length,
            content: markdown,
          });
        }

        // JSON export with full metadata
        const exported = memories.memories.map((m) => ({
          id: m.id,
          type: m.type,
          title: m.title,
          content: m.content,
          summary: m.summary,
          importance: m.importance,
          confidence: m.confidence,
          tags: m.tags,
          createdAt: m.createdAt.toISOString(),
          updatedAt: m.updatedAt.toISOString(),
        }));

        await audit(grant.brainId, "memory.export", { count: exported.length, format: "json" });

        return ok({
          format: "json",
          count: exported.length,
          exportedAt: new Date().toISOString(),
          brainId: grant.brainId,
          memories: exported,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  /**
   * Audit helper - same pattern as tools.ts
   */
  async function audit(
    brainId: string,
    operation: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await logBrainAudit({
        brainId,
        principalType: principal.type,
        principalId: principal.id,
        operation,
        metadata: { ...metadata, transport: "mcp", agent: principal.agentName },
      });
    } catch (error) {
      console.error("brain mcp audit failed", { operation, error });
    }
  }
}
