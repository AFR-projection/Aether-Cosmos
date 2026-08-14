import { beforeEach, describe, expect, it } from "vitest";
import {
  configureActivityScope,
  getActivities,
  hydrateActivities,
  recordActivity,
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
