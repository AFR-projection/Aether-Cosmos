import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireBrainContext = vi.fn();
const enforceBrainRateLimit = vi.fn();
const logBrainAudit = vi.fn();
const buildSessionStart = vi.fn();
const buildSessionTurn = vi.fn();
const runBrainIngest = vi.fn();

vi.mock("@brain/infrastructure/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/infrastructure/access")>()),
  requireBrainContext: (...args: unknown[]) => requireBrainContext(...args),
}));
vi.mock("@brain/infrastructure/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/infrastructure/http")>()),
  enforceBrainRateLimit: (...args: unknown[]) => enforceBrainRateLimit(...args),
}));
vi.mock("@brain/infrastructure/audit", () => ({
  logBrainAudit: (...args: unknown[]) => logBrainAudit(...args),
}));
vi.mock("@brain/application/queries/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/application/queries/session")>()),
  buildSessionStart: (...args: unknown[]) => buildSessionStart(...args),
  buildSessionTurn: (...args: unknown[]) => buildSessionTurn(...args),
}));
vi.mock("@brain/infrastructure/ingest-runner", () => ({
  runBrainIngest: (...args: unknown[]) => runBrainIngest(...args),
}));

const { POST: startSession } = await import("@/app/api/brain/[id]/session/start/route");
const { POST: turnSession } = await import("@/app/api/brain/[id]/session/turn/route");
const { POST: endSession } = await import("@/app/api/brain/[id]/session/end/route");
const { POST: ingest } = await import("@/app/api/brain/[id]/ingest/route");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const context = {
  userId: "user-1",
  brain: { id: BRAIN, name: "Personal" },
  principal: { type: "agent", id: "agent-1", agentId: "agent-1", agentName: "Claude" },
};
const routeContext = { params: Promise.resolve({ id: BRAIN }) };

type Post = typeof startSession;

function request(path: string, body: unknown, options: { bearer?: boolean; accept?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.bearer !== false) headers.set("authorization", "Bearer sk_test-agent-key");
  if (options.accept) headers.set("accept", options.accept);
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireBrainContext.mockReset().mockResolvedValue(context);
  enforceBrainRateLimit.mockReset().mockResolvedValue(undefined);
  logBrainAudit.mockReset().mockResolvedValue(undefined);
  buildSessionStart.mockReset().mockResolvedValue({
    sessionId: "session-1",
    brainId: BRAIN,
    brainName: "Personal",
    projectId: null,
    topic: null,
    memoryIds: ["22222222-2222-4222-8222-222222222222"],
    directiveCount: 1,
    text: "loaded context",
    recall: { contextText: "loaded context" },
  });
  buildSessionTurn.mockReset().mockResolvedValue({
    sessionId: "session-1",
    memoryIds: [],
    memories: [],
    text: "",
  });
  runBrainIngest.mockReset().mockResolvedValue({
    sessionId: "session-1",
    committed: false,
    considered: 1,
    created: 0,
    merged: 0,
    skipped: 1,
    reviewNeeded: 0,
    thresholds: { minSalience: 0.45, minImportance: 0.45, sampleRate: 1, maxWrites: 5 },
    results: [],
  });
});

describe("Brain lifecycle REST routes", () => {
  it.each([
    [startSession, "/api/brain/x/session/start", {}],
    [turnSession, "/api/brain/x/session/turn", { prompt: "deploy" }],
    [endSession, "/api/brain/x/session/end", { turns: [{ role: "user", text: "Remember this" }] }],
    [ingest, "/api/brain/x/ingest", { candidates: [{ content: "Remember this" }] }],
  ] as const)("rejects cookie-style POSTs without CSRF before authorization", async (post, path, body) => {
    const response = await (post as Post)(request(path, body, { bearer: false }), routeContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Invalid CSRF token" });
    expect(requireBrainContext).not.toHaveBeenCalled();
  });

  it.each([
    [startSession, "/api/brain/x/session/start", {}],
    [turnSession, "/api/brain/x/session/turn", { prompt: "deploy" }],
    [endSession, "/api/brain/x/session/end", { turns: [{ role: "user", text: "Remember this" }] }],
    [ingest, "/api/brain/x/ingest", { candidates: [{ content: "Remember this" }] }],
  ] as const)("allows programmatic Bearer clients through CSRF", async (post, path, body) => {
    const response = await (post as Post)(request(path, body), routeContext);

    expect(response.status).toBe(200);
    expect(requireBrainContext).toHaveBeenCalledOnce();
  });

  it("returns no-store text for hook output, including an empty turn", async () => {
    const start = await startSession(
      request(`/api/brain/${BRAIN}/session/start?format=text`, {}),
      routeContext
    );
    const turn = await turnSession(
      request(`/api/brain/${BRAIN}/session/turn?format=text`, { prompt: "?" }),
      routeContext
    );

    expect(await start.text()).toBe("loaded context");
    expect(start.headers.get("content-type")).toContain("text/plain");
    expect(start.headers.get("cache-control")).toBe("no-store");
    expect(await turn.text()).toBe("");
  });

  it("uses the standard JSON envelope by default", async () => {
    const response = await startSession(
      request(`/api/brain/${BRAIN}/session/start`, { sessionId: "session-1" }),
      routeContext
    );

    expect(await response.json()).toMatchObject({
      data: { sessionId: "session-1", text: "loaded context", memoryIds: [expect.any(String)] },
    });
  });
});
