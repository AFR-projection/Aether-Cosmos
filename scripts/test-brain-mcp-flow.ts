/**
 * Second Brain end-to-end smoke test: REST + MCP, against a running server.
 *
 * Creates a throwaway brain and agent, exercises the agent memory protocol over
 * MCP (recall → remember → search → read → link), verifies tenant isolation, then
 * deletes everything it created. Writes to whatever DATABASE_URL points at, so run
 * it against a database you are happy to touch.
 *
 * Usage:
 *   npx next start                                  # or npm run dev, in another shell
 *   npx tsx scripts/test-brain-mcp-flow.ts [baseUrl]
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { brainAgents, brains, users } from "../lib/db/schema";
import { deleteApiKey } from "../lib/auth/api-key";
import { createBrainAgent, revokeBrainAgent } from "../lib/brain/agent-service";
import { createBrain, deleteBrain } from "../lib/brain/brain-service";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const MCP_URL = `${BASE}/api/brain/mcp`;

let failures = 0;

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
}

let requestId = 0;

/** One JSON-RPC call against the stateless MCP endpoint. */
async function rpc(token: string, method: string, params?: unknown) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });

  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Streamable HTTP may answer as SSE; pull the first data: frame out.
    const frame = text.split("\n").find((line) => line.startsWith("data:"));
    if (frame) body = JSON.parse(frame.slice(5).trim());
  }
  return { status: response.status, body };
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const { body } = await rpc(token, "tools/call", { name, arguments: args });
  const result = body.result as
    | { content?: { type: string; text: string }[]; isError?: boolean }
    | undefined;
  const text = result?.content?.[0]?.text ?? "{}";
  return { isError: !!result?.isError, data: JSON.parse(text) as Record<string, never> };
}

async function main() {
  console.log(`\nSecond Brain MCP smoke test → ${MCP_URL}\n`);

  const [user] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.status, "active"))
    .limit(1);

  if (!user) {
    console.error("No active user in database — cannot run test");
    process.exit(1);
  }
  console.log(`Using user: ${user.username}\n`);

  const brain = await createBrain(user.id, {
    name: `MCP smoke test ${Date.now()}`,
    description: "Temporary brain created by scripts/test-brain-mcp-flow.ts",
  });
  const other = await createBrain(user.id, {
    name: `MCP smoke test isolation ${Date.now()}`,
  });

  const { agent, rawKey } = await createBrainAgent({
    userId: user.id,
    brainId: brain.id,
    name: `smoke-agent-${Date.now()}`,
    scopes: ["brain.read", "brain.search", "brain.write"],
  });

  console.log(`Brain:  ${brain.id}`);
  console.log(`Agent:  ${agent.name} (${agent.id})\n`);

  try {
    console.log("Protocol:");

    const listed = await callTool(rawKey, "brain_list_brains", {});
    const brainIds = (listed.data.brains as unknown as { brainId: string }[]).map(
      (row) => row.brainId
    );
    assert("brain_list_brains returns only the granted brain", 
      brainIds.length === 1 && brainIds[0] === brain.id,
      JSON.stringify(brainIds)
    );

    const emptyRecall = await callTool(rawKey, "brain_recall", { task: "deployment" });
    assert("brain_recall works on an empty brain", !emptyRecall.isError);

    const remembered = await callTool(rawKey, "brain_remember", {
      title: "Production deployment requires Redis",
      content:
        "Storage ByAFR background workers run on BullMQ, which requires Redis. Deployment without Redis leaves uploads stuck in the queue.",
      type: "fact",
      importance: 0.9,
      confidence: 0.95,
      tags: ["deployment", "redis"],
    });
    assert("brain_remember creates a memory", remembered.data.mode === "created");
    const memoryId = (remembered.data.memory as unknown as { id: string }).id;

    const duplicate = await callTool(rawKey, "brain_remember", {
      title: "Production deployment requires Redis",
      content: "Confirmed again: Redis is required for BullMQ workers.",
      type: "fact",
    });
    assert(
      "brain_remember updates instead of duplicating the same title",
      duplicate.data.mode === "updated"
    );

    const projectsListed = await callTool(rawKey, "brain_list_projects", {});
    assert(
      "brain_list_projects works on a brain with no projects",
      !projectsListed.isError && Array.isArray(projectsListed.data.projects)
    );

    const searched = await callTool(rawKey, "brain_search", { query: "redis deployment" });
    const hits = searched.data.results as unknown as { id: string }[];
    assert("brain_search finds it", hits.some((hit) => hit.id === memoryId));

    const read = await callTool(rawKey, "brain_read", { memoryId });
    assert(
      "brain_read returns full content and agent provenance",
      typeof read.data.content === "string" &&
        (read.data.provenance as unknown as { createdByAgent: string | null })
          .createdByAgent === agent.id
    );

    const history = await callTool(rawKey, "brain_get_memory_history", { memoryId });
    assert(
      "version history was recorded by the update",
      (history.data.versions as unknown as unknown[]).length >= 1
    );

    const linked = await callTool(rawKey, "brain_link", {
      source: "Storage ByAFR",
      sourceType: "product",
      target: "Redis",
      targetType: "technology",
      relationshipType: "requires",
    });
    assert("brain_link creates both nodes and the edge", !linked.isError);

    const recall = await callTool(rawKey, "brain_recall", { task: "redis deployment" });
    const contextText = recall.data.contextText as unknown as string;
    assert("brain_recall surfaces the remembered fact", contextText.includes("Redis"));
    assert("brain_recall stays bounded", contextText.length <= 6000);

    console.log("\nIsolation (§46):");

    const crossBrain = await callTool(rawKey, "brain_search", {
      brainId: other.id,
      query: "redis",
    });
    assert("agent cannot search a brain it was not granted", crossBrain.isError);

    const crossRead = await callTool(rawKey, "brain_read", {
      brainId: other.id,
      memoryId,
    });
    assert("agent cannot read across brains by naming another brain id", crossRead.isError);

    const deleteAttempt = await callTool(rawKey, "brain_delete", { memoryId });
    assert(
      "agent without brain.delete cannot delete",
      deleteAttempt.isError,
      JSON.stringify(deleteAttempt.data)
    );

    const exportAttempt = await rpc(rawKey, "tools/call", {
      name: "brain_export",
      arguments: {},
    });
    assert(
      "no brain_export tool is exposed to an agent without the scope",
      !!exportAttempt.body.error || !!(exportAttempt.body.result as { isError?: boolean })?.isError
    );

    const restCross = await fetch(`${BASE}/api/brain/${other.id}/memories`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    assert(
      "REST layer refuses the same cross-brain access",
      restCross.status === 403 || restCross.status === 404,
      `status ${restCross.status}`
    );
  } finally {
    console.log("\nCleanup:");
    await revokeBrainAgent(user.id, agent.id).catch(() => {});
    const [row] = await db
      .select({ apiKeyId: brainAgents.apiKeyId })
      .from(brainAgents)
      .where(and(eq(brainAgents.id, agent.id), eq(brainAgents.ownerUserId, user.id)))
      .limit(1);
    if (row?.apiKeyId) await deleteApiKey(user.id, row.apiKeyId).catch(() => {});
    await db.delete(brainAgents).where(eq(brainAgents.id, agent.id));
    await deleteBrain(brain.id, user.id).catch(() => {});
    await deleteBrain(other.id, user.id).catch(() => {});
    const left = await db.select({ id: brains.id }).from(brains).where(eq(brains.id, brain.id));
    assert("temporary brain removed", left.length === 0);
  }

  console.log(failures === 0 ? "\n✅ All checks passed.\n" : `\n❌ ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
