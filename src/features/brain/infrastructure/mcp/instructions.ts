import { listStandingInstructions, renderDirectives } from "@brain/application/queries/directives";
import { brainScopeSatisfied } from "@brain/domain/constants";
import { CACHE_TTL, getCached, setCached } from "./cache";
import type { BrainGrant, McpPrincipal } from "./principal";

/**
 * The `instructions` payload sent in the MCP initialize result.
 *
 * This is the only channel in MCP through which a server reaches the model without
 * being asked: clients place it in the system prompt at handshake time. There is no
 * server-initiated push into a conversation, so anything the agent must know *before*
 * its first thought has to travel here or not at all.
 *
 * Which is why the user's standing instructions are rendered into it. Previously this
 * string was static and told the agent to call brain_recall to find out the rules —
 * a rule you have to remember to ask for is not a rule in force. Now the rules arrive
 * with the connection, and recall is for the task-specific half.
 *
 * Two constraints shape everything below. It lands in EVERY session for this
 * principal, so it is hard-capped rather than merely short. And a handshake must
 * never fail: any database trouble falls back to the static protocol instead of
 * turning a connect into a 500.
 */

/** Chars of standing instructions allowed into the handshake. */
export const DIRECTIVE_BUDGET = 1800;

/** The protocol half — true regardless of which brain is on the other end. */
export const BRAIN_PROTOCOL_INSTRUCTIONS = [
  "This is the user's Second Brain: their protected, persistent long-term memory.",
  "",
  "Protocol:",
  "1. The standing instructions below are already loaded — follow them without asking for them.",
  "   Call brain_recall(task) at the start of a task for the *task-specific* context:",
  "   relevant memories, important ones, recent changes, related graph nodes.",
  "   With a token budget to respect, call brain_context instead: same purpose, but bounded in",
  "   tokens and it tells you why each memory was chosen and what was left out.",
  "2. Use brain_search / brain_read while working to look things up.",
  "3. Call brain_remember only for knowledge worth keeping permanently — facts, decisions,",
  "   preferences, procedures, project context. Not transient conversation.",
  "   A durable preference the user states belongs here as type=preference; a working rule",
  "   they give you belongs here as type=instruction. Those two types become the standing",
  "   instructions of every future session, so write them as rules, not as notes.",
  "4. Use brain_update to correct an existing memory instead of writing a contradicting one.",
  "5. Use brain_link_memory to create explicit relationships between memories.",
  "   Use brain_link to record entity relationships the brain should know about.",
  "",
  "Advanced:",
  "- brain_batch_search: Execute multiple queries in parallel for efficiency",
  "- brain_analytics: Get usage insights and quality metrics",
  "- brain_suggest_queries: Generate query suggestions based on brain content",
  "- brain_semantic_status: Check semantic search availability and backfill progress",
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
].join("\n");

/** What the handshake says when a brain has no rules yet. */
const NO_DIRECTIVES = [
  "Standing instructions: none recorded yet.",
  "When the user states a durable preference or gives you a working rule, save it with",
  "brain_remember (type=preference or type=instruction) so every future session inherits it.",
].join("\n");

/** The grant a session defaults to — the same choice `requireGrant` makes with no id. */
export function defaultGrant(principal: McpPrincipal): BrainGrant | null {
  if (principal.grants.length === 0) return null;
  return principal.grants.find((grant) => grant.isDefault) ?? principal.grants[0];
}

/**
 * Renders the directive block, clipped to the handshake budget. Whole rules are
 * dropped rather than cut mid-sentence — half a rule is worse than a missing one,
 * because the agent cannot tell it is reading half.
 */
export function renderDirectiveBlock(
  directives: Awaited<ReturnType<typeof listStandingInstructions>>,
  budget = DIRECTIVE_BUDGET
): string {
  if (directives.length === 0) return NO_DIRECTIVES;
  const kept: typeof directives = [];
  let used = 0;
  for (const directive of directives) {
    const line = renderDirectives([directive]);
    if (used + line.length + 1 > budget) break;
    kept.push(directive);
    used += line.length + 1;
  }
  if (kept.length === 0) return NO_DIRECTIVES;
  const dropped = directives.length - kept.length;
  return [
    "Standing instructions — the user's own rules, already in force. Follow them:",
    renderDirectives(kept),
    ...(dropped > 0
      ? [`(${dropped} more not shown; call brain_recall to see the rest.)`]
      : []),
  ].join("\n");
}

/**
 * The full payload for one principal.
 *
 * Gated on `brain.read`: an agent granted only write must not receive the contents of
 * the user's memories in its system prompt as a side effect of connecting.
 */
export async function buildAgentInstructions(principal: McpPrincipal): Promise<string> {
  const grant = defaultGrant(principal);
  if (!grant || !brainScopeSatisfied(grant.scopes, "brain.read")) {
    return BRAIN_PROTOCOL_INSTRUCTIONS;
  }

  let block: string;
  try {
    const cached = getCached<string>("instructions", grant.brainId, {});
    if (cached !== undefined) {
      block = cached;
    } else {
      block = renderDirectiveBlock(await listStandingInstructions({ brainId: grant.brainId }));
      setCached("instructions", grant.brainId, {}, block, CACHE_TTL.instructions);
    }
  } catch (error) {
    // A handshake that fails because a query did is a brain the agent cannot reach at
    // all. Losing the rules for this session is recoverable; losing the server is not.
    console.error("brain mcp instructions failed", error);
    return BRAIN_PROTOCOL_INSTRUCTIONS;
  }

  return [
    `Brain: "${grant.brainName}".`,
    "",
    block,
    "",
    BRAIN_PROTOCOL_INSTRUCTIONS,
  ].join("\n");
}
