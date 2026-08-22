import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainMcpServer } from "@/lib/brain/mcp/server";
import {
  CONTEXT_MAX_MEMORIES_MAX,
  CONTEXT_TOKEN_BUDGET_MAX,
  CONTEXT_TOKEN_BUDGET_MIN,
} from "@/lib/brain/context-engine";
import type { McpPrincipal } from "@/lib/brain/mcp/principal";

/**
 * Talks to the real MCP server over an in-memory transport. Listing tools never
 * runs a handler, so this needs no database — but it does prove the server
 * initializes, advertises its tools, and exposes usable input schemas.
 */
const principal: McpPrincipal = {
  type: "agent",
  id: "agent-1",
  userId: "user-1",
  agentId: "agent-1",
  agentName: "OpenClaw",
  apiKeyId: "key-1",
  grants: [
    {
      brainId: "aaaaaaaa-1111-4111-8111-111111111111",
      brainName: "Personal Brain",
      isDefault: true,
      scopes: ["brain.read", "brain.search", "brain.write"],
    },
  ],
};

async function connect() {
  const server = createBrainMcpServer(principal);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("Brain MCP server", () => {
  it("initializes and advertises the agent memory protocol tools", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();

      // The protocol of §60: recall → search/read → remember → link.
      for (const required of [
        "brain_recall",
        "brain_search",
        "brain_read",
        "brain_remember",
        "brain_update",
        "brain_link",
      ]) {
        expect(names).toContain(required);
      }
      expect(names).toContain("brain_list_brains");
      expect(names).toContain("brain_get_memory_history");
      expect(names).toContain("brain_get_related");
      // §41: memory-anchored links and the backlink lookup they enable.
      expect(names).toContain("brain_link_memory");
      expect(names).toContain("brain_get_backlinks");
      // §30/§31: consolidation and conflict inspection.
      expect(names).toContain("brain_consolidate");
      // P3: the token-bounded context primitive, alongside — not instead of — recall.
      expect(names).toContain("brain_context");
      expect(names).toContain("brain_recall");
      // P4: graph path-finding and related memories.
      expect(names).toContain("brain_path");
      expect(names).toContain("brain_related");
      // P5: temporal memory timeline.
      expect(names).toContain("brain_timeline");
      // P6: health and contradiction surface.
      expect(names).toContain("brain_health");
      // P7: provenance explanation.
      expect(names).toContain("brain_explain");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("gives every tool a description and an object input schema", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(10);
      for (const tool of tools) {
        expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
        expect(tool.inputSchema.type, `${tool.name} schema`).toBe("object");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not expose a raw-query or SQL escape hatch (§89)", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.name).toMatch(/^brain_/);
        expect(tool.name).not.toMatch(/sql|query_raw|exec|eval/i);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("accepts an optional brainId on brain-scoped tools so multi-brain agents can target one", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const search = tools.find((tool) => tool.name === "brain_search");
      const properties = search?.inputSchema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("brainId");
      expect(properties).toHaveProperty("query");
      expect(search?.inputSchema.required).toEqual(["query"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises brain_context with a task and a bounded token budget", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const context = tools.find((tool) => tool.name === "brain_context");
      const properties = context?.inputSchema.properties as Record<
        string,
        { minimum?: number; maximum?: number }
      >;

      // Only the task is required: an agent that knows nothing else must still be
      // able to ask, and every budget knob has a server-side ceiling.
      expect(context?.inputSchema.required).toEqual(["task"]);
      expect(properties.tokenBudget.minimum).toBe(CONTEXT_TOKEN_BUDGET_MIN);
      expect(properties.tokenBudget.maximum).toBe(CONTEXT_TOKEN_BUDGET_MAX);
      expect(properties.maxMemories.maximum).toBe(CONTEXT_MAX_MEMORIES_MAX);
      expect(properties).toHaveProperty("includeGraph");
      expect(properties).toHaveProperty("includeProvenance");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses brain_context for a brain the credential was not granted", async () => {
    // Fail-closed before any database work: a brainId that is not in the grants is
    // rejected by requireGrant, so an unauthorized call cannot even reach retrieval
    // (which is what makes this assertion safe without a live Postgres).
    const server = createBrainMcpServer({ ...principal, grants: [] });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "brain_context",
        arguments: { brainId: "bbbbbbbb-2222-4222-8222-222222222222", task: "deploy the worker" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0].text;
      expect(text).toContain("FORBIDDEN");
      // No brain content, no SQL, no stack trace in the refusal.
      expect(text).not.toMatch(/select|from |postgres|at .*\.ts/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

/**
 * Every intelligence tool, one at a time, against a credential that was granted
 * nothing. The refusal has to happen in `requireGrant` — before the handler touches
 * the database — which is exactly why these can run without Postgres: if any tool
 * ever queried first and authorized second, the lazy `db` proxy would throw
 * "DATABASE_URL is not set" instead of FORBIDDEN, and the test fails.
 *
 * `brain_context` has its own case above; this covers the rest of the surface so a
 * new tool cannot ship without its own fail-closed check.
 */
const OTHER_BRAIN = "bbbbbbbb-2222-4222-8222-222222222222";
const MEM_A = "cccccccc-3333-4333-8333-333333333333";
const MEM_B = "dddddddd-4444-4444-8444-444444444444";

const INTELLIGENCE_CALLS: Array<{ name: string; arguments: Record<string, unknown> }> = [
  { name: "brain_path", arguments: { sourceMemoryId: MEM_A, targetMemoryId: MEM_B } },
  { name: "brain_related", arguments: { memoryId: MEM_A } },
  { name: "brain_timeline", arguments: { memoryId: MEM_A } },
  { name: "brain_explain", arguments: { memoryId: MEM_A } },
  { name: "brain_health", arguments: {} },
  { name: "brain_context", arguments: { task: "deploy the worker" } },
];

async function connectAs(overrides: Partial<McpPrincipal>) {
  const server = createBrainMcpServer({ ...principal, ...overrides });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function refusalText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  return (result.content as { text: string }[])[0].text;
}

describe("every intelligence tool fails closed", () => {
  it.each(INTELLIGENCE_CALLS)("refuses $name for an ungranted brain", async (call) => {
    const { client, server } = await connectAs({ grants: [] });
    try {
      const text = refusalText(
        await client.callTool({
          name: call.name,
          arguments: { ...call.arguments, brainId: OTHER_BRAIN },
        })
      );

      expect(text).toContain("FORBIDDEN");
      // The refusal must not leak the shape of the store or the fact that a query ran.
      expect(text).not.toMatch(/select|from |postgres|DATABASE_URL|at .*\.ts/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(INTELLIGENCE_CALLS)(
    "refuses $name when the credential holds no brain scope at all",
    async (call) => {
      // A grant on the right brain but with an empty scope list: authorization is per
      // scope, not per brain, so the tool must still refuse.
      const { client, server } = await connectAs({
        grants: [
          {
            brainId: "aaaaaaaa-1111-4111-8111-111111111111",
            brainName: "Personal Brain",
            isDefault: true,
            scopes: [],
          },
        ],
      });
      try {
        const text = refusalText(await client.callTool({ name: call.name, arguments: call.arguments }));
        expect(text).toContain("FORBIDDEN");
      } finally {
        await client.close();
        await server.close();
      }
    }
  );
});

describe("write paths behind a read-only credential", () => {
  /** brain.read only — enough to report, never enough to change the brain. */
  const readOnly: Partial<McpPrincipal> = {
    grants: [
      {
        brainId: "aaaaaaaa-1111-4111-8111-111111111111",
        brainName: "Personal Brain",
        isDefault: true,
        scopes: ["brain.read"],
      },
    ],
  };

  it("lets brain_health report but not queue findings for review", async () => {
    // Queueing is a write, so it takes brain.consolidate. The refusal proves the
    // scope is checked before the health scan runs, not after.
    const { client, server } = await connectAs(readOnly);
    try {
      const text = refusalText(
        await client.callTool({ name: "brain_health", arguments: { queueForReview: true } })
      );
      expect(text).toContain("FORBIDDEN");
      expect(text).toMatch(/scope/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lets brain_consolidate preview but not apply", async () => {
    const { client, server } = await connectAs(readOnly);
    try {
      const text = refusalText(
        await client.callTool({ name: "brain_consolidate", arguments: { apply: true } })
      );
      expect(text).toContain("FORBIDDEN");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises the review-queue switch as opt-in, never the default", async () => {
    const { client, server } = await connectAs(readOnly);
    try {
      const { tools } = await client.listTools();
      const health = tools.find((tool) => tool.name === "brain_health");
      const properties = health?.inputSchema.properties as Record<string, unknown>;

      expect(properties).toHaveProperty("queueForReview");
      // Nothing is required beyond the brain, so a plain call stays read-only.
      expect(health?.inputSchema.required ?? []).not.toContain("queueForReview");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
