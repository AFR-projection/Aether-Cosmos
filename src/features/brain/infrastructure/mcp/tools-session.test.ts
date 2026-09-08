import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpPrincipal } from "./principal";

const buildSessionStart = vi.fn();
const buildSessionTurn = vi.fn();
const runBrainIngest = vi.fn();
const logBrainAudit = vi.fn();

vi.mock("@brain/application/queries/directives", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/application/queries/directives")>()),
  listStandingInstructions: async () => [],
}));
vi.mock("@brain/application/queries/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/application/queries/session")>()),
  buildSessionStart: (...args: unknown[]) => buildSessionStart(...args),
  buildSessionTurn: (...args: unknown[]) => buildSessionTurn(...args),
}));
vi.mock("@brain/infrastructure/ingest-runner", () => ({
  runBrainIngest: (...args: unknown[]) => runBrainIngest(...args),
}));
vi.mock("@brain/infrastructure/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/infrastructure/audit")>()),
  logBrainAudit: (...args: unknown[]) => logBrainAudit(...args),
}));

const { createBrainMcpServer } = await import("./server");
const BRAIN = "11111111-1111-4111-8111-111111111111";

function principal(scopes: string[]): McpPrincipal {
  return {
    type: "agent",
    id: "agent-1",
    userId: "user-1",
    agentId: "agent-1",
    agentName: "Claude",
    apiKeyId: "key-1",
    grants: [
      {
        brainId: BRAIN,
        brainName: "Personal",
        isDefault: true,
        scopes: scopes as never,
      },
    ],
  };
}

async function connect(scopes: string[]) {
  const server = await createBrainMcpServer(principal(scopes));
  const client = new Client({ name: "session-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) return "";
  return ((result.content as { text?: string }[])[0]?.text ?? "");
}

beforeEach(() => {
  buildSessionStart.mockReset();
  buildSessionStart.mockResolvedValue({
    sessionId: "session-1",
    brainId: BRAIN,
    brainName: "Personal",
    topic: "deploy",
    directiveCount: 1,
    memoryIds: ["22222222-2222-4222-8222-222222222222"],
    text: "loaded context",
  });
  buildSessionTurn.mockReset();
  buildSessionTurn.mockResolvedValue({
    sessionId: "session-1",
    memoryIds: [],
    memories: [],
    text: "",
  });
  runBrainIngest.mockReset();
  runBrainIngest.mockResolvedValue({
    sessionId: "session-1",
    committed: false,
    considered: 1,
    created: 1,
    merged: 0,
    skipped: 0,
    reviewNeeded: 0,
    thresholds: { minSalience: 0.45, minImportance: 0.45, sampleRate: 1, maxWrites: 5 },
    results: [],
  });
  logBrainAudit.mockReset();
  logBrainAudit.mockResolvedValue(undefined);
});

describe("Brain MCP session tools", () => {
  it("advertises all four lifecycle and ingest tools", async () => {
    const { client, server } = await connect(["brain.read", "brain.search", "brain.ingest"]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [
        "brain_session_start",
        "brain_session_turn",
        "brain_session_end",
        "brain_ingest",
      ]) {
        expect(names).toContain(name);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("starts a session under brain.read and audits once", async () => {
    const { client, server } = await connect(["brain.read"]);
    try {
      const result = await client.callTool({
        name: "brain_session_start",
        arguments: { topic: "deploy" },
      });

      expect(result.isError).not.toBe(true);
      expect(JSON.parse(text(result))).toMatchObject({ sessionId: "session-1", context: "loaded context" });
      expect(buildSessionStart).toHaveBeenCalledWith(expect.objectContaining({ brainId: BRAIN }));
      expect(logBrainAudit).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not audit the per-turn lookup", async () => {
    const { client, server } = await connect(["brain.search"]);
    try {
      const result = await client.callTool({
        name: "brain_session_turn",
        arguments: { prompt: "deploy worker" },
      });

      expect(result.isError).not.toBe(true);
      expect(buildSessionTurn).toHaveBeenCalledOnce();
      expect(logBrainAudit).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes session end previews through the shared ingest runner", async () => {
    const { client, server } = await connect(["brain.ingest"]);
    try {
      const result = await client.callTool({
        name: "brain_session_end",
        arguments: {
          sessionId: "session-1",
          candidates: [{ content: "The production database is PostgreSQL 16." }],
          commit: false,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(runBrainIngest).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "session.end",
          options: expect.objectContaining({ sessionId: "session-1", commit: false }),
          auditMetadata: { transport: "mcp", via: "brain_session_end" },
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes mid-session ingestion through the same runner", async () => {
    const { client, server } = await connect(["brain.ingest"]);
    try {
      await client.callTool({
        name: "brain_ingest",
        arguments: { candidates: [{ content: "We decided to use PostgreSQL." }] },
      });

      expect(runBrainIngest).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "memory.ingest",
          auditMetadata: { transport: "mcp", via: "brain_ingest" },
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed when a tool's grant is missing", async () => {
    const { client, server } = await connect(["brain.read"]);
    try {
      for (const call of [
        { name: "brain_session_turn", arguments: { prompt: "deploy" } },
        {
          name: "brain_session_end",
          arguments: { candidates: [{ content: "We decided to use PostgreSQL." }] },
        },
        {
          name: "brain_ingest",
          arguments: { candidates: [{ content: "We decided to use PostgreSQL." }] },
        },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("FORBIDDEN");
      }
      expect(buildSessionTurn).not.toHaveBeenCalled();
      expect(runBrainIngest).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not let ordinary brain.write imply unattended ingest", async () => {
    const { client, server } = await connect(["brain.write"]);
    try {
      const result = await client.callTool({
        name: "brain_ingest",
        arguments: { candidates: [{ content: "We decided to use PostgreSQL." }] },
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain("FORBIDDEN");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
