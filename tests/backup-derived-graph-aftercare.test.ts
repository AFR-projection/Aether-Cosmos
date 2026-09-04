import { describe, expect, it, vi } from "vitest";

// Relative, and pointing into `app/`, because that is where the module lives: it needs
// `@brain/*` and `src/features/backup` may not import a sibling feature, so the seam is composed
// in the route folder. `vitest.config.ts` has no `app/*` alias, hence the path.
import { scheduleDerivedGraphRebuild } from "../app/api/backup/restore/_aftercare";
import { RELATE_SWEEP_MAX } from "@brain/application/commands/relate-jobs";

/** Jobs the stubbed queue accepted, for the one test that uses the real default enqueue. */
const jobs: { type: string; data: Record<string, unknown> }[] = [];

vi.mock("@/shared/infrastructure/queue", () => ({
  getQueue: vi.fn(() => null),
  enqueueJob: vi.fn(async (type: string, data: Record<string, unknown>) => {
    jobs.push({ type, data });
    return true;
  }),
}));

/**
 * A Brain restore ends by asking the worker to rebuild the graph it deliberately did not carry.
 *
 * This is the test for a gap that no other test could see, because every part of it worked: the
 * archive carried `memory_links` and `brain_relationships` faithfully, the importer wrote them,
 * and `/brain` showed the memories. What stayed empty was `/brain/graph` — `memory_derived_links`
 * is classified DERIVED and recomputed by `relate_memory`, which is enqueued only by
 * `memory-service`'s write path. An import writes through its own sink, so nothing was ever
 * queued and the scored edges came back only for memories the account happened to edit by hand.
 *
 * The enqueue is injected, so what is verified here is the decision — how many jobs, for which
 * brains, and what the caller is told when the queue refuses — with no Redis and no worker.
 */

describe("scheduling the derived-graph rebuild after a restore", () => {
  it("asks for one sweep per brain and reports them all queued", async () => {
    const asked: string[] = [];

    const report = await scheduleDerivedGraphRebuild(["brain-a", "brain-b", "brain-c"], async (id) => {
      asked.push(id);
      return true;
    });

    expect(asked).toEqual(["brain-a", "brain-b", "brain-c"]);
    expect(report).toEqual({ brains: 3, queued: 3 });
  });

  it("counts a brain once even when it is named twice", async () => {
    // `listBrains` cannot return a duplicate, but a future caller unioning "brains the archive
    // named" with "brains the account owns" easily could, and two sweeps of one brain is wasted
    // work whose second half is a no-op.
    const asked: string[] = [];

    const report = await scheduleDerivedGraphRebuild(["brain-a", "brain-a", "brain-b"], async (id) => {
      asked.push(id);
      return true;
    });

    expect(asked).toEqual(["brain-a", "brain-b"]);
    expect(report).toEqual({ brains: 2, queued: 2 });
  });

  it("says how many jobs the queue actually took", async () => {
    // `enqueueJob` returns false rather than throwing when Redis is disabled or unreachable —
    // which is right, and is exactly why someone has to count. This number is what lets the
    // response say "your graph will rebuild when the worker is running again" instead of
    // claiming a rebuild that nobody is going to perform.
    const report = await scheduleDerivedGraphRebuild(["brain-a", "brain-b"], async () => false);

    expect(report).toEqual({ brains: 2, queued: 0 });
  });

  it("keeps going when one brain's enqueue throws, and does not rethrow", async () => {
    // The restore this follows has already committed. An exception escaping here would report a
    // data loss that did not happen, and one unlucky brain must not decide that the others are
    // not worth trying.
    const asked: string[] = [];

    const report = await scheduleDerivedGraphRebuild(
      ["brain-a", "brain-b", "brain-c"],
      async (id) => {
        asked.push(id);
        if (id === "brain-b") throw new Error("ECONNREFUSED 127.0.0.1:6379");
        return true;
      }
    );

    expect(asked).toEqual(["brain-a", "brain-b", "brain-c"]);
    expect(report).toEqual({ brains: 3, queued: 2 });
  });

  it("asks for nothing when the account owns no brain", async () => {
    let calls = 0;

    const report = await scheduleDerivedGraphRebuild([], async () => {
      calls += 1;
      return true;
    });

    expect(calls).toBe(0);
    expect(report).toEqual({ brains: 0, queued: 0 });
  });

  it("queues relate_brain with the sweep's ceiling, not its default batch", async () => {
    // The one test that exercises the real default enqueue, because the *limit* is the whole
    // reach of the rebuild: `runRelateBrainJob` scores the oldest `limit` memories and
    // deliberately does not re-queue itself, so leaving the default (`RELATE_SWEEP_LIMIT`, 200)
    // would silently stop rebuilding a restored brain's graph at its 200th memory.
    jobs.length = 0;

    const report = await scheduleDerivedGraphRebuild(["brain-a"]);

    expect(report).toEqual({ brains: 1, queued: 1 });
    expect(jobs).toEqual([
      { type: "relate_brain", data: { brainId: "brain-a", limit: RELATE_SWEEP_MAX } },
    ]);
  });
});
