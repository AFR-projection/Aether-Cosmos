import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpPrincipal } from "./principal";
import type { StandingInstruction } from "@brain/application/queries/directives";

/**
 * MCP prompts — the brain as something a person can invoke.
 *
 * Tools are for the model, prompts are for the human: clients list them as commands
 * (`/mcp__aether-cosmos-brain__session_start` in Claude Code). That is the point of
 * this surface — the failure being fixed is an agent forgetting to load context, and a
 * person cannot forget on its behalf.
 *
 * Both prompts are reads, so both must fail closed on a credential without
 * `brain.read`. That is asserted here rather than trusted, because a prompt bypassing
 * `requireGrant` would be an authorization hole the tool tests could not see.
 */

const listStandingInstructions = vi.fn<() => Promise<StandingInstruction[]>>();
const recallBrainContext = vi.fn<() => Promise<{ contextText: string }>>();

vi.mock("@brain/application/queries/directives", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/application/queries/directives")>()),
  listStandingInstructions: () => listStandingInstructions(),
}));

vi.mock("@brain/application/queries/recall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/application/queries/recall")>()),
  recallBrainContext: () => recallBrainContext(),
}));

const { createBrainMcpServer } = await import("./server");

const principal = (scopes: string[]): McpPrincipal => ({
  type: "agent",
  id: "agent-1",
  userId: "user-1",
  agentId: "agent-1",
  agentName: "Hermes",
  apiKeyId: "key-1",
  grants: [
    {
      brainId: "11111111-1111-4111-8111-111111111111",
      brainName: "Personal Brain",
      isDefault: true,
      scopes: scopes as never,
    },
  ],
});

async function connect(scopes: string[] = ["brain.read"]) {
  const server = await createBrainMcpServer(principal(scopes));
  const client = new Client({ name: "prompts-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

/** First message's text, whatever shape the content block arrived in. */
function firstText(result: { messages: { content: unknown }[] }): string {
  const content = result.messages[0]?.content as { type: string; text?: string };
  return content?.text ?? "";
}

beforeEach(() => {
  listStandingInstructions.mockReset();
  listStandingInstructions.mockResolvedValue([]);
  recallBrainContext.mockReset();
  recallBrainContext.mockResolvedValue({ contextText: "Brain context:\n\n- rule" });
});

describe("Brain MCP prompts", () => {
  it("advertises both prompts, with session_start taking a topic", async () => {
    const { client, server } = await connect();
    try {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((prompt) => prompt.name).sort();

      expect(names).toEqual(["session_start", "standing_instructions"]);
      const start = prompts.find((prompt) => prompt.name === "session_start")!;
      // Optional, because a session with no stated topic still deserves the rules.
      expect(start.arguments?.map((arg) => [arg.name, arg.required])).toEqual([
        ["topic", false],
      ]);
    } finally {
      await server.close();
    }
  });

  it("hands back the recall package for the topic it was given", async () => {
    const { client, server } = await connect();
    try {
      const result = await client.getPrompt({
        name: "session_start",
        arguments: { topic: "deploy the worker" },
      });

      const text = firstText(result);
      expect(text).toContain("Brain context:");
      expect(text).toContain("Personal Brain");
      // The point of loading once: the agent is told not to re-fetch per turn.
      expect(text).toContain("Do not re-fetch it turn by turn");
      expect(recallBrainContext).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("works with an empty argument object, the way a client with no topic sends it", async () => {
    const { client, server } = await connect();
    try {
      const result = await client.getPrompt({ name: "session_start", arguments: {} });

      expect(firstText(result)).toContain("Brain context:");
    } finally {
      await server.close();
    }
  });

  it("returns the rules alone for standing_instructions", async () => {
    listStandingInstructions.mockResolvedValue([
      {
        id: "d1",
        type: "instruction",
        title: "Answer style",
        body: "Answer in Indonesian",
        scope: "brain",
        projectId: null,
        importance: 0.6,
        confidence: 0.9,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const { client, server } = await connect();
    try {
      const text = firstText(await client.getPrompt({ name: "standing_instructions" }));

      expect(text).toContain("Answer style: Answer in Indonesian");
      // Nothing else attached: this prompt exists for a mid-session refresh.
      expect(text).not.toContain("Brain context:");
      expect(recallBrainContext).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("tells the user how to create rules when the brain has none", async () => {
    const { client, server } = await connect();
    try {
      const text = firstText(await client.getPrompt({ name: "standing_instructions" }));

      expect(text).toContain("no standing instructions recorded");
      expect(text).toContain("brain_remember");
    } finally {
      await server.close();
    }
  });

  it("refuses both prompts without brain.read", async () => {
    // A prompt that skipped requireGrant would be an authorization hole invisible to
    // the tool tests, so it is asserted here on the surface itself.
    const { client, server } = await connect(["brain.write"]);
    try {
      for (const name of ["session_start", "standing_instructions"]) {
        await expect(client.getPrompt({ name, arguments: {} })).rejects.toThrow(/scope/i);
      }
      expect(recallBrainContext).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
