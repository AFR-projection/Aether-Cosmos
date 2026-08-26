import { beforeEach, describe, expect, it } from "vitest";
import {
  configureActivityScope,
  getActivities,
  hydrateActivities,
  recordActivity,
  syncTransferActivity,
} from "@/lib/activity/activity-store";

const scopeA = "8f4c2a91-7d31-4e6a-b8f2-91c7d43e5a21";
const scopeB = "2c1d7b44-1e28-4a6f-9b13-5e2d8c7f4a90";

beforeEach(() => configureActivityScope(null));

describe("account-scoped activity store", () => {
  it("does not carry in-memory activity into another scope", () => {
    configureActivityScope(scopeA);
    recordActivity("upload", "account-a.mp4", "done");

    configureActivityScope(scopeB);

    expect(getActivities()).toEqual([]);
  });

  it("rejects hydration for a different scope", () => {
    configureActivityScope(scopeB);
    hydrateActivities([
      {
        id: "server-a",
        scopeId: scopeA,
        type: "upload",
        status: "completed",
        name: "account-a.jpg",
        startedAt: Date.now(),
      },
    ], scopeA);

    expect(getActivities()).toEqual([]);
  });
});

describe("live transfer updates", () => {
  const tick = (loaded: number, phase: "uploading" | "completed" = "uploading") =>
    syncTransferActivity({ id: "job-1", type: "upload", name: "clip.mp4", phase, loaded, total: 1000 });

  it("updates a transfer where it sits instead of lifting it to the top", () => {
    configureActivityScope(scopeA);
    tick(100);
    recordActivity("delete", "old.txt", "done");

    expect(getActivities()[1]?.name).toBe("clip.mp4");

    tick(600);

    const rows = getActivities();
    expect(rows[0]?.name).toBe("old.txt");
    expect(rows[1]?.name).toBe("clip.mp4");
    expect(rows[1]?.progress).toBe(60);
    expect(rows).toHaveLength(2);
  });

  it("keeps one row per transfer and closes it out on completion", () => {
    configureActivityScope(scopeA);
    tick(200);
    tick(1000, "completed");

    const rows = getActivities();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.progress).toBe(100);
    expect(rows[0]?.endedAt).toBeTypeOf("number");
  });

  it("hands out a new snapshot only when something changed", () => {
    configureActivityScope(scopeA);
    tick(100);
    const first = getActivities();
    expect(getActivities()).toBe(first);

    tick(200);
    expect(getActivities()).not.toBe(first);
  });
});
