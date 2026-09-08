import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listStandingInstructions, renderDirectives } from "@brain/application/queries/directives";
import { recallBrainContext } from "@brain/application/queries/recall";
import { requireGrant, type McpPrincipal } from "./principal";

/**
 * MCP prompts — the brain as something the user can invoke, not only something the
 * agent can call.
 *
 * Tools are for the model; prompts are for the human. Clients surface them as
 * commands: Claude Code lists them as `/mcp__aether-cosmos-brain__<name>`. That
 * matters here because the gap this feature closes is an agent forgetting to load
 * context — and a person typing a slash command cannot forget on the agent's behalf,
 * but they can do it in one keystroke instead of asking in prose.
 *
 * Prompt arguments are strings by protocol, so `topic` arrives as text and is passed
 * to recall as the relevance query. No new scope: every prompt here is a read, gated
 * on `brain.read` through the same `requireGrant` choke point the tools use.
 *
 * One SDK constraint shapes the registrations below: when a prompt declares an
 * `argsSchema`, the SDK parses `params.arguments` against it *strictly*, so a client
 * that omits the field entirely — which the spec permits, since arguments are optional
 * — gets "Invalid arguments" instead of a result. A prompt that takes nothing therefore
 * declares no schema at all rather than an empty one.
 */

/** A prompt result is one user-role message the client drops into the conversation. */
function message(text: string) {
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

/**
 * The advertised prompt surface, exported so `/api/brain/[id]/connect` can hand the
 * names out without restating them. A config snippet that names a prompt this server
 * does not register is a support ticket, so there is one list.
 */
export const BRAIN_MCP_PROMPTS = [
  {
    name: "session_start",
    title: "Load brain context for this session",
    description:
      "Load the user's standing instructions plus the long-term context relevant to what you are about to work on. Run this before the first substantive turn of a session.",
    arguments: ["topic"],
  },
  {
    name: "standing_instructions",
    title: "Re-read the user's standing instructions",
    description:
      "The user's rules and preferences, with nothing else attached. Useful mid-session when the rules have drifted out of attention, or after they have been changed.",
    arguments: [],
  },
] as const;

export function registerBrainMcpPrompts(server: McpServer, principal: McpPrincipal): void {
  server.registerPrompt(
    BRAIN_MCP_PROMPTS[0].name,
    {
      title: BRAIN_MCP_PROMPTS[0].title,
      description: BRAIN_MCP_PROMPTS[0].description,
      argsSchema: {
        topic: z
          .string()
          .max(500)
          .optional()
          .describe("What this session is about, in a sentence. Drives relevance ranking."),
      },
    },
    async ({ topic }) => {
      const grant = requireGrant(principal, undefined, "brain.read");
      const context = await recallBrainContext({
        brainId: grant.brainId,
        query: topic?.trim() || undefined,
      });
      return message(
        [
          `Long-term memory for brain "${grant.brainName}" is loaded below.`,
          "Treat the standing instructions as binding for the rest of this session, and",
          "the rest as background you already know. Do not re-fetch it turn by turn;",
          "use brain_search when you need something that is not here.",
          "",
          context.contextText,
        ].join("\n")
      );
    }
  );

  server.registerPrompt(
    BRAIN_MCP_PROMPTS[1].name,
    {
      title: BRAIN_MCP_PROMPTS[1].title,
      description: BRAIN_MCP_PROMPTS[1].description,
    },
    async () => {
      const grant = requireGrant(principal, undefined, "brain.read");
      const directives = await listStandingInstructions({ brainId: grant.brainId });
      if (directives.length === 0) {
        return message(
          [
            `Brain "${grant.brainName}" has no standing instructions recorded.`,
            "If the user states a durable preference or gives a working rule, save it with",
            "brain_remember (type=preference or type=instruction) so it survives this session.",
          ].join("\n")
        );
      }
      return message(
        [
          `Standing instructions in force for brain "${grant.brainName}". Follow them:`,
          "",
          renderDirectives(directives),
        ].join("\n")
      );
    }
  );
}
