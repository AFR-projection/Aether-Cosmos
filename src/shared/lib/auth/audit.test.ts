import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: vi.fn(async () => undefined),
  publishToAdmins: vi.fn(async () => undefined),
  getOrCreateActivityScope: vi.fn(async () => ({ id: "scope-1" })),
}));

vi.mock("@/shared/infrastructure/db", () => ({
  db: { insert: () => ({ values: mocks.values }) },
}));

vi.mock("@/shared/infrastructure/db/schema", () => ({
  activityLogs: {},
}));

vi.mock("@/shared/lib/activity/activity-scope-server", () => ({
  getOrCreateActivityScope: mocks.getOrCreateActivityScope,
}));

vi.mock("@/shared/infrastructure/realtime/events", () => ({
  publishToAdmins: mocks.publishToAdmins,
}));

const { logActivity } = await import("./audit");

describe("logActivity admin realtime signal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes only after the audit row is stored", async () => {
    const order: string[] = [];
    mocks.values.mockImplementationOnce(async () => {
      order.push("insert");
    });
    mocks.publishToAdmins.mockImplementationOnce(async () => {
      order.push("publish");
    });

    await logActivity(
      { id: "user-1", username: "operator" } as Parameters<typeof logActivity>[0],
      "upload",
      { resourceType: "file", resourceId: "file-1", ip: "127.0.0.1" }
    );
    await Promise.resolve();

    expect(order).toEqual(["insert", "publish"]);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        activityScopeId: "scope-1",
        action: "upload",
        resourceType: "file",
        resourceId: "file-1",
        ip: "127.0.0.1",
      })
    );
    expect(mocks.publishToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "activity_log_created",
        userId: "user-1",
        action: "upload",
        at: expect.any(Number),
      })
    );
  });

  it("uses the effective user while impersonating", async () => {
    await logActivity(
      { id: "master-1", effectiveUserId: "user-2" } as Parameters<typeof logActivity>[0],
      "download"
    );
    await Promise.resolve();

    expect(mocks.getOrCreateActivityScope).toHaveBeenCalledWith("user-2");
    expect(mocks.publishToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-2", action: "download" })
    );
  });
});
