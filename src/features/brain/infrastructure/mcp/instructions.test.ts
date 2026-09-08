import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpPrincipal } from "./principal";
import type { StandingInstruction } from "@brain/application/queries/directives";

/**
 * The MCP handshake payload.
 *
 * This string is the only channel through which the brain reaches a model without
 * being asked, so three properties are load-bearing:
 *
 * - It must contain the user's actual rules. A protocol that says "call brain_recall to
 *   learn the rules" is the bug this feature exists to fix.
 * - It must never be produced by a failing read. A handshake that throws is a brain the
 *   agent cannot reach at all, which is strictly worse than one whose rules are stale.
 * - It must not leak memory contents to a credential without `brain.read`. Connecting
 *   is not a read, and a write-only agent must not receive the user's rules as a side
 *   effect of saying hello.
 */

const listSpy = vi.fn<(params: { brainId: string; projectId?: string | null }) => Promise<StandingInstruction[]>>();

vi.mock("@brain/application/queries/directives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@brain/application/queries/directives")>();
  return { ...actual, listStandingInstructions: (params: never) => listSpy(params) };
});

const { buildAgentInstructions, renderDirectiveBlock, BRAIN_PROTOCOL_INSTRUCTIONS, DIRECTIVE_BUDGET } =
  await import("./instructions");
const { clearCache } = await import("./cache");

const BRAIN = "11111111-1111-4111-8111-111111111111";

const directive = (overrides: Partial<StandingInstruction> = {}): StandingInstruction => ({
  id: "d1",
  type: "instruction",
  title: "Answer style",
  body: "Answer in Indonesian",
  scope: "brain",
  projectId: null,
  importance: 0.6,
  confidence: 0.9,
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const principal = (scopes: string[], brainId = BRAIN): McpPrincipal => ({
  type: "agent",
  id: "agent-1",
  userId: "user-1",
  agentId: "agent-1",
  agentName: "Hermes",
  apiKeyId: "key-1",
  grants: [
    {
      brainId,
      brainName: "Personal Brain",
      isDefault: true,
      scopes: scopes as never,
    },
  ],
});

beforeEach(() => {
  listSpy.mockReset();
  listSpy.mockResolvedValue([directive()]);
  clearCache();
});

describe("buildAgentInstructions", () => {
  it("carries the user's own rules, not an instruction to go and find them", async () => {
    const text = await buildAgentInstructions(principal(["brain.read"]));

    expect(text).toContain('Brain: "Personal Brain"');
    expect(text).toContain("Answer style: Answer in Indonesian");
    expect(text).toContain("already in force");
    // The protocol still rides along: the rules are the new half, not the only half.
    expect(text).toContain("brain_recall");
  });

  it("withholds the rules from a credential that cannot read", async () => {
    const text = await buildAgentInstructions(principal(["brain.write"]));

    expect(text).toBe(BRAIN_PROTOCOL_INSTRUCTIONS);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("accepts brain.full as read, the way every other check does", async () => {
    await buildAgentInstructions(principal(["brain.full"]));

    expect(listSpy).toHaveBeenCalledOnce();
  });

  it("falls back to the protocol when there is no brain at all", async () => {
    const bare = { ...principal(["brain.read"]), grants: [] };

    expect(await buildAgentInstructions(bare)).toBe(BRAIN_PROTOCOL_INSTRUCTIONS);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("survives a database that is down", async () => {
    listSpy.mockRejectedValue(new Error("DATABASE_URL is not set"));

    // Losing the rules for one session is recoverable; losing the handshake is not.
    expect(await buildAgentInstructions(principal(["brain.read"]))).toBe(
      BRAIN_PROTOCOL_INSTRUCTIONS
    );
  });

  it("reads once per brain and serves the rest from cache", async () => {
    const subject = principal(["brain.read"]);
    await buildAgentInstructions(subject);
    await buildAgentInstructions(subject);
    await buildAgentInstructions(subject);

    // Every MCP request builds a fresh server, so without the cache this read would
    // ride on every tool call rather than on every connect.
    expect(listSpy).toHaveBeenCalledOnce();
  });

  it("keeps one brain's rules out of another's handshake", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    listSpy.mockResolvedValueOnce([directive({ title: "First brain rule" })]);
    listSpy.mockResolvedValueOnce([directive({ title: "Second brain rule" })]);

    const first = await buildAgentInstructions(principal(["brain.read"], BRAIN));
    const second = await buildAgentInstructions(principal(["brain.read"], other));

    expect(first).toContain("First brain rule");
    expect(first).not.toContain("Second brain rule");
    expect(second).toContain("Second brain rule");
  });
});

describe("renderDirectiveBlock", () => {
  it("tells the agent how to create rules when there are none", async () => {
    const block = renderDirectiveBlock([]);

    // An empty section would be a dead end. This one is an instruction.
    expect(block).toContain("none recorded yet");
    expect(block).toContain("brain_remember");
  });

  it("drops whole rules at the budget and says how many are missing", async () => {
    const long = Array.from({ length: 20 }, (_, i) =>
      directive({ id: `d${i}`, title: `Rule ${i}`, body: "y".repeat(200) })
    );

    const block = renderDirectiveBlock(long);

    expect(block.length).toBeLessThanOrEqual(DIRECTIVE_BUDGET + 200);
    // Half a rule is worse than a missing one: the agent cannot tell it read half.
    expect(block).not.toMatch(/Rule \d+: y+$/);
    expect(block).toMatch(/\(\d+ more not shown/);
  });

  it("says nothing about omissions when everything fits", async () => {
    const block = renderDirectiveBlock([directive()]);

    expect(block).not.toContain("more not shown");
  });

  it("never returns an empty block, even for one unreadably long rule", async () => {
    const block = renderDirectiveBlock([directive({ body: "z".repeat(DIRECTIVE_BUDGET * 2) })]);

    expect(block).toContain("none recorded yet");
  });
});
