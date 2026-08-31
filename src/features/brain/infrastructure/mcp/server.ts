import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBrainMcpTools } from "./tools";
import { registerAdvancedBrainMcpTools } from "./tools-advanced";
import type { McpPrincipal } from "./principal";

/**
 * The MCP server identity, and the key users put in their Claude Desktop config.
 *
 * Renaming this is a breaking change for anyone who already added the server: the
 * old key keeps working on their side but no longer matches what
 * `/api/brain/[id]/connect` hands out, so the snippet has to be re-pasted.
 */
export const BRAIN_MCP_SERVER_NAME = "aether-cosmos-brain";
export const BRAIN_MCP_SERVER_VERSION = "2.1.0";

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
        "Advanced features (NEW in v2.1):",
        "- brain_batch_search: Execute multiple queries in parallel for efficiency",
        "- brain_analytics: Get usage insights and quality metrics",
        "- brain_suggest_queries: Generate query suggestions based on brain content",
        "- brain_semantic_status: Check semantic search availability and backfill progress",
        "- brain_export_memories: Export for backup or migration (JSON/Markdown)",
        "",
        "Retrieval notes:",
        "- Semantic search can be enabled from /brain/settings (OpenRouter embeddings).",
        "  Check status with brain_semantic_status. When enabled, retrieval uses:",
        "  lexical (FTS) + entity overlap + graph proximity + semantic similarity.",
        "- brain_related returns memories connected by explicit links (memory_links table),",
        "  derived relationships (scored by local algorithms), or semantic/entity overlap.",
        "  If results are empty, use brain_link_memory to create explicit links.",
        "",
        "You are a guest here. The brain outlives you: keep it valuable, not exhaustive.",
      ].join("\n"),
    }
  );

  registerBrainMcpTools(server, principal);
  registerAdvancedBrainMcpTools(server, principal);
  return server;
}
