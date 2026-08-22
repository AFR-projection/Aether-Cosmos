import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrainError } from "@/lib/brain/errors";
import type { McpPrincipal } from "./principal";

/**
 * What each MCP tool actually does with a call that is allowed through.
 *
 * The fail-closed half of this surface lives in server.test.ts; this is the other
 * half, and it is where the tenant boundary is really decided: every tool receives
 * a `brainId` argument from the wire and must hand the Brain service layer the
 * brain that `requireGrant` resolved instead — for the default brain, for a second
 * granted brain, and for a brain the credential was never granted.
 *
 * The rest is about what comes back out. MCP output lands directly in an agent's
 * context window and audit rows outlive the agent, so lists return summaries,
 * `brain_context` never repeats the bodies it already packed into `contextText`,
 * and audit metadata records counts rather than what the brain knows.
 *
 * Every service below is mocked: this file is about the boundary, not about
 * retrieval — and a mocked service means an unauthorized call has nothing to fall
 * through to.
 */

const logBrainAudit = vi.fn();
const publishToUser = vi.fn();
const searchMemories = vi.fn();
const getMemory = vi.fn();
const listMemories = vi.fn();
const getMemoryVersions = vi.fn();
const listBrainTags = vi.fn();
const updateMemory = vi.fn();
const deleteMemory = vi.fn();
const listEntities = vi.fn();
const listRelationships = vi.fn();
const upsertEntity = vi.fn();
const upsertRelationship = vi.fn();
const getMemoryLinks = vi.fn();
const linkMemory = vi.fn();
const consolidateBrain = vi.fn();
const buildBrainContext = vi.fn();
const findBrainMemoryPath = vi.fn();
const getBrainRelatedMemories = vi.fn();
const getMemoryTimeline = vi.fn();
const getMemoryProvenance = vi.fn();
const getBrainHealth = vi.fn();
const syncBrainReviewQueue = vi.fn();
const recordMemoryFeedback = vi.fn();
const listProjects = vi.fn();
const recallBrainContext = vi.fn();
const rememberMemory = vi.fn();

/**
 * Each service is stubbed on top of its real module rather than in place of it: the
 * tool schemas are built at registration time from real constants
 * (`CONTEXT_TOKEN_BUDGET_MAX`, `MEMORY_TYPES`, …), and a factory that returned only
 * the functions under test would quietly drop them.
 */
type Original = Record<string, unknown>;

vi.mock("@/lib/brain/audit", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  logBrainAudit: (...args: unknown[]) => logBrainAudit(...args),
}));

vi.mock("@/lib/realtime/events", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  publishToUser: (...args: unknown[]) => publishToUser(...args),
}));

vi.mock("@/lib/brain/memory-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  searchMemories: (...args: unknown[]) => searchMemories(...args),
  getMemory: (...args: unknown[]) => getMemory(...args),
  listMemories: (...args: unknown[]) => listMemories(...args),
  getMemoryVersions: (...args: unknown[]) => getMemoryVersions(...args),
  listBrainTags: (...args: unknown[]) => listBrainTags(...args),
  updateMemory: (...args: unknown[]) => updateMemory(...args),
  deleteMemory: (...args: unknown[]) => deleteMemory(...args),
}));

vi.mock("@/lib/brain/graph-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  listEntities: (...args: unknown[]) => listEntities(...args),
  listRelationships: (...args: unknown[]) => listRelationships(...args),
  upsertEntity: (...args: unknown[]) => upsertEntity(...args),
  upsertRelationship: (...args: unknown[]) => upsertRelationship(...args),
}));

vi.mock("@/lib/brain/link-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  getMemoryLinks: (...args: unknown[]) => getMemoryLinks(...args),
  linkMemory: (...args: unknown[]) => linkMemory(...args),
}));

vi.mock("@/lib/brain/consolidation-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  consolidateBrain: (...args: unknown[]) => consolidateBrain(...args),
}));

vi.mock("@/lib/brain/context-engine", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  buildBrainContext: (...args: unknown[]) => buildBrainContext(...args),
}));

vi.mock("@/lib/brain/graph/path-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  findBrainMemoryPath: (...args: unknown[]) => findBrainMemoryPath(...args),
}));

vi.mock("@/lib/brain/graph/related-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  getBrainRelatedMemories: (...args: unknown[]) => getBrainRelatedMemories(...args),
}));

vi.mock("@/lib/brain/temporal-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  getMemoryTimeline: (...args: unknown[]) => getMemoryTimeline(...args),
}));

vi.mock("@/lib/brain/provenance-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  getMemoryProvenance: (...args: unknown[]) => getMemoryProvenance(...args),
}));

vi.mock("@/lib/brain/health-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  getBrainHealth: (...args: unknown[]) => getBrainHealth(...args),
}));

vi.mock("@/lib/brain/review-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  syncBrainReviewQueue: (...args: unknown[]) => syncBrainReviewQueue(...args),
}));

vi.mock("@/lib/brain/feedback-loop", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  recordMemoryFeedback: (...args: unknown[]) => recordMemoryFeedback(...args),
}));

vi.mock("@/lib/brain/project-service", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  listProjects: (...args: unknown[]) => listProjects(...args),
}));

vi.mock("@/lib/brain/recall", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  recallBrainContext: (...args: unknown[]) => recallBrainContext(...args),
}));

vi.mock("@/lib/brain/remember", async (importOriginal) => ({
  ...(await importOriginal<Original>()),
  rememberMemory: (...args: unknown[]) => rememberMemory(...args),
}));

const { createBrainMcpServer } = await import("./server");

const BRAIN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BRAIN_B = "bbbbbbbb-2222-4222-8222-222222222222";
const UNGRANTED_BRAIN = "eeeeeeee-5555-4555-8555-555555555555";
const MEM_A = "cccccccc-3333-4333-8333-333333333333";
const MEM_B = "dddddddd-4444-4444-8444-444444444444";
const PROJECT = "ffffffff-6666-4666-8666-666666666666";

/**
 * Two grants, deliberately unequal: the default brain can be written to and curated,
 * the second is read-only. Every "wrong scope" case below is therefore a real grant
 * on a real brain, not an empty credential.
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
      brainId: BRAIN_A,
      brainName: "Personal Brain",
      isDefault: true,
      scopes: [
        "brain.read",
        "brain.search",
        "brain.write",
        "brain.link",
        "brain.delete",
        "brain.consolidate",
      ],
    },
    { brainId: BRAIN_B, brainName: "Work Brain", isDefault: false, scopes: ["brain.read"] },
  ],
};

type Json = Record<string, unknown>;

/** One tool call over a real in-memory MCP transport, so zod validation runs too. */
async function call(
  name: string,
  args: Record<string, unknown> = {},
  overrides: Partial<McpPrincipal> = {}
): Promise<{ isError: boolean; payload: Json }> {
  const server = createBrainMcpServer({ ...principal, ...overrides });
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0].text;
    return { isError: result.isError === true, payload: JSON.parse(text) as Json };
  } finally {
    await client.close();
    await server.close();
  }
}

/** The call must have been refused; returns the refusal payload for further checks. */
async function refuse(name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const { isError, payload } = await call(name, args);
  expect(isError, `${name} should have been refused`).toBe(true);
  return payload;
}

const CREATED_AT = new Date("2026-01-05T10:00:00.000Z");
const UPDATED_AT = new Date("2026-02-11T09:30:00.000Z");

/** A memory row as the service layer returns it — the input `summarize()` trims. */
const memoryRow = {
  id: MEM_A,
  type: "fact",
  title: "Deploy target",
  summary: "The worker deploys to the VPS behind nginx.",
  content: "Long body that agents should have to ask for.",
  importance: 0.8,
  confidence: 0.9,
  tags: ["deploy", "infra"],
  sourceType: "agent" as const,
  sourceId: "session-9",
  createdBy: null,
  createdByAgent: "agent-1",
  version: 3,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/**
 * A context package whose `contextText` already contains the selected body, plus more
 * omitted candidates than the response is allowed to list.
 */
const contextPackage = {
  task: "deploy the worker",
  tokenModel: "cl100k-heuristic",
  tokenBudget: 2000,
  usableBudget: 1900,
  tokensUsed: 640,
  truncated: false,
  candidates: 12,
  semanticAvailable: false,
  contextText: "## Deploy target\nThe worker deploys to the VPS behind nginx.",
  memories: [
    {
      id: MEM_A,
      type: "fact",
      title: "Deploy target",
      score: 0.873456,
      whyMatched: "title match, shared entity nginx",
      legs: ["lexical", "graph"],
      tokens: 42,
      truncated: false,
      entities: ["nginx"],
      graph: null,
      provenance: null,
      // Already inside contextText; must not be repeated per memory.
      content: "Long body that agents should have to ask for.",
      summary: "The worker deploys to the VPS behind nginx.",
    },
  ],
  omitted: Array.from({ length: 14 }, (_, index) => ({
    id: `omitted-${index}`,
    title: `Dropped ${index}`,
    reason: "token budget exhausted",
  })),
  graph: null,
  contradictions: [],
};

const healthReport = {
  metrics: { brainId: BRAIN_A, orphanMemories: 3, contradictionCount: 1, totalMemories: 40 },
  issues: [
    {
      type: "contradiction",
      severity: "high",
      memoryId: MEM_A,
      memoryTitle: "Deploy target",
      reason: "Recorded as contradicting another active memory.",
      conflictsWith: { id: MEM_B, title: "Deploy target (old)" },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();

  logBrainAudit.mockResolvedValue(undefined);
  publishToUser.mockResolvedValue(undefined);
  recordMemoryFeedback.mockResolvedValue(undefined);

  searchMemories.mockResolvedValue([memoryRow]);
  getMemory.mockResolvedValue(memoryRow);
  listMemories.mockResolvedValue({ memories: [memoryRow], nextCursor: null });
  getMemoryVersions.mockResolvedValue([
    {
      id: "version-1",
      versionNumber: 2,
      title: "Deploy target",
      changeReason: "corrected the host",
      changedBy: null,
      changedByAgent: "agent-1",
      createdAt: CREATED_AT,
    },
  ]);
  listBrainTags.mockResolvedValue([{ name: "deploy" }, { name: "infra" }]);
  updateMemory.mockResolvedValue(memoryRow);
  deleteMemory.mockResolvedValue(true);

  listEntities.mockResolvedValue([
    { id: "entity-1", name: "nginx", type: "technology", description: null },
  ]);
  listRelationships.mockResolvedValue([
    {
      id: "rel-1",
      sourceName: "Storage ByAFR",
      relationshipType: "uses",
      targetName: "nginx",
      confidence: 0.9,
    },
  ]);
  upsertEntity.mockResolvedValue({ id: "entity-1", name: "nginx" });
  upsertRelationship.mockResolvedValue({ id: "rel-1", relationshipType: "uses" });
  getMemoryLinks.mockResolvedValue({ relatedTo: [], referencedBy: [] });
  linkMemory.mockResolvedValue({ id: "link-1", targetType: "memory", linkType: "relates_to" });
  consolidateBrain.mockResolvedValue({
    scanned: 12,
    truncated: false,
    duplicates: [],
    conflicts: [],
    applied: null,
  });

  buildBrainContext.mockResolvedValue(contextPackage);
  recallBrainContext.mockResolvedValue({ standingInstructions: [], memories: [] });
  rememberMemory.mockResolvedValue({
    mode: "created",
    memory: memoryRow,
    possibleDuplicates: [],
  });

  findBrainMemoryPath.mockResolvedValue({
    found: true,
    distance: 1,
    path: [
      {
        source: { id: MEM_A, title: "Deploy target", type: "fact" },
        relationshipType: "supersedes",
        target: { id: MEM_B, title: "Deploy target (old)", type: "fact" },
        weight: 1,
      },
    ],
  });
  getBrainRelatedMemories.mockResolvedValue([
    {
      id: MEM_B,
      title: "Deploy target (old)",
      type: "fact",
      score: 0.62,
      reason: "shares entity nginx",
      linkType: null,
      hops: 1,
    },
  ]);
  getMemoryTimeline.mockResolvedValue({
    memoryId: MEM_A,
    memoryTitle: "Deploy target",
    events: [
      {
        timestamp: CREATED_AT,
        eventType: "created",
        version: 1,
        supersededBy: null,
        changeReason: null,
      },
    ],
  });
  getMemoryProvenance.mockResolvedValue({
    memoryId: MEM_A,
    memoryTitle: "Deploy target",
    memoryType: "fact",
    sourceType: "agent",
    sourceId: "session-9",
    createdAt: CREATED_AT,
    createdBy: "agent",
    createdByUserId: null,
    createdByAgentId: "agent-1",
    createdByAgentName: "OpenClaw",
    confidence: 0.9,
    importance: 0.8,
    confirmationCount: 2,
    lastConfirmedAt: UPDATED_AT,
    validityState: "active",
    versionCount: 3,
    lastUpdated: UPDATED_AT,
    lastUpdatedBy: "agent",
    lastChangeReason: "corrected the host",
    supersededBy: null,
    supersedes: [],
    sourceMemories: [],
  });
  getBrainHealth.mockResolvedValue(healthReport);
  syncBrainReviewQueue.mockResolvedValue(4);
  listProjects.mockResolvedValue([
    {
      id: "project-1",
      name: "Second Brain",
      status: "active",
      description: null,
      memoryCount: 12,
    },
  ]);
});

type ToolCall = {
  tool: string;
  args: Record<string, unknown>;
  service: ReturnType<typeof vi.fn>;
  /** True when the service takes the brain id as its first positional argument. */
  positional?: boolean;
};

/** Every brain-scoped tool, with the service call that proves which brain it used. */
const BRAIN_SCOPED_CALLS: ToolCall[] = [
  { tool: "brain_recall", args: { task: "deploy the worker" }, service: recallBrainContext },
  { tool: "brain_context", args: { task: "deploy the worker" }, service: buildBrainContext },
  { tool: "brain_search", args: { query: "deploy" }, service: searchMemories },
  { tool: "brain_read", args: { memoryId: MEM_A }, service: getMemory },
  { tool: "brain_get_recent", args: {}, service: listMemories },
  { tool: "brain_get_memory_history", args: { memoryId: MEM_A }, service: getMemoryVersions },
  { tool: "brain_list_projects", args: {}, service: listProjects },
  { tool: "brain_list_tags", args: {}, service: listBrainTags, positional: true },
  { tool: "brain_get_entity", args: {}, service: listEntities },
  { tool: "brain_get_related", args: {}, service: listRelationships },
  { tool: "brain_get_backlinks", args: { memoryId: MEM_A }, service: getMemoryLinks },
  {
    tool: "brain_remember",
    args: { title: "Deploy target", content: "The worker deploys to the VPS." },
    service: rememberMemory,
  },
  { tool: "brain_update", args: { memoryId: MEM_A, summary: "Shorter." }, service: updateMemory },
  { tool: "brain_delete", args: { memoryId: MEM_A }, service: deleteMemory },
  {
    tool: "brain_link",
    args: { source: "Storage ByAFR", target: "nginx", relationshipType: "uses" },
    service: upsertRelationship,
  },
  {
    tool: "brain_link_memory",
    args: { memoryId: MEM_A, targetMemoryId: MEM_B },
    service: linkMemory,
  },
  {
    tool: "brain_path",
    args: { sourceMemoryId: MEM_A, targetMemoryId: MEM_B },
    service: findBrainMemoryPath,
    positional: true,
  },
  { tool: "brain_timeline", args: { memoryId: MEM_A }, service: getMemoryTimeline, positional: true },
  {
    tool: "brain_related",
    args: { memoryId: MEM_A },
    service: getBrainRelatedMemories,
    positional: true,
  },
  { tool: "brain_explain", args: { memoryId: MEM_A }, service: getMemoryProvenance, positional: true },
  { tool: "brain_health", args: {}, service: getBrainHealth, positional: true },
  { tool: "brain_consolidate", args: {}, service: consolidateBrain },
];

function brainIdSeenBy(entry: ToolCall): unknown {
  const [first] = entry.service.mock.calls[0] as unknown[];
  return entry.positional ? first : (first as { brainId: string }).brainId;
}

describe("the brain a tool works on is the one authorization resolved", () => {
  it.each(BRAIN_SCOPED_CALLS)(
    "$tool falls back to the default grant when no brain is named",
    async (entry) => {
      const { isError } = await call(entry.tool, entry.args);

      expect(isError).toBe(false);
      expect(entry.service).toHaveBeenCalledTimes(1);
      expect(brainIdSeenBy(entry)).toBe(BRAIN_A);
    }
  );

  it.each(BRAIN_SCOPED_CALLS)(
    "$tool refuses a brain this credential was never granted, without calling its service",
    async (entry) => {
      // Not FORBIDDEN but NOT_FOUND, exactly as the REST choke point answers: a brain
      // outside the grant list is indistinguishable from one that does not exist, so
      // an agent cannot use the error to enumerate other people's brains.
      const payload = await refuse(entry.tool, { ...entry.args, brainId: UNGRANTED_BRAIN });

      expect(payload).toEqual({ error: "Brain not found", code: "BRAIN_NOT_FOUND" });
      expect(entry.service).not.toHaveBeenCalled();
    }
  );

  it("targets a second granted brain when the agent names it", async () => {
    const { isError } = await call("brain_read", { brainId: BRAIN_B, memoryId: MEM_A });

    expect(isError).toBe(false);
    expect(getMemory).toHaveBeenCalledWith({ brainId: BRAIN_B, memoryId: MEM_A });
  });

  it("holds the second brain to its own narrower grant", async () => {
    // Work Brain is read-only. The same call that succeeds on the default brain must
    // fail here — the scope is per grant, not per credential.
    const payload = await refuse("brain_update", {
      brainId: BRAIN_B,
      memoryId: MEM_A,
      summary: "Shorter.",
    });

    expect(payload.code).toBe("BRAIN_FORBIDDEN");
    expect(payload.error).toBe("Missing scope: brain.write");
    expect(updateMemory).not.toHaveBeenCalled();
  });
});

/** A call the schema must reject; returns whatever the client was told. */
async function invalidArguments(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const server = createBrainMcpServer(principal);
  const client = new Client({ name: "tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} accepted ${JSON.stringify(args)}`).toBe(true);
    return (result.content as { text: string }[])[0].text;
  } catch (error) {
    // Depending on the SDK version an invalid argument is a JSON-RPC error rather
    // than a tool result; either way it must not reach the service.
    return (error as Error).message;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("limits belong to the server, not to the caller", () => {
  it("gives brain_search, brain_get_recent and the history tool their documented defaults", async () => {
    await call("brain_search", { query: "deploy" });
    await call("brain_get_recent", {});
    await call("brain_get_memory_history", { memoryId: MEM_A });

    expect(searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    expect(listMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    expect(getMemoryVersions).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("gives the graph tools theirs", async () => {
    await call("brain_get_entity", {});
    await call("brain_get_related", {});
    await call("brain_path", { sourceMemoryId: MEM_A, targetMemoryId: MEM_B });
    await call("brain_related", { memoryId: MEM_A });

    expect(listEntities).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(listRelationships).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(findBrainMemoryPath).toHaveBeenCalledWith(BRAIN_A, MEM_A, MEM_B, 5);
    expect(getBrainRelatedMemories).toHaveBeenCalledWith(BRAIN_A, MEM_A, 20, 2);
  });

  it("gives brain_health its thresholds so a scan cannot be silently widened", async () => {
    await call("brain_health", {});
    expect(getBrainHealth).toHaveBeenCalledWith(BRAIN_A, 180, 0.5, 50);

    await call("brain_health", { staleDays: 30, lowConfidenceThreshold: 0.2, maxIssues: 200 });
    expect(getBrainHealth).toHaveBeenLastCalledWith(BRAIN_A, 30, 0.2, 200);
  });

  it.each([
    { tool: "brain_path", args: { sourceMemoryId: MEM_A, targetMemoryId: MEM_B, maxDepth: 9 } },
    { tool: "brain_related", args: { memoryId: MEM_A, maxResults: 500 } },
    { tool: "brain_related", args: { memoryId: MEM_A, maxHops: 40 } },
    { tool: "brain_search", args: { query: "deploy", limit: 500 } },
    { tool: "brain_health", args: { maxIssues: 5000 } },
    { tool: "brain_context", args: { task: "deploy", tokenBudget: 10 } },
    { tool: "brain_context", args: { task: "deploy", tokenBudget: 10_000_000 } },
  ])("rejects $tool with an out-of-range argument before any service runs", async (entry) => {
    await invalidArguments(entry.tool, entry.args);

    expect(findBrainMemoryPath).not.toHaveBeenCalled();
    expect(getBrainRelatedMemories).not.toHaveBeenCalled();
    expect(searchMemories).not.toHaveBeenCalled();
    expect(getBrainHealth).not.toHaveBeenCalled();
    expect(buildBrainContext).not.toHaveBeenCalled();
  });

  it("refuses a brainId that is not a uuid instead of passing the string down", async () => {
    // The grant lookup is an equality test, so a non-uuid would merely miss — but it
    // has no business reaching the service layer or a uuid column at all.
    await invalidArguments("brain_read", { brainId: "not-a-uuid", memoryId: MEM_A });
    expect(getMemory).not.toHaveBeenCalled();
  });
});

describe("what leaves the brain is compact by construction", () => {
  it("returns summaries from a search, never bodies", async () => {
    const { payload } = await call("brain_search", { query: "deploy" });
    const [result] = payload.results as Array<Record<string, unknown>>;

    expect(result).toEqual({
      id: MEM_A,
      type: "fact",
      title: "Deploy target",
      snippet: "The worker deploys to the VPS behind nginx.",
      importance: 0.8,
      confidence: 0.9,
      tags: ["deploy", "infra"],
      updatedAt: UPDATED_AT.toISOString(),
    });
    expect(result).not.toHaveProperty("content");
  });

  it("falls back to the content for a memory with no summary, bounded and single-spaced", async () => {
    searchMemories.mockResolvedValue([
      {
        ...memoryRow,
        summary: null,
        content: `Line one.\n\n   Line two.   ${"padding ".repeat(80)}`,
      },
    ]);

    const { payload } = await call("brain_search", { query: "deploy" });
    const [result] = payload.results as Array<{ snippet: string }>;

    expect(result.snippet).toHaveLength(300);
    expect(result.snippet.endsWith("…")).toBe(true);
    expect(result.snippet.startsWith("Line one. Line two. padding")).toBe(true);
    expect(result.snippet).not.toMatch(/\s\s|\n/);
  });

  it("keeps brain_read as the only way to get a full body", async () => {
    const { payload } = await call("brain_read", { memoryId: MEM_A });

    expect(payload.content).toBe(memoryRow.content);
    expect(payload.summary).toBe(memoryRow.summary);
    expect(payload.provenance).toEqual({
      sourceType: "agent",
      sourceId: "session-9",
      createdByUser: null,
      createdByAgent: "agent-1",
    });
  });

  it("does not repeat the bodies that contextText already holds", async () => {
    // The one thing brain_context exists to bound is size. Returning each body twice —
    // once in contextText, once per memory — would double the cost of the budget.
    const { payload } = await call("brain_context", { task: "deploy the worker" });
    const [entry] = payload.memories as Array<Record<string, unknown>>;

    expect(payload.contextText).toBe(contextPackage.contextText);
    expect(entry).not.toHaveProperty("content");
    expect(entry).not.toHaveProperty("summary");
    expect(entry.position).toBe(1);
    expect(entry.whyMatched).toBe("title match, shared entity nginx");
    expect(entry.matchedBy).toEqual(["lexical", "graph"]);
  });

  it("rounds relevance instead of leaking full float precision", async () => {
    const { payload } = await call("brain_context", { task: "deploy the worker" });
    const [entry] = payload.memories as Array<{ relevance: number }>;

    expect(entry.relevance).toBe(0.873);
  });

  it("caps the omitted list but still says how many were dropped", async () => {
    // A knowledge gap the agent can act on needs a few examples and a total, not 14
    // rows of everything that lost.
    const { payload } = await call("brain_context", { task: "deploy the worker" });

    expect(payload.omitted).toHaveLength(10);
    expect(payload.omittedTotal).toBe(14);
    expect((payload.omitted as Array<{ id: string }>)[0].id).toBe("omitted-0");
  });

  it("reports the tokenizer and both budgets, so a caller can check the arithmetic", async () => {
    const { payload } = await call("brain_context", { task: "deploy the worker" });

    expect(payload.tokenModel).toBe("cl100k-heuristic");
    expect(payload.tokenBudget).toBe(2000);
    expect(payload.usableBudget).toBe(1900);
    expect(payload.tokensUsed).toBe(640);
    expect(payload.truncated).toBe(false);
  });

  it("lists every granted brain with its scopes, and nothing about the credential", async () => {
    const { payload } = await call("brain_list_brains");

    expect(payload.brains).toEqual([
      {
        brainId: BRAIN_A,
        name: "Personal Brain",
        isDefault: true,
        scopes: [
          "brain.read",
          "brain.search",
          "brain.write",
          "brain.link",
          "brain.delete",
          "brain.consolidate",
        ],
      },
      { brainId: BRAIN_B, name: "Work Brain", isDefault: false, scopes: ["brain.read"] },
    ]);
    expect(payload.principal).toEqual({ type: "agent", agentName: "OpenClaw" });
    // The key id and the owner's user id are not the agent's business.
    expect(JSON.stringify(payload)).not.toContain("key-1");
    expect(JSON.stringify(payload)).not.toContain("user-1");
  });
});

/**
 * Every audited call must be attributable to a principal and to this transport —
 * an audit row saying "someone read this brain" is not an audit row.
 */
const AUDITED_CALLS: Array<{ tool: string; args: Record<string, unknown>; operation: string }> = [
  { tool: "brain_recall", args: {}, operation: "memory.recall" },
  { tool: "brain_context", args: { task: "deploy the worker" }, operation: "memory.context" },
  { tool: "brain_search", args: { query: "deploy" }, operation: "memory.search" },
  { tool: "brain_read", args: { memoryId: MEM_A }, operation: "memory.read" },
  { tool: "brain_remember", args: { title: "Deploy target", content: "Body" }, operation: "memory.create" },
  { tool: "brain_update", args: { memoryId: MEM_A, importance: 0.9 }, operation: "memory.update" },
  { tool: "brain_delete", args: { memoryId: MEM_A }, operation: "memory.delete" },
  { tool: "brain_path", args: { sourceMemoryId: MEM_A, targetMemoryId: MEM_B }, operation: "graph.path" },
  { tool: "brain_related", args: { memoryId: MEM_A }, operation: "memory.related" },
  { tool: "brain_timeline", args: { memoryId: MEM_A }, operation: "memory.timeline" },
  { tool: "brain_explain", args: { memoryId: MEM_A }, operation: "memory.provenance" },
  { tool: "brain_health", args: {}, operation: "brain.health" },
  { tool: "brain_consolidate", args: {}, operation: "brain.consolidate_preview" },
];

describe("the audit trail", () => {
  it.each(AUDITED_CALLS)(
    "$tool writes one $operation row naming the agent and the transport",
    async ({ tool, args, operation }) => {
      const { isError } = await call(tool, args);
      expect(isError).toBe(false);

      expect(logBrainAudit).toHaveBeenCalledTimes(1);
      const [entry] = logBrainAudit.mock.calls[0] as [
        {
          brainId: string;
          principalType: string;
          principalId: string;
          operation: string;
          metadata: Record<string, unknown>;
        },
      ];
      expect(entry.brainId).toBe(BRAIN_A);
      expect(entry.principalType).toBe("agent");
      expect(entry.principalId).toBe("agent-1");
      expect(entry.operation).toBe(operation);
      expect(entry.metadata).toMatchObject({ transport: "mcp", agent: "OpenClaw" });
    }
  );

  it("records what a context package cost, never what the task said", async () => {
    // The task is the agent's own sentence, but it is written *about* the brain and
    // lands in a table an owner reads later; counts answer "was this reasonable?"
    // without putting the wording in a second place.
    await call("brain_context", {
      task: "rotate the SESSION_SECRET before Friday",
      projectId: PROJECT,
    });

    const [entry] = logBrainAudit.mock.calls[0] as [{ metadata: Record<string, unknown> }];
    expect(entry.metadata).toEqual({
      projectId: PROJECT,
      taskChars: "rotate the SESSION_SECRET before Friday".length,
      tokenBudget: 2000,
      tokensUsed: 640,
      selected: 1,
      omitted: 14,
      truncated: false,
      transport: "mcp",
      agent: "OpenClaw",
    });
    expect(JSON.stringify(entry.metadata)).not.toContain("SESSION_SECRET");
  });

  it("audits a path search that found nothing, because asking is the event", async () => {
    findBrainMemoryPath.mockResolvedValue({ found: false, distance: null, path: [] });

    const { payload } = await call("brain_path", {
      sourceMemoryId: MEM_A,
      targetMemoryId: MEM_B,
    });

    expect(payload.found).toBe(false);
    const [entry] = logBrainAudit.mock.calls[0] as [{ metadata: Record<string, unknown> }];
    expect(entry.metadata).toMatchObject({ via: "brain_path", found: false, hops: 0 });
  });

  it("writes nothing when the memory a lookup asked about does not exist", async () => {
    // `{found:false}` is an answer, not a disclosure: nothing about the brain was read,
    // so there is nothing to record — and an absent memory must not become a way to
    // fill an owner's audit table.
    getMemoryTimeline.mockResolvedValue(null);
    getMemoryProvenance.mockResolvedValue(null);

    const timeline = await call("brain_timeline", { memoryId: MEM_B });
    const explain = await call("brain_explain", { memoryId: MEM_B });

    expect(timeline.isError).toBe(false);
    expect(timeline.payload.found).toBe(false);
    expect(explain.payload.found).toBe(false);
    expect(logBrainAudit).not.toHaveBeenCalled();
  });

  it("names the brain authorization resolved, not the one the caller asked for", async () => {
    await call("brain_timeline", { brainId: BRAIN_B, memoryId: MEM_A });

    const [entry] = logBrainAudit.mock.calls[0] as [{ brainId: string }];
    expect(entry.brainId).toBe(BRAIN_B);
  });

  it("attributes a plain user credential to the user, with no agent name", async () => {
    await call(
      "brain_search",
      { query: "deploy" },
      { type: "user", id: "user-1", agentId: null, agentName: null }
    );

    const [entry] = logBrainAudit.mock.calls[0] as [
      { principalType: string; principalId: string; metadata: Record<string, unknown> },
    ];
    expect(entry.principalType).toBe("user");
    expect(entry.principalId).toBe("user-1");
    expect(entry.metadata.agent).toBeNull();
  });
});

describe("a read-only tool stays read-only until asked", () => {
  it("reports health without touching the review queue", async () => {
    const { payload } = await call("brain_health", {});

    expect(getBrainHealth).toHaveBeenCalledTimes(1);
    expect(syncBrainReviewQueue).not.toHaveBeenCalled();
    expect(payload.queuedForReview).toBeNull();
  });

  it("persists findings only when queueForReview is explicitly true", async () => {
    const { payload } = await call("brain_health", { queueForReview: true });

    expect(syncBrainReviewQueue).toHaveBeenCalledWith(BRAIN_A, healthReport);
    expect(payload.queuedForReview).toBe(4);
    const [entry] = logBrainAudit.mock.calls[0] as [{ metadata: Record<string, unknown> }];
    expect(entry.metadata.queuedForReview).toBe(4);
  });

  it("refuses to queue on a brain granted read-only, before it even reads it", async () => {
    // The scope the tool asks for changes with the argument, so the refusal has to
    // happen at the door — not after a report has already been computed.
    const payload = await refuse("brain_health", { brainId: BRAIN_B, queueForReview: true });

    expect(payload).toEqual({ error: "Missing scope: brain.consolidate", code: "BRAIN_FORBIDDEN" });
    expect(getBrainHealth).not.toHaveBeenCalled();
    expect(syncBrainReviewQueue).not.toHaveBeenCalled();
  });

  it("previews a consolidation without applying it", async () => {
    await call("brain_consolidate", {});

    expect(consolidateBrain).toHaveBeenCalledWith({
      brainId: BRAIN_A,
      principal: { userId: "user-1", agentId: "agent-1" },
      apply: false,
      limit: undefined,
    });
    const [entry] = logBrainAudit.mock.calls[0] as [{ operation: string }];
    expect(entry.operation).toBe("brain.consolidate_preview");
  });

  it("records an applied consolidation under a different operation", async () => {
    await call("brain_consolidate", { apply: true });

    expect(consolidateBrain).toHaveBeenCalledWith(
      expect.objectContaining({ brainId: BRAIN_A, apply: true })
    );
    const [entry] = logBrainAudit.mock.calls[0] as [{ operation: string }];
    expect(entry.operation).toBe("brain.consolidated");
  });
});

describe("brain_link_memory takes exactly one target", () => {
  it("refuses both a memory and an entity, and creates neither", async () => {
    // Accepting both would silently pick one and drop the other edge — a link the
    // caller believes exists and the graph does not have.
    const payload = await refuse("brain_link_memory", {
      memoryId: MEM_A,
      targetMemoryId: MEM_B,
      entity: "nginx",
    });

    expect(payload).toEqual({
      error: "Provide exactly one of targetMemoryId or entity",
      code: "BRAIN_VALIDATION",
    });
    expect(upsertEntity).not.toHaveBeenCalled();
    expect(linkMemory).not.toHaveBeenCalled();
  });

  it("refuses neither, instead of writing a dangling edge", async () => {
    const payload = await refuse("brain_link_memory", { memoryId: MEM_A });

    expect(payload.code).toBe("BRAIN_VALIDATION");
    expect(linkMemory).not.toHaveBeenCalled();
  });

  it("links to a memory without inventing an entity", async () => {
    await call("brain_link_memory", { memoryId: MEM_A, targetMemoryId: MEM_B });

    expect(upsertEntity).not.toHaveBeenCalled();
    expect(linkMemory).toHaveBeenCalledWith({
      brainId: BRAIN_A,
      sourceMemoryId: MEM_A,
      target: { targetType: "memory", targetMemoryId: MEM_B },
      linkType: undefined,
      principal: { userId: "user-1", agentId: "agent-1" },
    });
  });

  it("resolves an entity by name in the resolved brain, then links to its id", async () => {
    await call("brain_link_memory", { memoryId: MEM_A, entity: "nginx", entityType: "technology" });

    expect(upsertEntity).toHaveBeenCalledWith({
      brainId: BRAIN_A,
      name: "nginx",
      type: "technology",
    });
    expect(linkMemory).toHaveBeenCalledWith(
      expect.objectContaining({ target: { targetType: "entity", targetEntityId: "entity-1" } })
    );
  });
});

describe("what an agent is told when something goes wrong", () => {
  it("passes a BrainError's own message and code through", async () => {
    updateMemory.mockRejectedValue(new BrainError("Memory not found", 404, "MEMORY_NOT_FOUND"));

    const payload = await refuse("brain_update", { memoryId: MEM_A, importance: 0.5 });

    expect(payload).toEqual({ error: "Memory not found", code: "MEMORY_NOT_FOUND" });
  });

  it("reduces an unexpected failure to a fixed pair, keeping the detail in the server log", async () => {
    // A driver error carries connection strings and query fragments. The agent gets
    // enough to retry or give up, and nothing about the deployment.
    searchMemories.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://brain:hunter2@db:5432/app")
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const payload = await refuse("brain_search", { query: "deploy" });

    expect(payload).toEqual({ error: "Internal error", code: "INTERNAL" });
    expect(JSON.stringify(payload)).not.toContain("hunter2");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("turns a missing memory into MEMORY_NOT_FOUND without recording a read", async () => {
    getMemory.mockResolvedValue(null);

    const payload = await refuse("brain_read", { memoryId: MEM_B });

    expect(payload).toEqual({ error: "Memory not found", code: "MEMORY_NOT_FOUND" });
    // Nothing was disclosed and nothing was opened, so neither trail moves.
    expect(logBrainAudit).not.toHaveBeenCalled();
    expect(recordMemoryFeedback).not.toHaveBeenCalled();
  });

  it("treats a delete that matched nothing as not-found, not as success", async () => {
    deleteMemory.mockResolvedValue(false);

    const payload = await refuse("brain_delete", { memoryId: MEM_B });

    expect(payload).toEqual({ error: "Memory not found", code: "MEMORY_NOT_FOUND" });
    expect(logBrainAudit).not.toHaveBeenCalled();
    expect(publishToUser).not.toHaveBeenCalled();
  });

  it("does not turn a failed audit write into a failed tool call", async () => {
    // The row is written after the work it describes. Reporting an audit problem as a
    // tool error would make an agent retry a write that already landed — so the audit
    // sink is allowed to fail loudly in the log and quietly to the caller.
    logBrainAudit.mockRejectedValue(new Error("audit table is gone"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { isError, payload } = await call("brain_search", { query: "deploy" });

    expect(isError).toBe(false);
    expect(payload.count).toBe(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("side effects belong to the owner of the resolved brain", () => {
  it("publishes a create event to the brain owner, not to the agent", async () => {
    await call("brain_remember", { title: "Deploy target", content: "Body" });

    expect(publishToUser).toHaveBeenCalledWith("user-1", {
      type: "brain_memory_created",
      brainId: BRAIN_A,
      memoryId: MEM_A,
      title: "Deploy target",
    });
  });

  it("publishes an update event when remember matched an existing memory", async () => {
    rememberMemory.mockResolvedValue({
      mode: "updated",
      memory: memoryRow,
      possibleDuplicates: [],
    });

    await call("brain_remember", { title: "Deploy target", content: "Body" });

    expect(publishToUser).toHaveBeenCalledWith("user-1", {
      type: "brain_memory_updated",
      brainId: BRAIN_A,
      memoryId: MEM_A,
    });
  });

  it("records an opened-memory signal for the read, bounded and attributed", async () => {
    // P10: reads feed ranking. The signal names the brain authorization resolved and
    // the principal that opened it, so one agent cannot inflate another's brain.
    await call("brain_read", { memoryId: MEM_A });

    expect(recordMemoryFeedback).toHaveBeenCalledWith(
      BRAIN_A,
      MEM_A,
      "opened",
      "user-1",
      "agent-1",
      { tool: "brain_read" }
    );
  });

  it("records that signal against the brain named, when a second brain is targeted", async () => {
    await call("brain_read", { brainId: BRAIN_B, memoryId: MEM_A });

    expect(recordMemoryFeedback).toHaveBeenCalledWith(
      BRAIN_B,
      MEM_A,
      "opened",
      "user-1",
      "agent-1",
      { tool: "brain_read" }
    );
  });

  it("emits no event and no feedback for a read-only tool", async () => {
    await call("brain_search", { query: "deploy" });
    await call("brain_list_tags", {});
    await call("brain_related", { memoryId: MEM_A });

    expect(publishToUser).not.toHaveBeenCalled();
    expect(recordMemoryFeedback).not.toHaveBeenCalled();
  });
});
