import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { keyHasScope } from "@/lib/auth/api-key";
import {
  BRAIN_API_SCOPES,
  DEFAULT_BRAIN_AGENT_SCOPES,
  brainScopeSatisfied,
  type BrainApiScope,
} from "@/lib/brain/constants";
import { BrainError } from "@/lib/brain/errors";
import {
  effectiveGrantScopes,
  requireGrant,
  type McpPrincipal,
} from "@/lib/brain/mcp/principal";

/**
 * ONE authorization semantics for both transports.
 *
 * A brain agent can reach its memories two ways: over HTTP through
 * `lib/brain/access.ts`, or over MCP through `lib/brain/mcp/principal.ts`. Those
 * are separate code paths, and they used to disagree — MCP filtered grant scopes
 * against the literal `BRAIN_API_SCOPES` list (silently discarding `brain.full`)
 * and then tested membership with a bare `includes`, so `brain.full` and
 * `brain.write`→`brain.link` opened REST routes while the equivalent MCP tool
 * answered "Missing scope".
 *
 * It failed closed, so nothing was exploitable. It was still a bug worth a
 * regression test: the next divergence has no reason to fail in the safe
 * direction. These tests assert the two paths return the same verdict for every
 * (key scopes × grant scopes × required scope) combination below.
 */

const BRAIN_A = "aaaaaaaa-1111-4111-8111-111111111111";

function principalWithScopes(scopes: BrainApiScope[]): McpPrincipal {
  return {
    type: "agent",
    id: "agent-1",
    userId: "user-1",
    agentId: "agent-1",
    agentName: "OpenClaw",
    apiKeyId: "key-1",
    grants: [{ brainId: BRAIN_A, brainName: "Personal", isDefault: true, scopes }],
  };
}

/**
 * The REST verdict, as `lib/brain/access.ts` computes it: `requireAuthOrApiKey`
 * checks the API key's scopes, then `resolvePrincipal` checks the brain_access row
 * with `brainScopeSatisfied`. Both must pass.
 */
function restAllows(
  keyScopes: readonly string[],
  grantScopes: readonly string[],
  required: BrainApiScope
): boolean {
  return (
    keyHasScope([...keyScopes], required) && brainScopeSatisfied(grantScopes, required)
  );
}

/**
 * The MCP verdict, using the real functions: `resolveMcpPrincipal` precomputes
 * effective scopes per grant, `requireGrant` enforces them per tool call.
 */
function mcpAllows(
  keyScopes: readonly string[],
  grantScopes: readonly string[],
  required: BrainApiScope
): boolean {
  const principal = principalWithScopes(effectiveGrantScopes(grantScopes, keyScopes));
  try {
    requireGrant(principal, BRAIN_A, required);
    return true;
  } catch (error) {
    // A denial must be a typed 403, never a crash.
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).status).toBe(403);
    return false;
  }
}

/** What an API key may carry, including storage-only and master keys. */
const KEY_SCOPE_SETS: ReadonlyArray<readonly string[]> = [
  [],
  ["brain.read"],
  ["brain.read", "brain.search"],
  ["brain.write"],
  [...DEFAULT_BRAIN_AGENT_SCOPES],
  ["brain.full"],
  ["brain.read", "brain.delete"],
  [...BRAIN_API_SCOPES],
  ["read", "write", "delete", "full"],
  ["supreme"],
];

/** What a brain_access row may carry, including legacy and malformed values. */
const GRANT_SCOPE_SETS: ReadonlyArray<readonly string[]> = [
  [],
  ["brain.read"],
  ["brain.write"],
  ["brain.link"],
  [...DEFAULT_BRAIN_AGENT_SCOPES],
  ["brain.full"],
  ["brain.read", "brain.delete"],
  ["brain.read", "brain.export", "brain.import", "brain.consolidate"],
  [...BRAIN_API_SCOPES],
  ["nonsense", "brain.read"],
  ["BRAIN.READ"],
];

describe("MCP and REST agree on every scope decision", () => {
  it("returns the same verdict for the whole cross product", () => {
    const mismatches: string[] = [];
    for (const keyScopes of KEY_SCOPE_SETS) {
      for (const grantScopes of GRANT_SCOPE_SETS) {
        for (const required of BRAIN_API_SCOPES) {
          const rest = restAllows(keyScopes, grantScopes, required);
          const mcp = mcpAllows(keyScopes, grantScopes, required);
          if (rest !== mcp) {
            mismatches.push(
              `key=[${keyScopes}] grant=[${grantScopes}] need=${required} rest=${rest} mcp=${mcp}`
            );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("covers a meaningful number of allow decisions, not just denials", () => {
    // Guards against the degenerate way this suite could pass: both paths denying
    // everything would also "agree".
    let allowed = 0;
    for (const keyScopes of KEY_SCOPE_SETS) {
      for (const grantScopes of GRANT_SCOPE_SETS) {
        for (const required of BRAIN_API_SCOPES) {
          if (mcpAllows(keyScopes, grantScopes, required)) allowed += 1;
        }
      }
    }
    expect(allowed).toBeGreaterThan(50);
  });
});

describe("the two regressions this fix closed", () => {
  it("honours brain.full on MCP, exactly as REST does", () => {
    // Before: brain.full was filtered out of the grant's scopes (it is not a member
    // of BRAIN_API_SCOPES), leaving the agent with nothing.
    for (const scope of BRAIN_API_SCOPES) {
      expect(mcpAllows(["brain.full"], ["brain.full"], scope)).toBe(true);
      expect(restAllows(["brain.full"], ["brain.full"], scope)).toBe(true);
    }
  });

  it("lets brain.write cover brain.link on MCP, exactly as REST does", () => {
    // Keys issued before brain.link existed keep working with brain_link.
    expect(mcpAllows(["brain.write"], ["brain.write"], "brain.link")).toBe(true);
    expect(restAllows(["brain.write"], ["brain.write"], "brain.link")).toBe(true);
  });
});

describe("effectiveGrantScopes is an intersection, so narrowing either side narrows the agent", () => {
  it("never returns a scope the API key lacks", () => {
    for (const keyScopes of KEY_SCOPE_SETS) {
      for (const grantScopes of GRANT_SCOPE_SETS) {
        for (const scope of effectiveGrantScopes(grantScopes, keyScopes)) {
          expect(keyHasScope([...keyScopes], scope)).toBe(true);
        }
      }
    }
  });

  it("never returns a scope the grant does not confer", () => {
    for (const keyScopes of KEY_SCOPE_SETS) {
      for (const grantScopes of GRANT_SCOPE_SETS) {
        for (const scope of effectiveGrantScopes(grantScopes, keyScopes)) {
          expect(brainScopeSatisfied(grantScopes, scope)).toBe(true);
        }
      }
    }
  });

  it("drops unknown and mis-cased scope strings instead of trusting them", () => {
    expect(effectiveGrantScopes(["nonsense", "BRAIN.READ"], [...BRAIN_API_SCOPES])).toEqual([]);
  });

  it("returns nothing for a storage-only key, however broad the grant", () => {
    // §8: the storage `full` scope must never reach the brain.
    expect(effectiveGrantScopes(["brain.full"], ["read", "write", "delete", "full"])).toEqual(
      []
    );
  });
});

describe("neither path may reintroduce a local scope check", () => {
  const sources = {
    "lib/brain/access.ts": readFileSync("lib/brain/access.ts", "utf8"),
    "lib/brain/mcp/principal.ts": readFileSync("lib/brain/mcp/principal.ts", "utf8"),
  };

  it("routes both enforcement points through the shared predicate", () => {
    for (const [file, source] of Object.entries(sources)) {
      expect(source, `${file} must call brainScopeSatisfied`).toContain(
        "brainScopeSatisfied("
      );
    }
  });

  it("has no hand-rolled scopes.includes() membership test", () => {
    // `scopes.includes(scope)` is precisely the drift that was fixed: it ignores
    // brain.full and the implication table.
    for (const [file, source] of Object.entries(sources)) {
      expect(source, `${file} must not test scope membership directly`).not.toMatch(
        /scopes\??\.includes\(\s*(scope|required)/
      );
    }
  });
});
