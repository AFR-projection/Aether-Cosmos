import { beforeEach, describe, expect, it, vi } from "vitest";

type UserRow = {
  id: string;
  bandwidthQuotaBytes: number;
  bandwidthUsedBytes: number;
  bandwidthPeriodStart: Date | null;
};

const store = vi.hoisted(() => ({
  user: null as UserRow | null,
  transactions: 0,
  updates: 0,
  lockedReads: 0,
  queue: Promise.resolve() as Promise<unknown>,
}));

vi.mock("@/shared/infrastructure/db", () => ({
  db: {
    transaction<T>(body: (tx: unknown) => Promise<T>): Promise<T> {
      store.transactions += 1;
      const run = async () => {
        const before = store.user ? { ...store.user } : null;
        try {
          return await body(fakeTx);
        } catch (error) {
          store.user = before;
          throw error;
        }
      };
      const result = store.queue.then(run, run);
      store.queue = result.catch(() => undefined);
      return result;
    },
  },
}));

const fakeTx = {
  select() {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      for: async (mode: string) => {
        expect(mode).toBe("update");
        store.lockedReads += 1;
        return store.user ? [{ ...store.user }] : [];
      },
    };
    return chain;
  },
  update() {
    let values: Partial<UserRow> = {};
    const chain = {
      set(next: Partial<UserRow>) {
        values = next;
        return chain;
      },
      async where() {
        store.updates += 1;
        if (store.user) Object.assign(store.user, values);
      },
    };
    return chain;
  },
};

const { BandwidthQuotaError, recordBandwidth } = await import("./bandwidth");

beforeEach(() => {
  store.user = {
    id: "owner-1",
    bandwidthQuotaBytes: 100,
    bandwidthUsedBytes: 0,
    bandwidthPeriodStart: new Date("2026-09-08T00:00:00.000Z"),
  };
  store.transactions = 0;
  store.updates = 0;
  store.lockedReads = 0;
  store.queue = Promise.resolve();
  vi.useRealTimers();
});

describe("recordBandwidth", () => {
  it("serializes concurrent reservations so the quota cannot overspend", async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 25 }, () => recordBandwidth("owner-1", 10)),
    );

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(10);
    const refused = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(refused).toHaveLength(15);
    expect(
      refused.every((result) => result.reason instanceof BandwidthQuotaError),
    ).toBe(true);
    expect(store.user?.bandwidthUsedBytes).toBe(100);
    expect(store.transactions).toBe(25);
    expect(store.lockedReads).toBe(25);
  });

  it("resets an expired period while holding the same row lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    store.user = {
      id: "owner-1",
      bandwidthQuotaBytes: 100,
      bandwidthUsedBytes: 99,
      bandwidthPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
    };

    await recordBandwidth("owner-1", 60);

    expect(store.user?.bandwidthUsedBytes).toBe(60);
    expect(store.user?.bandwidthPeriodStart).toEqual(
      new Date("2026-09-08T00:00:00.000Z"),
    );
  });

  it("keeps zero quota unlimited without writing usage", async () => {
    store.user!.bandwidthQuotaBytes = 0;

    await recordBandwidth("owner-1", 1_000_000);

    expect(store.user?.bandwidthUsedBytes).toBe(0);
    expect(store.updates).toBe(0);
  });
});
