import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireBrainOwnerContext: vi.fn(),
  enforceBrainRateLimit: vi.fn(),
  createBrainAgent: vi.fn(),
  logBrainAudit: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("@brain/infrastructure/access", () => ({
  requireBrainOwnerContext: (...args: unknown[]) => mocks.requireBrainOwnerContext(...args),
}));
vi.mock("@brain/infrastructure/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/infrastructure/http")>()),
  enforceBrainRateLimit: (...args: unknown[]) => mocks.enforceBrainRateLimit(...args),
}));
vi.mock("@brain/application/commands/agent-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brain/application/commands/agent-service")>()),
  createBrainAgent: (...args: unknown[]) => mocks.createBrainAgent(...args),
}));
vi.mock("@brain/infrastructure/audit", () => ({
  logBrainAudit: (...args: unknown[]) => mocks.logBrainAudit(...args),
}));
vi.mock("@/shared/lib/auth/audit", () => ({
  logActivity: (...args: unknown[]) => mocks.logActivity(...args),
}));

const { POST } = await import("@/app/api/brain/[id]/agents/route");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const RAW_KEY = "sk_1234567890abcdefghijklmnopqrstuvwxyz";
const routeContext = { params: Promise.resolve({ id: BRAIN }) };

function createRequest(scopes: string[]) {
  return new NextRequest(`https://mindvault.example/api/brain/${BRAIN}/agents`, {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test-owner-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Hermes", scopes }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireBrainOwnerContext.mockResolvedValue({
    userId: "user-1",
    sessionUser: { id: "user-1" },
    principal: { type: "user", id: "user-1" },
    brain: { id: BRAIN, name: "Personal Brain" },
  });
  mocks.enforceBrainRateLimit.mockResolvedValue(undefined);
  mocks.createBrainAgent.mockImplementation(async ({ scopes }) => ({
    agent: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Hermes",
      description: null,
      type: "external",
      status: "active",
      scopes,
      createdAt: new Date("2026-09-08T00:00:00.000Z"),
    },
    rawKey: RAW_KEY,
  }));
});

describe("Brain agent creation onboarding", () => {
  it("returns a safe permission-aware install bundle beside the one-time key", async () => {
    const response = await POST(
      createRequest(["brain.read", "brain.search", "brain.write"]),
      routeContext
    );
    const body = await response.json();
    const serializedInstall = JSON.stringify(body.data.install);

    expect(response.status).toBe(201);
    expect(body.data.rawKey).toBe(RAW_KEY);
    expect(body.data.install.capabilities.ingest).toBe(false);
    expect(body.data.install.systemInstruction).toContain(
      "do not call brain_session_end or brain_ingest"
    );
    expect(body.data.install.targets).toHaveLength(7);
    expect(serializedInstall).toContain("sk_YOUR_AGENT_KEY");
    expect(serializedInstall).not.toContain(RAW_KEY);
  });

  it("reflects an explicit brain.ingest grant in the install instruction", async () => {
    const response = await POST(
      createRequest(["brain.read", "brain.search", "brain.ingest"]),
      routeContext
    );
    const body = await response.json();

    expect(body.data.install.capabilities.ingest).toBe(true);
    expect(body.data.install.systemInstruction).toContain("Call brain_session_end");
  });
});
