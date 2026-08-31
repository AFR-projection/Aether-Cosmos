import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainMcpServer } from "./server";
import type { McpPrincipal } from "./principal";

const principal: McpPrincipal = {
  type: "agent",
  id: "agent-advanced",
  userId: "user-1",
  agentId: "agent-advanced",
  agentName: "TestAgent",
  apiKeyId: "key-advanced",
  grants: [
    {
      brainId: "bbbbbbbb-2222-4222-8222-222222222222",
      brainName: "Test Brain",
      isDefault: true,
      scopes: ["brain.read", "brain.search", "brain.write"],
    },
  ],
};

async function connect() {
  const server = createBrainMcpServer(principal);
  const client = new Client({ name: "test-client-advanced", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("Advanced Brain MCP tools", () => {
  it("advertises advanced tools in v2.1", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      // Check new advanced tools are present
      expect(names).toContain("brain_batch_search");
      expect(names).toContain("brain_batch_context");
      expect(names).toContain("brain_analytics");
      expect(names).toContain("brain_suggest_queries");
      expect(names).toContain("brain_semantic_status");
      expect(names).toContain("brain_export_memories");

      // Check server version
      const serverInfo = await client.getServerVersion();
      expect(serverInfo).toBeDefined();
      expect(serverInfo?.version).toBe("2.1.0");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("brain_batch_search has correct schema", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const batchSearch = tools.find((t) => t.name === "brain_batch_search");

      expect(batchSearch).toBeDefined();
      expect(batchSearch?.description).toContain("multiple search queries in parallel");

      const schema = batchSearch?.inputSchema as Record<string, unknown>;
      const props = (schema.properties as Record<string, unknown>) || {};

      expect(props).toHaveProperty("queries");
      expect(props).toHaveProperty("limit");
      expect(props).toHaveProperty("deduplicate");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("brain_analytics has correct schema", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const analytics = tools.find((t) => t.name === "brain_analytics");

      expect(analytics).toBeDefined();
      expect(analytics?.description).toContain("usage analytics");
      expect(analytics?.description).toContain("quality metrics");

      const schema = analytics?.inputSchema as Record<string, unknown>;
      const props = (schema.properties as Record<string, unknown>) || {};

      expect(props).toHaveProperty("period");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("brain_semantic_status has correct schema", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const semanticStatus = tools.find((t) => t.name === "brain_semantic_status");

      expect(semanticStatus).toBeDefined();
      expect(semanticStatus?.description).toContain("semantic search availability");
      expect(semanticStatus?.description).toContain("embeddings");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("brain_export_memories supports JSON and markdown", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const exportTool = tools.find((t) => t.name === "brain_export_memories");

      expect(exportTool).toBeDefined();
      expect(exportTool?.description).toContain("portable");
      expect(exportTool?.description).toContain("backup");

      const schema = exportTool?.inputSchema as Record<string, unknown>;
      const props = (schema.properties as Record<string, unknown>) || {};
      const format = props.format as Record<string, unknown>;

      expect(format).toBeDefined();
      expect(format.enum).toEqual(["json", "markdown"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("brain_suggest_queries has correct schema", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const suggest = tools.find((t) => t.name === "brain_suggest_queries");

      expect(suggest).toBeDefined();
      expect(suggest?.description).toContain("query suggestions");

      const schema = suggest?.inputSchema as Record<string, unknown>;
      const props = (schema.properties as Record<string, unknown>) || {};

      expect(props).toHaveProperty("context");
      expect(props).toHaveProperty("limit");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("brain_batch_context has correct schema", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const batchContext = tools.find((t) => t.name === "brain_batch_context");

      expect(batchContext).toBeDefined();
      expect(batchContext?.description).toContain("multiple tasks in parallel");

      const schema = batchContext?.inputSchema as Record<string, unknown>;
      const props = (schema.properties as Record<string, unknown>) || {};
      const tasks = props.tasks as Record<string, unknown>;

      expect(tasks).toBeDefined();
      expect(tasks.type).toBe("array");
      expect((tasks.items as Record<string, unknown>).properties).toHaveProperty("task");
      expect((tasks.items as Record<string, unknown>).properties).toHaveProperty("tokenBudget");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("all advanced tools require brainId parameter", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const advancedTools = [
        "brain_batch_search",
        "brain_analytics",
        "brain_suggest_queries",
        "brain_semantic_status",
        "brain_export_memories",
        "brain_batch_context",
      ];

      for (const toolName of advancedTools) {
        const tool = tools.find((t) => t.name === toolName);
        expect(tool).toBeDefined();

        const schema = tool?.inputSchema as Record<string, unknown>;
        const props = (schema.properties as Record<string, unknown>) || {};

        expect(props).toHaveProperty("brainId");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("server has core + advanced tools", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();

      // Verify all 6 advanced tools are registered
      const advancedTools = [
        "brain_batch_search",
        "brain_batch_context",
        "brain_analytics",
        "brain_suggest_queries",
        "brain_semantic_status",
        "brain_export_memories",
      ];

      const toolNames = tools.map((t) => t.name);
      for (const advTool of advancedTools) {
        expect(toolNames, `Expected to find ${advTool}`).toContain(advTool);
      }

      // Should have at least 29 core + 6 advanced = 35 tools
      expect(tools.length).toBeGreaterThanOrEqual(29);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
