import { describe, it, expect } from "vitest";
import { requireGrant, type McpPrincipal } from "@/lib/brain/mcp/principal";
import { BrainError } from "@/lib/brain/errors";

const BRAIN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BRAIN_B = "bbbbbbbb-2222-4222-8222-222222222222";
const BRAIN_OTHER = "cccccccc-3333-4333-8333-333333333333";

function principal(grants: McpPrincipal["grants"]): McpPrincipal {
  return {
    type: "agent",
    id: "agent-1",
    userId: "user-1",
    agentId: "agent-1",
    agentName: "OpenClaw",
    apiKeyId: "key-1",
    grants,
  };
}

const readOnlyOnA = principal([
  { brainId: BRAIN_A, brainName: "Personal", isDefault: true, scopes: ["brain.read", "brain.search"] },
]);

describe("requireGrant — brain selection", () => {
  it("falls back to the default brain when none is named", () => {
    expect(requireGrant(readOnlyOnA, undefined, "brain.read").brainId).toBe(BRAIN_A);
  });

  it("prefers the default grant over the first when several exist", () => {
    const multi = principal([
      { brainId: BRAIN_A, brainName: "Work", isDefault: false, scopes: ["brain.read"] },
      { brainId: BRAIN_B, brainName: "Personal", isDefault: true, scopes: ["brain.read"] },
    ]);
    expect(requireGrant(multi, undefined, "brain.read").brainId).toBe(BRAIN_B);
  });

  it("honours an explicitly named brain the credential holds", () => {
    const multi = principal([
      { brainId: BRAIN_A, brainName: "Work", isDefault: true, scopes: ["brain.read"] },
      { brainId: BRAIN_B, brainName: "Personal", isDefault: false, scopes: ["brain.read"] },
    ]);
    expect(requireGrant(multi, BRAIN_B, "brain.read").brainId).toBe(BRAIN_B);
  });
});

describe("requireGrant — isolation (§46: agent A must not reach brain B)", () => {
  it("refuses a brain id that is not in the grant list, even a well-formed one", () => {
    // The whole point: an agent that guesses or is handed another brain's UUID
    // gets 404, never that brain's data.
    expect(() => requireGrant(readOnlyOnA, BRAIN_OTHER, "brain.read")).toThrow(BrainError);
    try {
      requireGrant(readOnlyOnA, BRAIN_OTHER, "brain.read");
    } catch (error) {
      expect((error as BrainError).status).toBe(404);
      expect((error as BrainError).code).toBe("BRAIN_NOT_FOUND");
    }
  });

  it("refuses everything when the credential holds no grants at all", () => {
    const orphan = principal([]);
    for (const scope of ["brain.read", "brain.search", "brain.write"] as const) {
      expect(() => requireGrant(orphan, undefined, scope)).toThrow(BrainError);
    }
  });
});

describe("requireGrant — scope enforcement", () => {
  it("blocks a scope the grant does not include", () => {
    for (const scope of ["brain.write", "brain.delete", "brain.export"] as const) {
      try {
        requireGrant(readOnlyOnA, BRAIN_A, scope);
        throw new Error(`expected ${scope} to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(BrainError);
        expect((error as BrainError).status).toBe(403);
      }
    }
  });

  it("allows the scopes the grant does include", () => {
    expect(requireGrant(readOnlyOnA, BRAIN_A, "brain.read").brainId).toBe(BRAIN_A);
    expect(requireGrant(readOnlyOnA, BRAIN_A, "brain.search").brainId).toBe(BRAIN_A);
  });

  it("checks the scope of the named brain, not of any brain in the list", () => {
    // Write access to one brain must not leak into a read-only grant on another.
    const mixed = principal([
      { brainId: BRAIN_A, brainName: "ReadOnly", isDefault: true, scopes: ["brain.read"] },
      { brainId: BRAIN_B, brainName: "Writable", isDefault: false, scopes: ["brain.read", "brain.write"] },
    ]);
    expect(requireGrant(mixed, BRAIN_B, "brain.write").brainId).toBe(BRAIN_B);
    expect(() => requireGrant(mixed, BRAIN_A, "brain.write")).toThrow(BrainError);
  });
});
