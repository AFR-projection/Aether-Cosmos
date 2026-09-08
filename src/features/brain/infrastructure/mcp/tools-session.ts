import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { BrainError } from "@brain/domain/errors";
import { MEMORY_TYPES } from "@brain/domain/constants";
import { TURN_ROLES } from "@brain/domain/ingest/salience";
import {
  MAX_CANDIDATES_PER_CALL,
  MAX_WRITES_PER_CALL,
  renderIngestReport,
} from "@brain/application/commands/ingest";
import { runBrainIngest } from "@brain/infrastructure/ingest-runner";
import {
  buildSessionStart,
  buildSessionTurn,
  MAX_EXCLUDE,
  SESSION_TURN_LIMIT,
} from "@brain/application/queries/session";
import { requireGrant, type McpPrincipal } from "./principal";

/**
 * The conversation-lifecycle tools: start, turn, end.
 *
 * These exist because the HTTP lifecycle endpoints are only reachable by a client that can
 * run shell hooks. Plenty cannot. Exposing the same three moments as tools means an agent
 * on any MCP client can drive the loop itself — call `brain_session_start` first, and
 * `brain_session_end` when the work is done — and the handshake instructions tell it to.
 *
 * A tool call is a worse trigger than a hook, because it depends on the model choosing to
 * make it. It is also strictly better than nothing, and the two paths share every line of
 * logic below the transport, so an agent that uses tools and one that uses hooks get
 * identical decisions.
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
  console.error("brain mcp session tool failed", error);
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

const turnArg = z.object({
  role: z.enum(TURN_ROLES).default("user"),
  text: z.string().min(1).max(20_000),
});

const candidateArg = z.object({
  title: z.string().trim().max(300).optional(),
  content: z.string().min(1).max(20_000),
  type: z.enum(MEMORY_TYPES).optional(),
  summary: z.string().trim().max(1000).optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  projectId: z.string().uuid().optional(),
});

export function registerBrainSessionTools(server: McpServer, principal: McpPrincipal): void {
  server.registerTool(
    "brain_session_start",
    {
      description:
        "Load this brain's long-term memory for a new conversation. Returns the standing instructions (which are binding), context for the stated topic, and a sessionId. Call this ONCE at the beginning — before asking the user anything — then keep the returned memoryIds and pass them to brain_session_turn as `exclude` so nothing is repeated.",
      inputSchema: z.object({
        ...brainIdArg,
        sessionId: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe("Reuse an id if you already have one; otherwise one is minted for you."),
        topic: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe("What this conversation is about. Drives the relevance half of the payload."),
        projectId: z.string().uuid().optional(),
      }),
    },
    async ({ brainId, sessionId, topic, projectId }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.read");
        const session = await buildSessionStart({
          brainId: grant.brainId,
          brainName: grant.brainName,
          sessionId,
          topic,
          projectId,
        });

        await audit(grant.brainId, "session.start", {
          via: "brain_session_start",
          sessionId: session.sessionId,
          topic: session.topic,
          directives: session.directiveCount,
          memories: session.memoryIds.length,
        });

        return ok({
          sessionId: session.sessionId,
          brainId: session.brainId,
          brainName: session.brainName,
          topic: session.topic,
          directiveCount: session.directiveCount,
          memoryIds: session.memoryIds,
          context: session.text,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_session_turn",
    {
      description:
        "Ask whether the brain knows anything about the message you just received, excluding what it has already told you this session. Returns at most a few short memories, and often nothing at all — an empty result means the brain has no opinion, not that you should search again. Cheaper than brain_search and safe to call every turn.",
      inputSchema: z.object({
        ...brainIdArg,
        sessionId: z.string().trim().max(200).optional(),
        prompt: z.string().max(20_000).describe("The user's message, verbatim."),
        exclude: z
          .array(z.string().uuid())
          .max(MAX_EXCLUDE)
          .optional()
          .describe("Memory ids you were already shown, from brain_session_start and earlier turns."),
        projectId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(SESSION_TURN_LIMIT).optional(),
      }),
    },
    async ({ brainId, sessionId, prompt, exclude, projectId, limit }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.search");
        const turn = await buildSessionTurn({
          brainId: grant.brainId,
          sessionId,
          prompt,
          exclude,
          projectId,
          limit,
        });
        // Deliberately not audited: this fires once per user message, and a row per turn
        // would bury the record of what an agent actually *did* under search noise.
        return ok({
          sessionId: turn.sessionId,
          found: turn.memories.length,
          memoryIds: turn.memoryIds,
          memories: turn.memories,
          context: turn.text,
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_session_end",
    {
      description:
        "Hand the conversation back to the brain so it can keep what was durable. Send the turns that mattered — decisions, rules, corrections, facts about the user — and the brain scores each one, drops the conversational ones, merges anything it already knows, and writes at most a handful. Returns a report explaining every decision. Use commit=false first if you want to see what it would keep. Requires the brain.ingest scope.",
      inputSchema: z.object({
        ...brainIdArg,
        sessionId: z.string().trim().max(200).optional(),
        turns: z
          .array(turnArg)
          .max(200)
          .optional()
          .describe("The transcript, oldest first. Only the tail is mined."),
        candidates: z
          .array(candidateArg)
          .max(MAX_CANDIDATES_PER_CALL)
          .optional()
          .describe("Skip the mining and name what should be kept yourself."),
        projectId: z.string().uuid().optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        maxWrites: z.number().int().min(0).max(MAX_WRITES_PER_CALL).optional(),
        commit: z.boolean().optional().describe("false decides everything and writes nothing."),
      }),
    },
    async ({ brainId, sessionId, turns, candidates, projectId, tags, maxWrites, commit }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.ingest");
        if (!turns?.length && !candidates?.length) {
          throw new BrainError("Provide at least one turn or candidate", 400, "VALIDATION_ERROR");
        }

        const report = await runBrainIngest({
          brainId: grant.brainId,
          userId: principal.userId,
          principal,
          operation: "session.end",
          turns,
          candidates,
          options: { sessionId, projectId, tags, maxWrites, commit },
          auditMetadata: { transport: "mcp", via: "brain_session_end" },
        });

        return ok({ report, summary: renderIngestReport(report) });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "brain_ingest",
    {
      description:
        "Same writeback pipeline as brain_session_end, for use mid-conversation: push material in as soon as it is settled rather than waiting for the end. Every gate is identical — salience, sampling, importance floor, fuzzy dedupe, write budget — and a merge never overwrites an existing memory. Requires the brain.ingest scope.",
      inputSchema: z.object({
        ...brainIdArg,
        sessionId: z.string().trim().max(200).optional(),
        turns: z.array(turnArg).max(200).optional(),
        candidates: z.array(candidateArg).max(MAX_CANDIDATES_PER_CALL).optional(),
        projectId: z.string().uuid().optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
        minSalience: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Raise to be stricter. Standing instructions always face a higher floor."),
        minImportance: z.number().min(0).max(1).optional(),
        sampleRate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fraction of candidates considered, decided deterministically from the text."),
        maxWrites: z.number().int().min(0).max(MAX_WRITES_PER_CALL).optional(),
        commit: z.boolean().optional(),
      }),
    },
    async ({ brainId, turns, candidates, ...options }) => {
      try {
        const grant = requireGrant(principal, brainId, "brain.ingest");
        if (!turns?.length && !candidates?.length) {
          throw new BrainError("Provide at least one turn or candidate", 400, "VALIDATION_ERROR");
        }

        const report = await runBrainIngest({
          brainId: grant.brainId,
          userId: principal.userId,
          principal,
          operation: "memory.ingest",
          turns,
          candidates,
          options,
          auditMetadata: { transport: "mcp", via: "brain_ingest" },
        });

        return ok({ report, summary: renderIngestReport(report) });
      } catch (error) {
        return fail(error);
      }
    }
  );

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
