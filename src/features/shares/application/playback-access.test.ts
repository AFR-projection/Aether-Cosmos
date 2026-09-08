import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: {
    id: "owner-1",
    bandwidthQuotaBytes: 100,
    bandwidthUsedBytes: 0,
    bandwidthPeriodStart: new Date("2026-09-08T00:00:00.000Z"),
  } as Record<string, unknown> | null,
  share: {
    id: "share-1",
    accessCount: 0,
    maxAccessCount: 1,
    lastAccessedAt: null,
  } as Record<string, unknown> | null,
  failShareWrite: false,
  queue: Promise.resolve() as Promise<unknown>,
}));

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    transaction<T>(body: (transaction: typeof tx) => Promise<T>): Promise<T> {
      const run = async () => {
        const beforeUser = state.user ? { ...state.user } : null;
        const beforeShare = state.share ? { ...state.share } : null;
        try {
          return await body(tx);
        } catch (error) {
          state.user = beforeUser;
          state.share = beforeShare;
          throw error;
        }
      };
      const result = state.queue.then(run, run);
      state.queue = result.catch(() => undefined);
      return result;
    },
  },
}));

const tx = {
  select() {
    let table = "unknown";
    const chain = {
      from(value: Record<string, unknown>) {
        table = "bandwidthQuotaBytes" in value ? "users" : "shares";
        return chain;
      },
      where: () => chain,
      limit: () => chain,
      async for(mode: string) {
        expect(mode).toBe("update");
        const row = table === "users" ? state.user : state.share;
        return row ? [{ ...row }] : [];
      },
    };
    return chain;
  },
  update(value: Record<string, unknown>) {
    const table = "bandwidthQuotaBytes" in value ? "users" : "shares";
    let updates: Record<string, unknown> = {};
    const chain = {
      set(next: Record<string, unknown>) {
        updates = next;
        return chain;
      },
      async where() {
        if (table === "shares" && state.failShareWrite) {
          throw new Error("share write failed");
        }
        const row = table === "users" ? state.user : state.share;
        if (row) Object.assign(row, updates);
      },
    };
    return chain;
  },
};

const { SharePlaybackReservationError, reserveSharePlaybackAccess } =
  await import("./access");
const { BandwidthQuotaError } = await import("@/shared/lib/billing/bandwidth");

beforeEach(() => {
  state.user = {
    id: "owner-1",
    bandwidthQuotaBytes: 100,
    bandwidthUsedBytes: 0,
    bandwidthPeriodStart: new Date(),
  };
  state.share = {
    id: "share-1",
    accessCount: 0,
    maxAccessCount: 1,
    lastAccessedAt: null,
  };
  state.failShareWrite = false;
  state.queue = Promise.resolve();
});

describe("reserveSharePlaybackAccess", () => {
  it("commits owner bandwidth and share access together", async () => {
    const result = await reserveSharePlaybackAccess("share-1", "owner-1", 60);

    expect(result).toBe("reserved");
    expect(state.user?.bandwidthUsedBytes).toBe(60);
    expect(state.share?.accessCount).toBe(1);
    expect(state.share?.lastAccessedAt).toBeInstanceOf(Date);
  });

  it("rolls back bandwidth when writing the share claim fails", async () => {
    state.failShareWrite = true;

    await expect(
      reserveSharePlaybackAccess("share-1", "owner-1", 60),
    ).rejects.toThrow("share write failed");

    expect(state.user?.bandwidthUsedBytes).toBe(0);
    expect(state.share?.accessCount).toBe(0);
  });

  it("refuses an exhausted share without spending owner bandwidth", async () => {
    state.share!.accessCount = 1;

    const result = await reserveSharePlaybackAccess("share-1", "owner-1", 60);

    expect(result).toBe("share-exhausted");
    expect(state.user?.bandwidthUsedBytes).toBe(0);
  });

  it("refuses owner quota without spending share access", async () => {
    state.user!.bandwidthUsedBytes = 80;

    await expect(
      reserveSharePlaybackAccess("share-1", "owner-1", 60),
    ).rejects.toBeInstanceOf(BandwidthQuotaError);

    expect(state.user?.bandwidthUsedBytes).toBe(80);
    expect(state.share?.accessCount).toBe(0);
  });

  it("distinguishes a deleted share from an exhausted share", async () => {
    state.share = null;

    const result = await reserveSharePlaybackAccess("share-1", "owner-1", 60);

    expect(result).toBe("share-unavailable");
    expect(state.user?.bandwidthUsedBytes).toBe(0);
  });

  it("throws a bounded error when the owner disappears", async () => {
    state.user = null;

    await expect(
      reserveSharePlaybackAccess("share-1", "owner-1", 60),
    ).rejects.toBeInstanceOf(SharePlaybackReservationError);
    expect(state.share?.accessCount).toBe(0);
  });
});
