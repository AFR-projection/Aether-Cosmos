import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBrainMcpTools } from "./tools";
import type { McpPrincipal } from "./principal";

export const BRAIN_MCP_SERVER_NAME = "storage-byafr-brain";
export const BRAIN_MCP_SERVER_VERSION = "2.0.0";

/**
 * A server instance scoped to ONE authenticated principal.
 *
 * The principal is captured in the tool closures rather than read per call, so a
 * tool physically cannot be invoked without an authorization context. Combined
 * with the stateless transport (a fresh server per HTTP request) this removes the
 * shared-session state that the previous MCP implementation kept in a module-level
 * Map — which could not survive more than one Node process.
 */
export function createBrainMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer(
    { name: BRAIN_MCP_SERVER_NAME, version: BRAIN_MCP_SERVER_VERSION },
    {
      instructions: [
        "This is the user's Second Brain: their permanent, portable long-term memory.",
        "",
        "Protocol:",
        "1. Call brain_recall once at the start of a task to load standing instructions and relevant context.",
        "   With a token budget to respect, call brain_context instead: same purpose, but bounded in",
        "   tokens and it tells you why each memory was chosen and what was left out.",
        "2. Use brain_search / brain_read while working to look things up.",
        "3. Call brain_remember only for knowledge worth keeping permanently — facts, decisions,",
        "   preferences, procedures, project context. Not transient conversation.",
        "4. Use brain_update to correct an existing memory instead of writing a contradicting one.",
        "5. Use brain_link_memory to create explicit relationships between memories.",
        "   Use brain_link to record entity relationships the brain should know about.",
        "",
        "Retrieval notes:",
        "- Semantic search is OFF by default (embeddings disabled). Retrieval uses lexical (FTS),",
        "  entity overlap, and graph proximity. To enable semantic: set BRAIN_EMBEDDING_PROVIDER",
        "  to 'openai' or 'voyageai' and provide the API key.",
        "- brain_related returns memories connected by explicit links (memory_links table) or",
        "  semantic/entity overlap. If results are empty, use brain_link_memory to create links.",
        "",
        "You are a guest here. The brain outlives you: keep it valuable, not exhaustive.",
      ].join("\n"),
    }
  );

  registerBrainMcpTools(server, principal);
  return server;
}
