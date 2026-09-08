import { NextRequest } from "next/server";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { appPublicUrl } from "@/shared/lib/env/runtime";
import { requireBrainOwnerContext } from "@brain/infrastructure/access";
import { requireUuid } from "@brain/infrastructure/http";
import { listAgentsForBrain } from "@brain/application/commands/agent-service";
import { BRAIN_API_SCOPES, DEFAULT_BRAIN_AGENT_SCOPES } from "@brain/domain/constants";
import {
  BRAIN_MCP_SERVER_NAME,
  BRAIN_MCP_SERVER_VERSION,
} from "@brain/infrastructure/mcp/server";
import { BRAIN_MCP_PROMPTS } from "@brain/infrastructure/mcp/prompts";
import { buildBrainAgentTemplates } from "@brain/infrastructure/agent-templates";
import { countStandingInstructions } from "@brain/application/queries/directives";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/brain/[id]/connect — everything the user needs to point an external
 * agent at this brain, in copy-pasteable form.
 *
 * Deliberately contains NO secret: the agent key is shown once, at creation
 * (POST /api/brain/[id]/agents), and only its hash is stored (§43, §78).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { userId, brain } = await requireBrainOwnerContext(request, brainId, ["brain.read"]);

    const origin = appPublicUrl() || request.nextUrl.origin;
    const mcpUrl = `${origin}/api/brain/mcp`;
    const templates = buildBrainAgentTemplates({
      origin,
      brainId,
      brainName: brain.name,
      mcpUrl,
    });
    const [agents, standingInstructions] = await Promise.all([
      listAgentsForBrain(brainId, userId),
      countStandingInstructions(brainId),
    ]);

    return apiSuccess({
      brain: { id: brain.id, name: brain.name },
      mcp: {
        server: BRAIN_MCP_SERVER_NAME,
        version: BRAIN_MCP_SERVER_VERSION,
        transport: "streamable-http",
        url: mcpUrl,
        stateless: true,
        authentication: {
          type: "bearer",
          header: "Authorization",
          format: "Bearer sk_<agent key>",
          note: "Create an agent under this brain to mint a key. The key is shown once.",
        },
        // A generic mcpServers block: the shape most MCP clients accept today.
        // Clients that differ still have url + header above to work from.
        // Keyed off the constant, not a literal — the two drifted apart once
        // already, and a wrong key here is a config the user cannot connect with.
        exampleClientConfig: {
          mcpServers: {
            [BRAIN_MCP_SERVER_NAME]: {
              type: "http",
              url: mcpUrl,
              headers: { Authorization: "Bearer sk_YOUR_AGENT_KEY" },
            },
          },
        },
        exampleCurl: `curl -s -X POST "${mcpUrl}" -H "Authorization: Bearer sk_YOUR_AGENT_KEY" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        /**
         * How context reaches an agent without it having to remember to ask.
         *
         * MCP has no server-initiated push into a conversation, so there are exactly
         * two automatic paths and both are named here rather than left for the
         * integrator to discover: the handshake `instructions` string, which clients
         * place in the system prompt, and the prompts below, which clients surface as
         * commands. Anything beyond that is client-side configuration.
         */
        autoContext: {
          handshakeInstructions: {
            carriesStandingInstructions: true,
            standingInstructions,
            note: standingInstructions
              ? "The initialize result's `instructions` field already contains these rules; a connected agent has them before its first turn without calling a tool."
              : "No instruction/preference memories yet, so the handshake carries the protocol only. Save one with brain_remember (type=instruction or type=preference) and it will ride along from the next connection.",
            requiresScope: "brain.read",
          },
          prompts: BRAIN_MCP_PROMPTS.map((prompt) => ({
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            arguments: prompt.arguments,
            // How Claude Code names an MCP prompt in its command list.
            claudeCodeCommand: `/mcp__${BRAIN_MCP_SERVER_NAME}__${prompt.name}`,
          })),
        },
      },
      rest: {
        baseUrl: `${origin}/api/brain/${brainId}`,
        authentication: { type: "bearer", format: "Bearer sk_<agent key>" },
        lifecycle: templates.lifecycle.endpoints,
      },
      templates,
      scopes: {
        available: BRAIN_API_SCOPES,
        default: DEFAULT_BRAIN_AGENT_SCOPES,
      },
      connectedAgents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        scopes: agent.scopes,
        createdAt: agent.createdAt,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
