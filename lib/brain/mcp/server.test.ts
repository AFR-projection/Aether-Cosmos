import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrainMcpServer } from "@/lib/brain/mcp/server";
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
});
