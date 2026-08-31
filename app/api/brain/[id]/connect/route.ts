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
    const agents = await listAgentsForBrain(brainId, userId);

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
      },
      rest: {
        baseUrl: `${origin}/api/brain/${brainId}`,
        authentication: { type: "bearer", format: "Bearer sk_<agent key>" },
      },
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
