import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { APP_NAME } from "@/shared/lib/app-version";
import { publishToUser } from "@/shared/infrastructure/realtime/events";
import { BRAIN_ENTITY_TYPES, MEMORY_SOURCE_TYPES, MEMORY_TYPES } from "@brain/domain/constants";
import { BrainError } from "@brain/domain/errors";
import {
  deleteMemory,
  getMemory,
  getMemoryVersions,
  listBrainTags,
  listMemories,
  searchMemories,
  updateMemory,
} from "@brain/application/commands/memory-service";
import { listEntities, listRelationships, upsertEntity, upsertRelationship } from "@brain/application/queries/graph-service";
import {
  getMemoryLinks,
  linkMemory,
  type LinkTarget,
  type ResolvedLink,
} from "@brain/application/commands/link-service";
import { consolidateBrain } from "@brain/application/commands/consolidation-service";
import {
  CONTEXT_MAX_MEMORIES_MAX,
  CONTEXT_TOKEN_BUDGET_MAX,
  CONTEXT_TOKEN_BUDGET_MIN,
  buildBrainContext,
  type ContextPackage,
} from "@brain/application/queries/context-engine";
import { findBrainMemoryPath } from "@brain/application/queries/path-service";
import { getBrainRelatedMemories } from "@brain/application/queries/related-service";
import { getMemoryTimeline } from "@brain/application/queries/temporal-service";
import { getMemoryProvenance } from "@brain/application/queries/provenance-service";
import { getBrainHealth } from "@brain/application/queries/health-service";
import { syncBrainReviewQueue } from "@brain/application/commands/review-service";
import { recordMemoryFeedback } from "@brain/application/queries/feedback-loop";
import { listProjects } from "@brain/application/commands/project-service";
import { recallBrainContext } from "@brain/application/queries/recall";
import { rememberMemory } from "@brain/application/commands/remember";
import { requireGrant, type McpPrincipal } from "./principal";
import { getCached, setCached, invalidateBrainCache, CACHE_TTL } from "./cache";

/**
 * The Brain MCP tool surface.
 *
 * Every tool goes through requireGrant() and then the Brain service layer — never
 * SQL, never the REST API over HTTP, never a shortcut around authorization
 * (§23, §89). Results are compact: MCP output lands directly in an agent's
 * context window, so lists return summaries and ids to follow up with, not
 * whole documents (§25, §68).
 */

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  // Never leak SQL or stack traces to an agent (§69). Typed BrainErrors carry a
  // message meant for callers; anything else is reported generically and logged.
  if (error instanceof BrainError) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code }) }],
      isError: true,
    };
  }
  console.error("brain mcp tool failed", error);
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

/** Trim a memory down to what an agent needs to decide whether to read it fully. */
function summarize(memory: {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
  updatedAt: Date;
}) {
  const text = (memory.summary?.trim() || memory.content).replace(/\s+/g, " ").trim();
  return {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    snippet: text.length > 300 ? `${text.slice(0, 299)}…` : text,
    importance: memory.importance,
    confidence: memory.confidence,
    tags: memory.tags,
    updatedAt: memory.updatedAt.toISOString(),
  };
}

/** Cap on how many dropped candidates the MCP response reports. */
const MCP_OMITTED_MAX = 10;

/**
 * The context package, without repeating itself.
 *
 * `contextText` already holds every selected body, so the per-memory entries carry
 * only what an agent needs to act on one: where it sits in the text, why it is there,
 * and the ids to follow up with. Returning both copies would double the cost of the
 * very thing this tool exists to bound (§25, §68).
 */
function compactContext(context: ContextPackage) {
  return {
    task: context.task,
    tokenModel: context.tokenModel,
    tokenBudget: context.tokenBudget,
    usableBudget: context.usableBudget,
    tokensUsed: context.tokensUsed,
    truncated: context.truncated,
    candidates: context.candidates,
    semanticAvailable: context.semanticAvailable,
    contextText: context.contextText,
    memories: context.memories.map((memory, index) => ({
      position: index + 1,
      id: memory.id,
      type: memory.type,
      title: memory.title,
      relevance: Math.round(memory.score * 1000) / 1000,
      whyMatched: memory.whyMatched,
      matchedBy: memory.legs,
      tokens: memory.tokens,
      truncated: memory.truncated,
      entities: memory.entities,
      graph: memory.graph,
      provenance: memory.provenance,
    })),
    omitted: context.omitted.slice(0, MCP_OMITTED_MAX),
    omittedTotal: context.omitted.length,
    graph: context.graph,
    contradictions: context.contradictions,
  };
}

export function registerBrainMcpTools(server: McpServer, principal: McpPrincipal): void {
  // ── discovery ─────────────────────────────────────────────────────────────

  server.registerTool(
    "brain_list_brains",
    {
      description:
        "List the brains this credential may access, with the scopes granted on each. Call this first when you do not know which brain to use.",
      inputSchema: z.object({}),
    },
    async () =>
      ok({
        principal: {
          type: principal.type,
          agentName: principal.agentName,
        },
        brains: principal.grants.map((grant) => ({
          brainId: grant.brainId,
          name: grant.brainName,
          isDefault: grant.isDefault,
          scopes: grant.scopes,
        })),
      })
  );

  // ── recall / remember: the high-level protocol ─────────────────────────────

  server.registerTool(
    "brain_recall",
    {
      description:
        "Retrieve the long-term context you should know before starting a task: standing instructions, memories relevant to the task, important memories, recent changes, and related knowledge-graph nodes. Bounded in size — call this at the START of a session, then use brain_search for follow-ups.",
      inputSchema: z.object({
        ...brainIdArg,
        task: z
          .string()
          .max(500)
          .optional()
          .describe("What you are about to do, in a sentence. Drives relevance ranking."),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Narrow recall to one project. Standing instructions stay included either way."
          ),
        charBudget: z.number().int().min(500).max(20000).optional(),
      }),
    },
    async ({ brainId, task, projectId, charBudget }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const context = await recallBrainContext({
          brainId: grant.brainId,
          query: task,
          projectId,
          charBudget,
        });
        await audit(grant.brainId, "memory.recall", { task: task ?? null, projectId: projectId ?? null });
        return ok(context);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_context",
    {
      description:
        "Assemble a token-bounded context package for one task: the memories worth knowing, why each was chosen, what was left out and why, plus — on request — the graph edges between them, contradictions among them, and their provenance. Use this instead of brain_recall when you have a token budget to respect: `contextText` is measured with a documented tokenizer and never exceeds the budget you ask for. CACHED for 60s.",
      inputSchema: z.object({
        ...brainIdArg,
        task: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .describe("What you are about to do. Drives retrieval and ranking."),
        tokenBudget: z
          .number()
          .int()
          .min(CONTEXT_TOKEN_BUDGET_MIN)
          .max(CONTEXT_TOKEN_BUDGET_MAX)
          .optional()
          .describe("Tokens `contextText` may occupy. Defaults to 2000."),
        maxMemories: z
          .number()
          .int()
          .min(1)
          .max(CONTEXT_MAX_MEMORIES_MAX)
          .optional()
          .describe("Hard cap on memories returned, even if the budget allows more."),
        includeGraph: z
          .boolean()
          .optional()
          .describe("Add the explicit links and shared entities among the selected memories."),
        includeProvenance: z
          .boolean()
          .optional()
          .describe("Add source, confidence, confirmation and validity per memory."),
        projectId: z.string().uuid().optional().describe("Narrow the whole package to one project."),
        types: z.array(z.enum(MEMORY_TYPES)).min(1).max(MEMORY_TYPES.length).optional(),
        seedMemoryIds: z
          .array(z.string().uuid())
          .min(1)
          .max(8)
          .optional()
          .describe("Memories you are already looking at. Their graph neighbours are considered."),
      }),
    },
    async (args) => {
      try {
        const grant = requireGrant(principal, args.brainId, "brain.read");

        // Check cache first
        const cacheKey = {
          task: args.task,
          tokenBudget: args.tokenBudget,
          maxMemories: args.maxMemories,
          includeGraph: args.includeGraph,
          includeProvenance: args.includeProvenance,
          projectId: args.projectId,
          types: args.types,
          seedMemoryIds: args.seedMemoryIds,
        };
        const cached = getCached<ReturnType<typeof compactContext>>(
          "brain_context",
          grant.brainId,
          cacheKey
        );
        if (cached) {
          return ok({ ...cached, _cached: true });
        }

        const context = await buildBrainContext({
          brainId: grant.brainId,
          task: args.task,
          tokenBudget: args.tokenBudget,
          maxMemories: args.maxMemories,
          includeGraph: args.includeGraph,
          includeProvenance: args.includeProvenance,
          projectId: args.projectId,
          types: args.types,
          seedMemoryIds: args.seedMemoryIds,
        });

        const compacted = compactContext(context);

        // Cache the result
        setCached("brain_context", grant.brainId, cacheKey, compacted, CACHE_TTL.context);

        // Counts, not text: an audit row records that context was assembled, not what
        // the brain knows (§ no Brain content in audit logs unnecessarily).
        await audit(grant.brainId, "memory.context", {
          projectId: args.projectId ?? null,
          taskChars: args.task.length,
          tokenBudget: context.tokenBudget,
          tokensUsed: context.tokensUsed,
          selected: context.memories.length,
          omitted: context.omitted.length,
          truncated: context.truncated,
        });
        return ok(compacted);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_remember",
    {
      description:
        "Persist something worth keeping long-term. Checks for an existing memory with the same title and type and updates it instead of creating a duplicate; near-duplicates are reported back for you to judge. Only store durable knowledge — facts, decisions, preferences, procedures — not transient conversation.",
      inputSchema: z.object({
        ...brainIdArg,
        title: z.string().trim().min(1).max(300),
        content: z.string().min(1).max(200_000),
        type: z.enum(MEMORY_TYPES).optional().describe("Defaults to 'fact'."),
        summary: z.string().trim().max(1000).optional(),
        importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("0-1. Use >=0.7 only for durable identity/project-level knowledge."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("0-1. Lower it for inferences and observations rather than confirmed facts."),
        sourceType: z.enum(MEMORY_SOURCE_TYPES).optional(),
        sourceId: z.string().max(200).optional(),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe("Attach the memory to a project (see brain_list_projects)."),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
      }),
    },
    async ({ brainId, ...data }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.write");
        const outcome = await rememberMemory({
          brainId: grant.brainId,
          principal: { userId: principal.userId, agentId: principal.agentId },
          data,
        });

        // Invalidate cache on write
        invalidateBrainCache(grant.brainId);

        await audit(
          grant.brainId,
          outcome.mode === "created" ? "memory.create" : "memory.update",
          { via: "brain_remember", title: outcome.memory.title, type: outcome.memory.type }
        );
        await publishToUser(
          principal.userId,
          outcome.mode === "created"
            ? {
                type: "brain_memory_created",
                brainId: grant.brainId,
                memoryId: outcome.memory.id,
                title: outcome.memory.title,
              }
            : {
                type: "brain_memory_updated",
                brainId: grant.brainId,
                memoryId: outcome.memory.id,
              }
        );

        return ok({
          mode: outcome.mode,
          memory: summarize(outcome.memory),
          possibleDuplicates: outcome.possibleDuplicates,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── search / read ─────────────────────────────────────────────────────────

  server.registerTool(
    "brain_search",
    {
      description:
        "Full-text search the brain's memories, ranked by relevance. Returns compact summaries — follow up with brain_read for the full content of a specific memory.",
      inputSchema: z.object({
        ...brainIdArg,
        query: z.string().trim().min(1).max(300),
        type: z.enum(MEMORY_TYPES).optional(),
        projectId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        includeArchived: z.boolean().optional(),
      }),
    },
    async ({ brainId, query, type, projectId, limit, includeArchived }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.search");
        const results = await searchMemories({
          brainId: grant.brainId,
          query,
          type,
          projectId,
          limit: limit ?? 10,
          includeArchived,
        });
        await audit(grant.brainId, "memory.search", { query, hits: results.length });
        return ok({ query, count: results.length, results: results.map(summarize) });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_read",
    {
      description: "Read one memory in full, including its tags and provenance.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid(),
      }),
    },
    async ({ brainId, memoryId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const memory = await getMemory({ brainId: grant.brainId, memoryId });
        if (!memory) return fail(new BrainError("Memory not found", 404, "MEMORY_NOT_FOUND"));

        // This is the one tool that hands out a full body, so it is the one read that
        // most needs a row: the id and the tool, never the content (§ audit logs carry
        // no Brain content). Recorded before the feedback counter, so a feedback
        // failure can never lose the disclosure.
        await audit(grant.brainId, "memory.read", { via: "brain_read", memoryId });

        // Feedback signal (P10): this memory was opened in full. Bounded counters
        // only — the ranking adjustment saturates, so reads can never runaway-boost.
        await recordMemoryFeedback(
          grant.brainId,
          memoryId,
          "opened",
          principal.userId,
          principal.agentId,
          { tool: "brain_read" }
        );

        return ok({
          id: memory.id,
          type: memory.type,
          title: memory.title,
          content: memory.content,
          summary: memory.summary,
          importance: memory.importance,
          confidence: memory.confidence,
          tags: memory.tags,
          provenance: {
            sourceType: memory.sourceType,
            sourceId: memory.sourceId,
            createdByUser: memory.createdBy,
            createdByAgent: memory.createdByAgent,
          },
          version: memory.version,
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_get_recent",
    {
      description: "The most recently updated memories, newest first. Use to catch up on what changed.",
      inputSchema: z.object({
        ...brainIdArg,
        type: z.enum(MEMORY_TYPES).optional(),
        tag: z.string().trim().max(50).optional(),
        projectId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(200).optional(),
      }),
    },
    async ({ brainId, type, tag, projectId, limit, cursor }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const page = await listMemories({
          brainId: grant.brainId,
          type,
          tag,
          projectId,
          limit: limit ?? 10,
          cursor,
        });
        return ok({
          memories: page.memories.map(summarize),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_get_memory_history",
    {
      description:
        "Version history of one memory, newest version first. Nothing is ever overwritten, so this is the full audit trail of how a memory changed.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ brainId, memoryId, limit }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const versions = await getMemoryVersions({
          brainId: grant.brainId,
          memoryId,
          limit: limit ?? 20,
        });
        return ok({
          memoryId,
          versions: versions.map((version) => ({
            id: version.id,
            versionNumber: version.versionNumber,
            title: version.title,
            changeReason: version.changeReason,
            changedByUser: version.changedBy,
            changedByAgent: version.changedByAgent,
            createdAt: version.createdAt.toISOString(),
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_list_projects",
    {
      description:
        "Projects in this brain, with how many memories each holds. Agents usually work on a project — pass its id to brain_recall or brain_remember to keep context focused.",
      inputSchema: z.object({
        ...brainIdArg,
        status: z.enum(["active", "paused", "done", "archived"]).optional(),
      }),
    },
    async ({ brainId, status }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const projects = await listProjects({ brainId: grant.brainId, status });
        return ok({
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            status: project.status,
            description: project.description,
            memoryCount: project.memoryCount,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_list_tags",
    {
      description: "Every tag defined in the brain. Use to discover how this brain is organized.",
      inputSchema: z.object({ ...brainIdArg }),
    },
    async ({ brainId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const tags = await listBrainTags(grant.brainId);
        return ok({ tags: tags.map((tag) => tag.name) });
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── update / delete ───────────────────────────────────────────────────────

  server.registerTool(
    "brain_update",
    {
      description:
        "Amend an existing memory. The previous state is snapshotted as a version first, so corrections never destroy history. Prefer this over writing a second memory that contradicts the first.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid(),
        title: z.string().trim().min(1).max(300).optional(),
        content: z.string().min(1).max(200_000).optional(),
        summary: z.string().trim().max(1000).optional(),
        type: z.enum(MEMORY_TYPES).optional(),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        archived: z.boolean().optional().describe("Archive instead of deleting when a memory is no longer current."),
        changeReason: z.string().trim().max(300).optional().describe("Why you are changing it."),
      }),
    },
    async ({ brainId, memoryId, changeReason, ...data }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.write");
        const memory = await updateMemory({
          brainId: grant.brainId,
          memoryId,
          principal: { userId: principal.userId, agentId: principal.agentId },
          data,
          changeReason,
        });

        // Invalidate cache on write
        invalidateBrainCache(grant.brainId);

        await audit(grant.brainId, "memory.update", {
          via: "brain_update",
          fields: Object.keys(data),
          changeReason: changeReason ?? null,
        });
        await publishToUser(principal.userId, {
          type: "brain_memory_updated",
          brainId: grant.brainId,
          memoryId,
        });
        return ok({ memory: summarize(memory), version: memory.version });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_delete",
    {
      description:
        "Soft-delete a memory. Requires the brain.delete scope, which agents do not get by default. Consider brain_update with archived:true instead — archiving keeps the memory recoverable and searchable.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid(),
      }),
    },
    async ({ brainId, memoryId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.delete");
        const deleted = await deleteMemory({ brainId: grant.brainId, memoryId });
        if (!deleted) return fail(new BrainError("Memory not found", 404, "MEMORY_NOT_FOUND"));

        // Invalidate cache on write
        invalidateBrainCache(grant.brainId);

        await audit(grant.brainId, "memory.delete", { via: "brain_delete" });
        await publishToUser(principal.userId, {
          type: "brain_memory_deleted",
          brainId: grant.brainId,
          memoryId,
        });
        return ok({ deleted: true, memoryId });
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── knowledge graph ───────────────────────────────────────────────────────

  server.registerTool(
    "brain_get_entity",
    {
      description:
        "Find knowledge-graph nodes by name or type, or list them. Nodes are things the brain knows about: people, projects, technologies, organizations.",
      inputSchema: z.object({
        ...brainIdArg,
        search: z.string().trim().max(200).optional(),
        type: z.enum(BRAIN_ENTITY_TYPES).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ brainId, search, type, limit }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const entities = await listEntities({
          brainId: grant.brainId,
          search,
          type,
          limit: limit ?? 20,
        });
        return ok({
          entities: entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            type: entity.type,
            description: entity.description,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_get_related",
    {
      description:
        "The edges of the knowledge graph, optionally only those touching one node. Use to follow relationships outward from something you already found.",
      inputSchema: z.object({
        ...brainIdArg,
        entityId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ brainId, entityId, limit }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const relationships = await listRelationships({
          brainId: grant.brainId,
          entityId,
          limit: limit ?? 50,
        });
        return ok({
          relationships: relationships.map((relationship) => ({
            id: relationship.id,
            source: relationship.sourceName,
            type: relationship.relationshipType,
            target: relationship.targetName,
            confidence: relationship.confidence,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_link",
    {
      description:
        `Record that two things are related, creating the nodes by name if they do not exist yet. Example: '${APP_NAME}' --uses--> 'Cloudflare R2'. Re-linking the same pair and type updates it rather than duplicating.`,
      inputSchema: z.object({
        ...brainIdArg,
        source: z.string().trim().min(1).max(200).describe("Name of the source entity."),
        sourceType: z.enum(BRAIN_ENTITY_TYPES).optional(),
        target: z.string().trim().min(1).max(200).describe("Name of the target entity."),
        targetType: z.enum(BRAIN_ENTITY_TYPES).optional(),
        relationshipType: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe("A verb phrase: uses, requires, works_on, related_to, depends_on."),
        confidence: z.number().min(0).max(1).optional(),
      }),
    },
    async ({ brainId, source, sourceType, target, targetType, relationshipType, confidence }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.link");
        const [sourceEntity, targetEntity] = await Promise.all([
          upsertEntity({ brainId: grant.brainId, name: source, type: sourceType }),
          upsertEntity({ brainId: grant.brainId, name: target, type: targetType }),
        ]);
        const relationship = await upsertRelationship({
          brainId: grant.brainId,
          sourceEntityId: sourceEntity.id,
          targetEntityId: targetEntity.id,
          relationshipType,
          confidence,
        });
        await audit(grant.brainId, "relationship.upsert", {
          via: "brain_link",
          source: sourceEntity.name,
          target: targetEntity.name,
          relationshipType,
        });
        return ok({
          relationship: {
            id: relationship.id,
            source: sourceEntity.name,
            type: relationship.relationshipType,
            target: targetEntity.name,
          },
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_link_memory",
    {
      description:
        "Anchor a link on a memory: either to another memory (supersedes, contradicts, relates_to) or to a named entity the memory is about. Creates the entity by name if needed. Re-linking the same pair and verb updates it rather than duplicating.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid().describe("The memory the link starts from."),
        targetMemoryId: z
          .string()
          .uuid()
          .optional()
          .describe("Link to another memory. Provide this OR entity, not both."),
        entity: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Link to an entity by name; it is created if it does not exist."),
        entityType: z.enum(BRAIN_ENTITY_TYPES).optional(),
        linkType: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe("Verb for the edge: relates_to (default), supersedes, contradicts, mentions."),
      }),
    },
    async ({ brainId, memoryId, targetMemoryId, entity, entityType, linkType }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.link");

        if (Boolean(targetMemoryId) === Boolean(entity)) {
          return fail(
            new BrainError(
              "Provide exactly one of targetMemoryId or entity",
              400,
              "BRAIN_VALIDATION"
            )
          );
        }

        let target: LinkTarget;
        if (targetMemoryId) {
          target = { targetType: "memory", targetMemoryId };
        } else {
          const node = await upsertEntity({
            brainId: grant.brainId,
            name: entity!,
            type: entityType,
          });
          target = { targetType: "entity", targetEntityId: node.id };
        }

        const link = await linkMemory({
          brainId: grant.brainId,
          sourceMemoryId: memoryId,
          target,
          linkType,
          principal: { userId: principal.userId, agentId: principal.agentId },
        });

        // Invalidate cache on write
        invalidateBrainCache(grant.brainId);

        await audit(grant.brainId, "memory.linked", {
          via: "brain_link_memory",
          sourceMemoryId: memoryId,
          targetType: link.targetType,
          linkType: link.linkType,
        });
        await publishToUser(principal.userId, {
          type: "brain_memory_linked",
          brainId: grant.brainId,
          memoryId,
          linkId: link.id,
          targetType: link.targetType,
        });

        return ok({
          link: {
            id: link.id,
            memoryId,
            linkType: link.linkType,
            targetType: link.targetType,
            target: targetMemoryId ?? entity,
          },
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_get_backlinks",
    {
      description:
        "What else in the brain points at this memory, and what it points at. Use before superseding or contradicting a memory so the surrounding context is not lost.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid(),
      }),
    },
    async ({ brainId, memoryId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const links = await getMemoryLinks({ brainId: grant.brainId, memoryId });
        const shape = (link: ResolvedLink) => ({
          id: link.id,
          linkType: link.linkType,
          targetType: link.targetType,
          nodeId: link.nodeId,
          label: link.label,
          nodeType: link.nodeType,
        });
        return ok({
          relatedTo: links.relatedTo.map(shape),
          referencedBy: links.referencedBy.map(shape),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_path",
    {
      description:
        "Find an explainable path between two memories: the chain of links connecting them. Returns the sequence of hops (A --supersedes--> B --related_to--> C) or 'not found' if no path exists within the depth limit. Use to understand how concepts are connected.",
      inputSchema: z.object({
        ...brainIdArg,
        sourceMemoryId: z.string().uuid().describe("Starting memory id."),
        targetMemoryId: z.string().uuid().describe("Target memory id."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Maximum number of hops (default 5)."),
      }),
    },
    async ({ brainId, sourceMemoryId, targetMemoryId, maxDepth }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const result = await findBrainMemoryPath(
          grant.brainId,
          sourceMemoryId,
          targetMemoryId,
          maxDepth ?? 5
        );

        await audit(grant.brainId, "graph.path", {
          via: "brain_path",
          sourceMemoryId,
          targetMemoryId,
          found: result.found,
          hops: result.path.length,
        });

        if (!result.found) {
          return ok({
            found: false,
            message: `No path found from ${sourceMemoryId} to ${targetMemoryId} within ${maxDepth ?? 5} hops.`,
          });
        }

        return ok({
          found: true,
          path: result.path.map((hop) => ({
            source: { id: hop.source.id, title: hop.source.title, type: hop.source.type },
            relationshipType: hop.relationshipType,
            target: { id: hop.target.id, title: hop.target.title, type: hop.target.type },
            weight: hop.weight,
          })),
          distance: result.distance,
          hops: result.path.length,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_timeline",
    {
      description:
        "Show the evolution of one memory over time: when it was created, updated, accessed, confirmed, or superseded. Returns a chronological timeline of events. Use to understand how knowledge changed.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid().describe("Memory to show timeline for."),
      }),
    },
    async ({ brainId, memoryId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const timeline = await getMemoryTimeline(grant.brainId, memoryId);

        if (!timeline) {
          return ok({
            found: false,
            message: `Memory ${memoryId} not found in brain ${grant.brainId}.`,
          });
        }

        await audit(grant.brainId, "memory.timeline", {
          via: "brain_timeline",
          memoryId,
          events: timeline.events.length,
        });

        return ok({
          found: true,
          memoryId: timeline.memoryId,
          memoryTitle: timeline.memoryTitle,
          events: timeline.events.map((event) => ({
            timestamp: event.timestamp.toISOString(),
            eventType: event.eventType,
            version: event.version,
            supersededBy: event.supersededBy,
            changeReason: event.changeReason,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_related",
    {
      description:
        "Find memories related to a given memory. Merges asserted links, algorithmically derived relationships, graph proximity and retrieval into one ranked list. Every result carries `origin` — explicit (a user or agent stated it), inferred (several independent signals agreed), derived (one signal), graph (reachable via asserted links), retrieval (only answers a similar query) — plus `explicit`, and for derived results the weight, confidence, evidence and `status` behind them. A derived result with status `suggested` is below the auto-apply threshold: a hypothesis, ranked last among derived. Trust explicit over derived; treat derived as a hypothesis, not a fact.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid().describe("Memory to find relatives of."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of results (default 20)."),
        maxHops: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("Maximum graph distance (default 2)."),
        appliedOnly: z
          .boolean()
          .optional()
          .describe(
            "Return only derived relationships that cleared the apply threshold, dropping `suggested` ones (default false)."
          ),
      }),
    },
    async ({ brainId, memoryId, maxResults, maxHops, appliedOnly }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const related = await getBrainRelatedMemories(
          grant.brainId,
          memoryId,
          maxResults ?? 20,
          maxHops ?? 2,
          appliedOnly ?? false
        );

        await audit(grant.brainId, "memory.related", {
          via: "brain_related",
          memoryId,
          found: related.length,
        });

        return ok({
          memoryId,
          related: related.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            score: r.score,
            // Provenance first: an agent must be able to tell an assertion from a
            // guess without reading the score band table.
            origin: r.origin,
            explicit: r.explicit,
            reason: r.reason,
            linkType: r.linkType,
            hops: r.hops,
            weight: r.weight,
            confidence: r.confidence,
            // Derived only: `suggested` means the scorer stored it but does not
            // stand behind it. Without this an agent cannot tell the two apart.
            status: r.status,
            evidence: r.evidence,
            computedBy: r.computedBy,
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_explain",
    {
      description:
        "Explain where a memory came from: its creation source, authorship, confirmation history, quality signals, update lineage, supersession chain, and source memories it was derived from. Also lists `algorithmicInferences` — relationships the system computed rather than anyone asserting, each with its evidence and scorer version. Full provenance audit trail.",
      inputSchema: z.object({
        ...brainIdArg,
        memoryId: z.string().uuid().describe("Memory to explain."),
      }),
    },
    async ({ brainId, memoryId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const provenance = await getMemoryProvenance(grant.brainId, memoryId);

        if (!provenance) {
          return ok({
            found: false,
            message: `Memory ${memoryId} not found in brain ${grant.brainId}.`,
          });
        }

        await audit(grant.brainId, "memory.provenance", {
          via: "brain_explain",
          memoryId,
        });

        return ok({
          found: true,
          memoryId: provenance.memoryId,
          memoryTitle: provenance.memoryTitle,
          memoryType: provenance.memoryType,
          creation: {
            sourceType: provenance.sourceType,
            sourceId: provenance.sourceId,
            createdAt: provenance.createdAt.toISOString(),
            createdBy: provenance.createdBy,
            createdByUserId: provenance.createdByUserId,
            createdByAgentId: provenance.createdByAgentId,
            createdByAgentName: provenance.createdByAgentName,
          },
          quality: {
            confidence: provenance.confidence,
            importance: provenance.importance,
            confirmationCount: provenance.confirmationCount,
            lastConfirmedAt: provenance.lastConfirmedAt?.toISOString() ?? null,
            validityState: provenance.validityState,
          },
          evolution: {
            versionCount: provenance.versionCount,
            lastUpdated: provenance.lastUpdated.toISOString(),
            lastUpdatedBy: provenance.lastUpdatedBy,
            lastChangeReason: provenance.lastChangeReason,
          },
          relationships: {
            supersededBy: provenance.supersededBy,
            supersedes: provenance.supersedes,
            sourceMemories: provenance.sourceMemories,
          },
          // Kept out of `relationships` deliberately: everything above is something a
          // user or agent asserted, everything here is the system's own inference.
          algorithmicInferences: {
            note: "Computed by local scoring, not asserted by anyone. Treat as hypotheses.",
            count: provenance.derivedRelationships.length,
            relationships: provenance.derivedRelationships.map((r) => ({
              id: r.id,
              title: r.title,
              origin: r.origin,
              status: r.status,
              relation: r.relation,
              weight: r.weight,
              confidence: r.confidence,
              reason: r.reason,
              evidence: r.evidence,
              computedBy: r.computedBy,
              computedAt: r.computedAt.toISOString(),
            })),
          },
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_health",
    {
      description:
        "Analyze brain health: quality metrics, structural issues (orphans, weak links), and contradictions. Returns metrics and a list of issues ranked by severity. Read-only unless queueForReview is true, which persists the findings to the human review queue — it never resolves anything.",
      inputSchema: z.object({
        ...brainIdArg,
        staleDays: z
          .number()
          .int()
          .min(30)
          .max(365)
          .optional()
          .describe("Days since last access to consider stale (default 180)."),
        lowConfidenceThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Confidence below this is flagged (default 0.5)."),
        maxIssues: z
          .number()
          .int()
          .min(10)
          .max(200)
          .optional()
          .describe("Maximum issues to return (default 50)."),
        queueForReview: z
          .boolean()
          .optional()
          .describe(
            "Default false. When true, findings are written to the review queue and the brain.consolidate scope is required. Existing items are refreshed, never reopened."
          ),
      }),
    },
    async ({ brainId, staleDays, lowConfidenceThreshold, maxIssues, queueForReview }) => {
      try {
        const shouldQueue = queueForReview === true;
        // Reporting is a read; persisting a curation queue is a write, and takes the
        // same scope as the other bulk curation surface (§8).
        const grant = requireGrant(
          principal,
          brainId,
          shouldQueue ? "brain.consolidate" : "brain.read"
        );
        const health = await getBrainHealth(
          grant.brainId,
          staleDays ?? 180,
          lowConfidenceThreshold ?? 0.5,
          maxIssues ?? 50
        );

        const queued = shouldQueue ? await syncBrainReviewQueue(grant.brainId, health) : null;

        await audit(grant.brainId, "brain.health", {
          via: "brain_health",
          issueCount: health.issues.length,
          orphans: health.metrics.orphanMemories,
          contradictions: health.metrics.contradictionCount,
          ...(shouldQueue ? { queuedForReview: queued } : {}),
        });

        return ok({
          metrics: health.metrics,
          queuedForReview: queued ?? null,
          issues: health.issues.map((issue) => ({
            type: issue.type,
            severity: issue.severity,
            memoryId: issue.memoryId,
            memoryTitle: issue.memoryTitle,
            reason: issue.reason,
            ...(issue.conflictsWith ? { conflictsWith: issue.conflictsWith } : {}),
          })),
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_consolidate",
    {
      description:
        "Find duplicate memories and contradictions in the brain. Read-only unless apply is true, in which case duplicates are archived behind a surviving memory and contradictions are recorded as links. Nothing is ever deleted.",
      inputSchema: z.object({
        ...brainIdArg,
        apply: z
          .boolean()
          .optional()
          .describe("Default false. When true, requires the brain.consolidate scope."),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ brainId, apply, limit }) => {
      try {
        const shouldApply = apply === true;
        // A preview is a read; changing the brain in bulk needs its own scope (§8).
        const grant = requireGrant(
          principal,
          brainId,
          shouldApply ? "brain.consolidate" : "brain.read"
        );

        const report = await consolidateBrain({
          brainId: grant.brainId,
          principal: { userId: principal.userId, agentId: principal.agentId },
          apply: shouldApply,
          limit,
        });

        await audit(grant.brainId, shouldApply ? "brain.consolidated" : "brain.consolidate_preview", {
          apply: shouldApply,
          duplicateGroups: report.duplicates.length,
          conflicts: report.conflicts.length,
          archived: report.applied?.memoriesArchived ?? 0,
          via: "brain_consolidate",
        });

        if (shouldApply) {
          for (const pair of report.conflicts) {
            await publishToUser(principal.userId, {
              type: "brain_conflict_detected",
              brainId: grant.brainId,
              memoryId: pair.memoryId,
              conflictsWith: pair.conflictsWithId,
              reason: pair.reason,
            });
          }
        }

        return ok({
          scanned: report.scanned,
          truncated: report.truncated,
          duplicates: report.duplicates.map((group) => ({
            type: group.type,
            title: group.memories[0]?.title,
            keepId: group.memories[0]?.id,
            duplicateIds: group.memories.slice(1).map((item) => item.id),
          })),
          conflicts: report.conflicts,
          applied: report.applied,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  /**
   * One audit row, stamped with the principal and the transport it arrived over.
   *
   * Every caller awaits this *after* the work it describes has already happened, so a
   * failure here must not be reported as a failed tool call: the agent would retry a
   * write that already landed. `logBrainAudit` swallows its own errors; this is the
   * second belt, in case a future audit sink does not.
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
