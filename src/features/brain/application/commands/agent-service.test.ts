import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/shared/infrastructure/db/schema";
import { BrainAgentNotFoundError, BrainConflictError, BrainValidationError } from "@brain/domain/errors";

/**
 * Minting, re-scoping and killing agents — the only place in the app that hands out a
 * credential able to reach a brain.
 *
 * Four properties are asserted here rather than trusted. A refusal happens *before*
 * any key is minted, so a rejected request never leaves a live credential behind. The
 * key, the agent row and the grant are one transaction, and if the transaction fails
 * the key is deleted — no orphaned credential. Scopes are normalized through the one
 * shared helper, so an unknown or destructive scope cannot be smuggled in by a
 * caller. And revoking an agent takes away all three of its footholds: status, grants
 * and key.
 *
 * The database is a recording fake and `createNamespacedApiKey` is mocked (it hashes
 * with argon2 and has its own suite); the scope algebra in @brain/domain/constants.ts is
 * deliberately real.
 */

type Rows = Record<string, unknown[][]>;
type WriteCall = {
  verb: "insert" | "update" | "delete";
  table: string;
  values?: Record<string, unknown>;
  conflict?: string[];
  set?: Record<string, unknown>;
  where?: unknown;
  inTransaction: boolean;
};
type ReadCall = { table: string; where: unknown; limit: number | null; order: unknown };

/** Flatten a Drizzle predicate into a searchable string (columns hold circular refs). */
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

const reads: ReadCall[] = [];
const writes: WriteCall[] = [];
let rows: Rows = {};
const cursors = new Map<string, number>();
/** Depth > 0 means the statement was issued through db.transaction's handle. */
let txDepth = 0;
let transactions = 0;
/** Set by a test to make one statement fail, so rollback behaviour is observable. */
let failOn: { verb: string; table: string } | null = null;

function selectChain() {
  const call: ReadCall = { table: "", where: null, limit: null, order: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy(...args: unknown[]) {
      call.order = args;
      return chain;
    },
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T) {
      reads.push(call);
      const index = cursors.get(call.table) ?? 0;
      cursors.set(call.table, index + 1);
      return Promise.resolve(rows[call.table]?.[index] ?? []).then(resolve);
    },
  };
  return chain;
}

/** Records the statement once, whether it is awaited directly or via returning(). */
function settle(call: WriteCall, fallback: unknown[]): Promise<unknown[]> {
  writes.push(call);
  if (failOn && failOn.verb === call.verb && failOn.table === call.table) {
    return Promise.reject(new Error("grant insert exploded"));
  }
  return Promise.resolve(fallback);
}

function insertChain(table: unknown) {
  const call: WriteCall = {
    verb: "insert",
    table: getTableName(table as never),
    inTransaction: txDepth > 0,
  };
  const chain = {
    values(values: Record<string, unknown>) {
      call.values = values;
      return chain;
    },
    onConflictDoUpdate(config: { target: unknown; set: Record<string, unknown> }) {
      call.conflict = (config.target as Array<{ name: string }>).map((column) => column.name);
      call.set = config.set;
      return chain;
    },
    returning: () => settle(call, rows[`__insert:${call.table}`]?.[0] ?? [{ id: "agent-1", ...call.values }]),
    then<T>(resolve: (value: unknown[]) => T, reject?: (reason: unknown) => T) {
      return settle(call, []).then(resolve, reject);
    },
  };
  return chain;
}

function updateChain(table: unknown) {
  const call: WriteCall = {
    verb: "update",
    table: getTableName(table as never),
    inTransaction: txDepth > 0,
  };
  const chain = {
    set(patch: Record<string, unknown>) {
      call.values = patch;
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    returning: () => settle(call, rows.__update?.[0] ?? [{ id: "agent-1", ...call.values }]),
  };
  return chain;
}

function deleteChain(table: unknown) {
  const call: WriteCall = {
    verb: "delete",
    table: getTableName(table as never),
    inTransaction: txDepth > 0,
  };
  const chain = {
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    returning: () => settle(call, rows[`__delete:${call.table}`]?.[0] ?? []),
    then<T>(resolve: (value: unknown[]) => T, reject?: (reason: unknown) => T) {
      return settle(call, []).then(resolve, reject);
    },
  };
  return chain;
}

const handle = {
  select: () => selectChain(),
  insert: insertChain,
  update: updateChain,
  delete: deleteChain,
};

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    ...handle,
    async transaction<T>(callback: (tx: typeof handle) => Promise<T>): Promise<T> {
      transactions += 1;
      txDepth += 1;
      try {
        return await callback(handle);
      } finally {
        txDepth -= 1;
      }
    },
  },
}));

const createNamespacedApiKey = vi.fn();

vi.mock("@/shared/lib/auth/api-key", () => ({
  createNamespacedApiKey: (...args: unknown[]) => createNamespacedApiKey(...args),
}));

const {
  createBrainAgent,
  listBrainAgents,
  listAgentsForBrain,
  grantBrainAccess,
  revokeBrainAccess,
  revokeBrainAgent,
  MAX_AGENTS_PER_USER,
} = await import("./agent-service");
const { DEFAULT_BRAIN_AGENT_SCOPES } = await import("@brain/domain/constants");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const BRAIN = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";
const RAW_KEY = "sk_this_is_returned_exactly_once";

const AGENT_TABLE = getTableName(schema.brainAgents);
const ACCESS_TABLE = getTableName(schema.brainAccess);
const KEY_TABLE = getTableName(schema.apiKeys);

const agentRow = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT,
  ownerUserId: USER,
  name: "OpenClaw",
  description: null,
  type: "agent",
  status: "active",
  apiKeyId: KEY,
  ...overrides,
});

const readOf = (table: string, index = 0): ReadCall | undefined =>
  reads.filter((call) => call.table === table)[index];
const writeOf = (verb: string, table: string): WriteCall | undefined =>
  writes.find((call) => call.verb === verb && call.table === table);

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  writes.length = 0;
  rows = {};
  cursors.clear();
  txDepth = 0;
  transactions = 0;
  failOn = null;
  createNamespacedApiKey.mockResolvedValue({ id: KEY, rawKey: RAW_KEY });
});

describe("createBrainAgent refuses before it mints anything", () => {
  it("rejects a blank name without touching the database or the key issuer", async () => {
    const error = await createBrainAgent({ userId: USER, brainId: BRAIN, name: "  " }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as Error).message).toBe("Agent name is required");
    expect(createNamespacedApiKey).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("rejects a scope list that normalizes to nothing, rather than falling back to defaults", async () => {
    // An unrecognized scope name must not quietly become "the default set" — that
    // would turn a typo into brain.write.
    const error = await createBrainAgent({
      userId: USER,
      brainId: BRAIN,
      name: "OpenClaw",
      scopes: ["brain.everything", "admin"],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrainValidationError);
    expect((error as Error).message).toBe("At least one brain scope is required");
    expect(createNamespacedApiKey).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("refuses at the active-agent cap with no credential created", async () => {
    // The order matters: minting first and then hitting the cap would leave a live
    // `sk_` key with no agent row behind it.
    rows[AGENT_TABLE] = [Array.from({ length: MAX_AGENTS_PER_USER }, (_, i) => ({ id: `a${i}` }))];

    const error = await createBrainAgent({ userId: USER, brainId: BRAIN, name: "OpenClaw" }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainConflictError);
    expect((error as Error).message).toBe(`Maximum ${MAX_AGENTS_PER_USER} active agents allowed`);
    expect(createNamespacedApiKey).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("counts only this user's active agents toward the cap", async () => {
    rows[AGENT_TABLE] = [[]];

    await createBrainAgent({ userId: USER, brainId: BRAIN, name: "OpenClaw" });

    const predicate = describeSql(readOf(AGENT_TABLE)!.where);
    expect(predicate).toContain(USER);
    expect(predicate).toContain("active");
    expect(predicate).not.toContain(OTHER_USER);
  });
});

describe("createBrainAgent — the credential, the agent and the grant", () => {
  beforeEach(() => {
    rows[AGENT_TABLE] = [[]];
    rows[`__insert:${AGENT_TABLE}`] = [[agentRow()]];
  });

  it("mints a namespaced key carrying only the brain scopes", async () => {
    await createBrainAgent({ userId: USER, brainId: BRAIN, name: "  OpenClaw  " });

    expect(createNamespacedApiKey).toHaveBeenCalledWith(
      USER,
      "brain:OpenClaw",
      [...DEFAULT_BRAIN_AGENT_SCOPES],
      null
    );
  });

  it("defaults to read/search/write/link — never to delete, export or consolidate", async () => {
    await createBrainAgent({ userId: USER, brainId: BRAIN, name: "OpenClaw" });

    const scopes = writeOf("insert", ACCESS_TABLE)!.values!.scopes as string[];
    expect(scopes).toEqual(["brain.read", "brain.search", "brain.write", "brain.link"]);
    expect(scopes).not.toContain("brain.delete");
    expect(scopes).not.toContain("brain.full");
  });

  it("drops unknown scopes from a caller-supplied list and keeps the rest", async () => {
    const { agent } = await createBrainAgent({
      userId: USER,
      brainId: BRAIN,
      name: "OpenClaw",
      scopes: ["brain.read", "brain.read", "nonsense", "brain.consolidate"],
    });

    expect(agent.scopes).toEqual(["brain.read", "brain.consolidate"]);
    expect(createNamespacedApiKey).toHaveBeenCalledWith(
      USER,
      "brain:OpenClaw",
      ["brain.read", "brain.consolidate"],
      null
    );
  });

  it("writes the agent row and its grant inside one transaction", async () => {
    await createBrainAgent({
      userId: USER,
      brainId: BRAIN,
      name: "OpenClaw",
      description: "  reads docs  ",
      type: "  worker  ",
    });

    expect(transactions).toBe(1);
    expect(writeOf("insert", AGENT_TABLE)!.inTransaction).toBe(true);
    expect(writeOf("insert", ACCESS_TABLE)!.inTransaction).toBe(true);
    expect(writeOf("insert", AGENT_TABLE)!.values).toEqual({
      ownerUserId: USER,
      name: "OpenClaw",
      description: "reads docs",
      type: "worker",
      apiKeyId: KEY,
    });
  });
});

describe("createBrainAgent — the grant and the secret", () => {
  beforeEach(() => {
    rows[AGENT_TABLE] = [[]];
    rows[`__insert:${AGENT_TABLE}`] = [[agentRow()]];
  });

  it("grants the new agent access to the brain it was created for, as an agent", async () => {
    await createBrainAgent({ userId: USER, brainId: BRAIN, name: "OpenClaw" });

    expect(writeOf("insert", ACCESS_TABLE)!.values).toEqual({
      brainId: BRAIN,
      principalType: "agent",
      // The id of the row just inserted, not anything the caller supplied.
      principalId: AGENT,
      role: "agent",
      scopes: [...DEFAULT_BRAIN_AGENT_SCOPES],
    });
  });

  it("returns the raw key once and never stores it", async () => {
    const { rawKey, agent } = await createBrainAgent({
      userId: USER,
      brainId: BRAIN,
      name: "OpenClaw",
    });

    expect(rawKey).toBe(RAW_KEY);
    expect(agent.scopes).toEqual([...DEFAULT_BRAIN_AGENT_SCOPES]);
    // Nothing written anywhere carries the secret — only the key id does.
    expect(JSON.stringify(writes)).not.toContain(RAW_KEY);
  });

  it("deletes the key and rethrows when the transaction fails, leaving no orphan credential", async () => {
    // A live `sk_` key whose agent row never landed would authenticate forever with
    // nobody able to see or revoke it in the UI.
    failOn = { verb: "insert", table: ACCESS_TABLE };

    await expect(
      createBrainAgent({ userId: USER, brainId: BRAIN, name: "OpenClaw" })
    ).rejects.toThrow("grant insert exploded");

    const cleanup = writeOf("delete", KEY_TABLE);
    expect(cleanup).toBeDefined();
    expect(describeSql(cleanup!.where)).toContain(KEY);
    // The cleanup is deliberately outside the failed transaction.
    expect(cleanup!.inTransaction).toBe(false);
  });
});

describe("listing agents", () => {
  it("lists every agent this user owns, oldest first", async () => {
    rows[AGENT_TABLE] = [[agentRow(), agentRow({ id: OTHER_AGENT })]];

    const agents = await listBrainAgents(USER);

    expect(agents).toHaveLength(2);
    const read = readOf(AGENT_TABLE)!;
    expect(describeSql(read.where)).toContain(USER);
    expect(describeSql(read.order)).toContain("created_at");
  });

  it("stops after one query when no agent holds a grant on the brain", async () => {
    // No grants means there is nothing to filter agents by; issuing the second query
    // anyway would either return every agent the user owns or need a JS filter.
    rows[ACCESS_TABLE] = [[]];

    expect(await listAgentsForBrain(BRAIN, USER)).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(readOf(AGENT_TABLE)).toBeUndefined();
  });

  it("returns only granted agents, each carrying the scopes of its grant", async () => {
    rows[ACCESS_TABLE] = [
      [
        { principalId: AGENT, scopes: ["brain.read", "brain.search"] },
        { principalId: OTHER_AGENT, scopes: null },
      ],
    ];
    rows[AGENT_TABLE] = [[agentRow(), agentRow({ id: OTHER_AGENT, name: "Indexer" })]];

    const agents = await listAgentsForBrain(BRAIN, USER);

    expect(agents.map((agent) => [agent.id, agent.scopes])).toEqual([
      [AGENT, ["brain.read", "brain.search"]],
      // A grant row with a NULL scopes column is an empty grant, not a wildcard.
      [OTHER_AGENT, []],
    ]);
  });

  it("filters the agent query by owner AND by the granted ids", async () => {
    rows[ACCESS_TABLE] = [[{ principalId: AGENT, scopes: ["brain.read"] }]];
    rows[AGENT_TABLE] = [[agentRow()]];

    await listAgentsForBrain(BRAIN, USER);

    const grants = describeSql(readOf(ACCESS_TABLE)!.where);
    expect(grants).toContain(BRAIN);
    expect(grants).toContain("agent");

    const agents = describeSql(readOf(AGENT_TABLE)!.where);
    expect(agents).toContain(USER);
    expect(agents).toContain(AGENT);
    expect(agents).not.toContain(OTHER_AGENT);
  });
});

describe("grantBrainAccess", () => {
  it("refuses an agent this user does not own, before any write", async () => {
    // The agent id arrives from the wire; the owner is in the predicate, so another
    // tenant's agent cannot be handed a grant on this brain.
    rows[AGENT_TABLE] = [[]];

    await expect(
      grantBrainAccess({ brainId: BRAIN, userId: USER, agentId: AGENT })
    ).rejects.toBeInstanceOf(BrainAgentNotFoundError);
    expect(describeSql(readOf(AGENT_TABLE)!.where)).toContain(USER);
    expect(writes).toEqual([]);
  });

  it("refuses a revoked agent instead of quietly reviving it", async () => {
    rows[AGENT_TABLE] = [[agentRow({ status: "revoked" })]];

    const error = await grantBrainAccess({ brainId: BRAIN, userId: USER, agentId: AGENT }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(BrainConflictError);
    expect((error as Error).message).toBe("This agent has been revoked");
    expect(writes).toEqual([]);
  });

  it("upserts one grant per (brain, principal), so re-scoping replaces rather than stacks", async () => {
    rows[AGENT_TABLE] = [[agentRow()]];

    const scopes = await grantBrainAccess({
      brainId: BRAIN,
      userId: USER,
      agentId: AGENT,
      scopes: ["brain.read", "brain.delete", "garbage"],
    });

    expect(scopes).toEqual(["brain.read", "brain.delete"]);
    const write = writeOf("insert", ACCESS_TABLE)!;
    expect(write.conflict).toEqual(["brain_id", "principal_type", "principal_id"]);
    expect(write.values).toEqual({
      brainId: BRAIN,
      principalType: "agent",
      principalId: AGENT,
      role: "agent",
      scopes: ["brain.read", "brain.delete"],
    });
    // Re-scoping overwrites the scope list; it never merges with the old one.
    expect(write.set!.scopes).toEqual(["brain.read", "brain.delete"]);
  });

  it("refuses a scope list that normalizes to nothing", async () => {
    rows[AGENT_TABLE] = [[agentRow()]];

    await expect(
      grantBrainAccess({ brainId: BRAIN, userId: USER, agentId: AGENT, scopes: ["nope"] })
    ).rejects.toBeInstanceOf(BrainValidationError);
    expect(writes).toEqual([]);
  });

  it("falls back to the default scopes when none are given", async () => {
    rows[AGENT_TABLE] = [[agentRow()]];

    const scopes = await grantBrainAccess({ brainId: BRAIN, userId: USER, agentId: AGENT });
    expect(scopes).toEqual([...DEFAULT_BRAIN_AGENT_SCOPES]);
  });
});

describe("revokeBrainAccess — one brain, not the whole agent", () => {
  it("deletes the grant for this brain only, leaving the key valid elsewhere", async () => {
    rows[AGENT_TABLE] = [[agentRow()]];
    rows[`__delete:${ACCESS_TABLE}`] = [[{ id: "grant-1" }]];

    expect(await revokeBrainAccess({ brainId: BRAIN, userId: USER, agentId: AGENT })).toBe(true);

    const predicate = describeSql(writeOf("delete", ACCESS_TABLE)!.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).toContain(AGENT);
    expect(predicate).toContain("agent");
    // The agent row and its API key are untouched.
    expect(writeOf("update", AGENT_TABLE)).toBeUndefined();
    expect(writeOf("delete", KEY_TABLE)).toBeUndefined();
  });

  it("reports false when the agent had no grant on this brain", async () => {
    rows[AGENT_TABLE] = [[agentRow()]];

    expect(await revokeBrainAccess({ brainId: BRAIN, userId: USER, agentId: AGENT })).toBe(false);
  });

  it("refuses an agent owned by someone else without deleting anything", async () => {
    rows[AGENT_TABLE] = [[]];

    await expect(
      revokeBrainAccess({ brainId: BRAIN, userId: OTHER_USER, agentId: AGENT })
    ).rejects.toBeInstanceOf(BrainAgentNotFoundError);
    expect(writes).toEqual([]);
  });
});

describe("revokeBrainAgent takes away all three footholds", () => {
  it("marks the agent revoked, drops every grant and deletes the key, in one transaction", async () => {
    rows[AGENT_TABLE] = [[agentRow()]];
    rows.__update = [[agentRow({ status: "revoked" })]];

    const revoked = await revokeBrainAgent(USER, AGENT);

    expect(revoked.status).toBe("revoked");
    expect(transactions).toBe(1);

    const status = writeOf("update", AGENT_TABLE)!;
    expect(status.values).toMatchObject({ status: "revoked" });
    expect(describeSql(status.where)).toContain(AGENT);

    // Every grant, not just the one on some brain: a lingering row would come back to
    // life if the agent id were ever reused.
    const grants = writeOf("delete", ACCESS_TABLE)!;
    expect(describeSql(grants.where)).toContain(AGENT);
    expect(describeSql(grants.where)).not.toContain(BRAIN);

    // And the credential itself, or it would keep authenticating on non-brain routes.
    expect(describeSql(writeOf("delete", KEY_TABLE)!.where)).toContain(KEY);
    expect(writes.every((write) => write.inTransaction)).toBe(true);
  });

  it("skips the key delete for an agent that has no key", async () => {
    rows[AGENT_TABLE] = [[agentRow({ apiKeyId: null })]];

    await revokeBrainAgent(USER, AGENT);

    expect(writeOf("delete", KEY_TABLE)).toBeUndefined();
    expect(writeOf("update", AGENT_TABLE)).toBeDefined();
    expect(writeOf("delete", ACCESS_TABLE)).toBeDefined();
  });

  it("refuses an agent this user does not own, and writes nothing", async () => {
    rows[AGENT_TABLE] = [[]];

    await expect(revokeBrainAgent(OTHER_USER, AGENT)).rejects.toBeInstanceOf(
      BrainAgentNotFoundError
    );
    expect(transactions).toBe(0);
    expect(writes).toEqual([]);
  });
});

