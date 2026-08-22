import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import type { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";
import type { Brain } from "@/lib/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { BrainConflictError, BrainForbiddenError, BrainNotFoundError } from "./errors";

/**
 * The authorization choke point every /api/brain route goes through.
 *
 * Two properties are load-bearing and both are asserted here rather than assumed:
 * a brain id arriving from the wire is never trusted — it is re-read against the
 * *effective* user before anything else happens — and an agent is authorized twice,
 * once by its key's scopes and again by a brain_access row naming that agent and
 * that brain. Every failure below is a closed door, never a degraded pass.
 *
 * Authentication itself is mocked (it has its own suite); the scope algebra in
 * lib/brain/constants.ts is deliberately NOT mocked, so `brain.full` and the
 * write⇒link implication are checked against the one real implementation.
 */

const requireAuthOrApiKey = vi.fn();

vi.mock("@/lib/auth/api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/api-key")>();
  return {
    ...actual,
    requireAuthOrApiKey: (...args: unknown[]) => requireAuthOrApiKey(...args),
  };
});

const requireBrainForUser = vi.fn();

vi.mock("./brain-service", () => ({
  requireBrainForUser: (...args: unknown[]) => requireBrainForUser(...args),
}));

type SelectCall = { table: string; where: unknown; limit: number | null };

const selects: SelectCall[] = [];
const writes: string[] = [];
const rows = new Map<string, unknown[]>();

/**
 * Only the two tables authorization reads are recorded, so `selects` stays a
 * statement about access.ts alone: loading the real auth module pulls in unrelated
 * app modules (admin settings) that touch the database on import, and their traffic
 * must not show up as a brain read. Writes are recorded rather than thrown for the
 * same reason — the assertion that authorization never mutates lives in a test.
 */
const AUTHZ_TABLES = new Set(["brain_agents", "brain_access"]);

const writeVerb = (verb: string) => (table?: unknown) => {
  const name = table === undefined ? verb : `${verb} ${getTableName(table as never)}`;
  writes.push(name);
  const chain: Record<string, unknown> = {};
  for (const method of ["values", "set", "where", "returning", "onConflictDoNothing", "onConflictDoUpdate"]) {
    chain[method] = () => chain;
  }
  chain.then = <T,>(resolve: (value: unknown[]) => T) => Promise.resolve([]).then(resolve);
  return chain;
};

vi.mock("@/lib/db", () => ({
  db: {
    insert: writeVerb("insert"),
    update: writeVerb("update"),
    delete: writeVerb("delete"),
    execute: writeVerb("execute"),
    transaction: writeVerb("transaction"),
    select() {
      const call: SelectCall = { table: "", where: null, limit: null };
      const chain = {
        from(table: unknown) {
          call.table = getTableName(table as never);
          return chain;
        },
        where(condition: unknown) {
          call.where = condition;
          return chain;
        },
        limit(value: number) {
          call.limit = value;
          return chain;
        },
        then<T>(resolve: (value: unknown[]) => T) {
          if (AUTHZ_TABLES.has(call.table)) selects.push(call);
          return Promise.resolve(rows.get(call.table) ?? []).then(resolve);
        },
      };
      return chain;
    },
  },
}));

const { requireBrainContext, requireBrainOwnerContext, requireBrainOwner } = await import(
  "./access"
);

function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if ("queryChunks" in record) walk(record.queryChunks);
    if ("value" in record) walk(record.value);
    else if (typeof record.name === "string") parts.push(record.name);
  };

  walk(node);
  return parts.join(" ");
}

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const BRAIN = "22222222-2222-4222-8222-222222222222";
const OTHER_BRAIN = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const API_KEY = "55555555-5555-4555-8555-555555555555";

const AGENT_TABLE = getTableName(schema.brainAgents);
const ACCESS_TABLE = getTableName(schema.brainAccess);

const request = {} as NextRequest;

/** A cookie session: the shape `isApiKeySession` must classify as a user. */
function ownerSession(overrides: Record<string, unknown> = {}): SessionUser {
  return { id: USER, effectiveUserId: USER, isImpersonating: false, sessionId: "s1", ...overrides } as unknown as SessionUser;
}

/** An `sk_` key session. `apiKeyId` is what access.ts uses to find the agent row. */
function keySession(overrides: Record<string, unknown> = {}): SessionUser {
  return {
    ...(ownerSession() as unknown as Record<string, unknown>),
    authMethod: "api_key",
    apiKeyId: API_KEY,
    apiKeyScopes: ["full"],
    apiKeyTier: "standard",
    ...overrides,
  } as unknown as SessionUser;
}

function brain(overrides: Partial<Brain> = {}): Brain {
  return {
    id: BRAIN,
    ownerUserId: USER,
    name: "Personal Brain",
    status: "active",
    isDefault: true,
    ...overrides,
  } as unknown as Brain;
}

const agentRow = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT,
  ownerUserId: USER,
  name: "OpenClaw",
  status: "active",
  apiKeyId: API_KEY,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  selects.length = 0;
  writes.length = 0;
  rows.clear();
  requireAuthOrApiKey.mockResolvedValue(ownerSession());
  requireBrainForUser.mockResolvedValue(brain());
});

describe("requireBrainContext — owner over a session cookie", () => {
  it("resolves a user principal and reads no access tables at all", async () => {
    const context = await requireBrainContext(request, BRAIN, ["brain.read"]);

    expect(context.principal).toEqual({
      type: "user",
      id: USER,
      agentId: null,
      agentName: null,
    });
    expect(context.userId).toBe(USER);
    expect(context.brain.id).toBe(BRAIN);
    // A cookie owner needs no grant, so neither table is touched.
    expect(selects).toHaveLength(0);
  });

  it("authorizes against the effective user, not the signed-in identity", async () => {
    // Impersonation makes these differ. Reading the brain for the *session* id would
    // hand an admin someone else's brain, so the effective id is the only one used.
    requireAuthOrApiKey.mockResolvedValue(
      ownerSession({ id: OTHER_USER, effectiveUserId: USER, isImpersonating: true })
    );

    const context = await requireBrainContext(request, BRAIN, ["brain.read"]);

    expect(requireBrainForUser).toHaveBeenCalledWith(BRAIN, USER);
    expect(context.userId).toBe(USER);
  });

  it("forwards the required scopes to authentication", async () => {
    await requireBrainContext(request, BRAIN, ["brain.read", "brain.write"]);

    expect(requireAuthOrApiKey).toHaveBeenCalledWith(request, ["brain.read", "brain.write"]);
  });

  it("never trusts the brain id on the wire: a foreign brain is simply not found", async () => {
    // requireBrainForUser filters on owner_user_id, so a brain belonging to someone
    // else is indistinguishable from one that does not exist — no existence oracle.
    requireBrainForUser.mockRejectedValue(new BrainNotFoundError());

    await expect(requireBrainContext(request, OTHER_BRAIN, ["brain.read"])).rejects.toBeInstanceOf(
      BrainNotFoundError
    );
    expect(selects).toHaveLength(0);
  });

  it("authenticates before it reads anything", async () => {
    requireAuthOrApiKey.mockRejectedValue(new Error("Unauthorized"));

    await expect(requireBrainContext(request, BRAIN, ["brain.read"])).rejects.toThrow(
      "Unauthorized"
    );
    expect(requireBrainForUser).not.toHaveBeenCalled();
    expect(selects).toHaveLength(0);
  });

  it("refuses a write to an archived brain, with a 409", async () => {
    requireBrainForUser.mockResolvedValue(brain({ status: "archived" }));

    const error = await requireBrainContext(request, BRAIN, ["brain.write"], {
      write: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainConflictError);
    expect((error as BrainConflictError).status).toBe(409);
  });

  it("still allows reads of an archived brain", async () => {
    // Archiving makes a brain read-only; it does not make its knowledge unreachable.
    requireBrainForUser.mockResolvedValue(brain({ status: "archived" }));

    const context = await requireBrainContext(request, BRAIN, ["brain.read"]);
    expect(context.brain.status).toBe("archived");
  });
});

describe("requireBrainContext — agent over an sk_ key", () => {
  beforeEach(() => {
    requireAuthOrApiKey.mockResolvedValue(keySession());
  });

  it("resolves an agent principal from the agent row and its grant", async () => {
    rows.set(AGENT_TABLE, [agentRow()]);
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.read", "brain.search"] }]);

    const context = await requireBrainContext(request, BRAIN, ["brain.read"]);

    expect(context.principal).toEqual({
      type: "agent",
      id: AGENT,
      agentId: AGENT,
      agentName: "OpenClaw",
    });
    // The owner is still the tenant: the agent acts inside its owner's brain.
    expect(context.userId).toBe(USER);
  });

  it("finds the agent row by key AND owner, so a key cannot borrow another tenant's agent", async () => {
    rows.set(AGENT_TABLE, [agentRow()]);
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.read"] }]);

    await requireBrainContext(request, BRAIN, ["brain.read"]);

    const agentRead = selects.find((call) => call.table === AGENT_TABLE);
    expect(agentRead).toBeDefined();
    const predicate = describeSql(agentRead!.where);
    expect(predicate).toContain(API_KEY);
    expect(predicate).toContain(USER);
    expect(agentRead!.limit).toBe(1);
  });

  it("reads the grant for this brain and this agent — not for any brain", async () => {
    rows.set(AGENT_TABLE, [agentRow()]);
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.read"] }]);

    await requireBrainContext(request, BRAIN, ["brain.read"]);

    const grantRead = selects.find((call) => call.table === ACCESS_TABLE);
    expect(grantRead).toBeDefined();
    const predicate = describeSql(grantRead!.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(AGENT);
    expect(predicate).toContain("agent");
    expect(predicate).not.toContain(OTHER_BRAIN);
  });

  it("closes the door when the agent has no grant on this brain", async () => {
    // A grant on brain X is filtered out by the query above, so it arrives here as
    // "no row" — which must be a 403, never a fallback to owner rights.
    rows.set(AGENT_TABLE, [agentRow()]);
    rows.set(ACCESS_TABLE, []);

    const error = await requireBrainContext(request, BRAIN, ["brain.read"]).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainForbiddenError);
    expect((error as BrainForbiddenError).status).toBe(403);
    expect((error as Error).message).toBe("This agent has no access to this brain");
  });

  it("locks out a revoked agent before its grant is even read", async () => {
    rows.set(AGENT_TABLE, [agentRow({ status: "revoked" })]);
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.read"] }]);

    await expect(requireBrainContext(request, BRAIN, ["brain.read"])).rejects.toThrow(
      "This agent has been revoked"
    );
    expect(selects.map((call) => call.table)).toEqual([AGENT_TABLE]);
  });
});

describe("agent scope algebra", () => {
  beforeEach(() => {
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, [agentRow()]);
  });

  it("names the scope it is missing, and does not grant the rest", async () => {
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.read", "brain.search"] }]);

    const error = await requireBrainContext(request, BRAIN, [
      "brain.read",
      "brain.delete",
    ]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainForbiddenError);
    expect((error as Error).message).toBe("Agent is missing scope: brain.delete");
  });

  it("treats an empty grant as no grant", async () => {
    // A brain_access row with no scopes is a real state (created, never configured).
    rows.set(ACCESS_TABLE, [{ scopes: [] }]);

    await expect(requireBrainContext(request, BRAIN, ["brain.read"])).rejects.toBeInstanceOf(
      BrainForbiddenError
    );
  });

  it("survives a null scopes column without granting anything", async () => {
    rows.set(ACCESS_TABLE, [{ scopes: null }]);

    await expect(requireBrainContext(request, BRAIN, ["brain.read"])).rejects.toBeInstanceOf(
      BrainForbiddenError
    );
  });

  it("accepts brain.full for every scope, via the shared scope helper", async () => {
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.full"] }]);

    const context = await requireBrainContext(request, BRAIN, [
      "brain.read",
      "brain.write",
      "brain.delete",
      "brain.export",
    ]);

    expect(context.principal.type).toBe("agent");
  });

  it("honours brain.write ⇒ brain.link, so old grants keep working", async () => {
    // The implication lives in lib/brain/constants.ts; access.ts must not re-derive it.
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.write"] }]);

    const context = await requireBrainContext(request, BRAIN, ["brain.link"]);
    expect(context.principal.agentId).toBe(AGENT);
  });

  it("does not read brain.write out of brain.link", async () => {
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.link"] }]);

    await expect(requireBrainContext(request, BRAIN, ["brain.write"])).rejects.toThrow(
      "Agent is missing scope: brain.write"
    );
  });
});

describe("non-agent key sessions", () => {
  it("acts as the owner for a plain user key that has no agent row", async () => {
    // A user's own `sk_` key with brain.* scopes is the owner, not an agent: it has
    // already passed the key's scope check in requireAuthOrApiKey.
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, []);

    const context = await requireBrainContext(request, BRAIN, ["brain.write"]);

    expect(context.principal).toEqual({ type: "user", id: USER, agentId: null, agentName: null });
    // No agent ⇒ no grant to look for.
    expect(selects.map((call) => call.table)).toEqual([AGENT_TABLE]);
  });

  it("never looks for an agent row behind an OAuth session id", async () => {
    // OAuth sessions carry a synthetic `oauth:<clientId>`; feeding that to a uuid
    // column would be a query error, so it is rejected by shape before the read.
    requireAuthOrApiKey.mockResolvedValue(keySession({ apiKeyId: "oauth:client-1" }));

    const context = await requireBrainContext(request, BRAIN, ["brain.read"]);

    expect(context.principal.type).toBe("user");
    expect(selects).toHaveLength(0);
  });
});

describe("requireBrainOwnerContext", () => {
  it("lets the owner through with the same context", async () => {
    const context = await requireBrainOwnerContext(request, BRAIN, ["brain.export"]);

    expect(context.principal.type).toBe("user");
    expect(context.brain.id).toBe(BRAIN);
  });

  it("refuses an agent even when its grant covers the scope", async () => {
    // The audit trail, agent management and export are owner-only: a valid grant is
    // not the question, the caller's *kind* is.
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, [agentRow()]);
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.full"] }]);

    const error = await requireBrainOwnerContext(request, BRAIN, ["brain.export"]).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainForbiddenError);
    expect((error as Error).message).toBe("This endpoint is restricted to the brain owner");
  });

  it("applies the archived-brain rule before the owner check", async () => {
    requireBrainForUser.mockResolvedValue(brain({ status: "archived" }));

    await expect(
      requireBrainOwnerContext(request, BRAIN, ["brain.import"], { write: true })
    ).rejects.toBeInstanceOf(BrainConflictError);
  });
});

describe("requireBrainOwner — the collection routes", () => {
  it("returns the effective user for a cookie session without any read", async () => {
    const result = await requireBrainOwner(request, ["brain.read"]);

    expect(result.userId).toBe(USER);
    expect(selects).toHaveLength(0);
  });

  it("forwards the required scopes to authentication", async () => {
    await requireBrainOwner(request, ["brain.read"]);
    expect(requireAuthOrApiKey).toHaveBeenCalledWith(request, ["brain.read"]);
  });

  it("allows a plain user key that is not an agent", async () => {
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, []);

    const result = await requireBrainOwner(request, ["brain.read"]);
    expect(result.userId).toBe(USER);
  });

  it("refuses an agent key: creating and listing brains is an owner operation", async () => {
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, [agentRow()]);

    const error = await requireBrainOwner(request, ["brain.read"]).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainForbiddenError);
    expect((error as Error).message).toBe("Agent keys cannot manage brains");
  });

  it("refuses a revoked agent key here too", async () => {
    // The lookup is by key, not by status: a revoked agent is still an agent, and
    // must not fall through to owner rights on this route.
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, [agentRow({ status: "revoked" })]);

    await expect(requireBrainOwner(request, ["brain.read"])).rejects.toBeInstanceOf(
      BrainForbiddenError
    );
  });

  it("does not query for an agent behind an OAuth session id", async () => {
    requireAuthOrApiKey.mockResolvedValue(keySession({ apiKeyId: "oauth:client-1" }));

    const result = await requireBrainOwner(request, ["brain.read"]);

    expect(result.userId).toBe(USER);
    expect(selects).toHaveLength(0);
  });
});

describe("authorization is read-only", () => {
  it("never writes, on any of its three paths", async () => {
    // No audit row, no last-seen touch, no lazily created grant: deciding whether a
    // caller may proceed must not itself change what the caller may do.
    requireAuthOrApiKey.mockResolvedValue(keySession());
    rows.set(AGENT_TABLE, [agentRow()]);
    rows.set(ACCESS_TABLE, [{ scopes: ["brain.full"] }]);

    await requireBrainContext(request, BRAIN, ["brain.write"], { write: true });
    await requireBrainOwner(request, ["brain.read"]).catch(() => undefined);
    await requireBrainOwnerContext(request, BRAIN, ["brain.read"]).catch(() => undefined);

    expect(writes).toEqual([]);
  });
});
