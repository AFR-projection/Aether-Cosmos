import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAgentInstructions } from "./instructions";
import { registerBrainMcpPrompts } from "./prompts";
import { registerBrainMcpTools } from "./tools";
import { registerAdvancedBrainMcpTools } from "./tools-advanced";
import { registerBrainSessionTools } from "./tools-session";
import type { McpPrincipal } from "./principal";

/**
 * The MCP server identity, and the key users put in their Claude Desktop config.
 *
 * Renaming this is a breaking change for anyone who already added the server: the
 * old key keeps working on their side but no longer matches what
 * `/api/brain/[id]/connect` hands out, so the snippet has to be re-pasted.
 */
export const BRAIN_MCP_SERVER_NAME = "aether-cosmos-brain";
export const BRAIN_MCP_SERVER_VERSION = "2.3.0";

/**
 * A server instance scoped to ONE authenticated principal.
 *
 * The principal is captured in the tool closures rather than read per call, so a
 * tool physically cannot be invoked without an authorization context. Combined
 * with the stateless transport (a fresh server per HTTP request) this removes the
 * shared-session state that the previous MCP implementation kept in a module-level
 * Map — which could not survive more than one Node process.
 *
 * Async because the handshake instructions now carry the user's own standing
 * instructions (see ./instructions.ts). That read is cached per brain and falls back
 * to the static protocol on any failure, so the cost per request is a cache hit and
 * the failure mode is a less helpful server rather than an unreachable one.
 */
export async function createBrainMcpServer(principal: McpPrincipal): Promise<McpServer> {
  const server = new McpServer(
    { name: BRAIN_MCP_SERVER_NAME, version: BRAIN_MCP_SERVER_VERSION },
    { instructions: await buildAgentInstructions(principal) }
  );

  registerBrainMcpTools(server, principal);
  registerAdvancedBrainMcpTools(server, principal);
  registerBrainSessionTools(server, principal);
  registerBrainMcpPrompts(server, principal);
  return server;
}
