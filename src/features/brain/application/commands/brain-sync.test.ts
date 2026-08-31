import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { publishBrainChange, subscribeBrainChange } from "./brain-sync";

/**
 * The cross-window "brain X is stale" channel.
 *
 * The popped-out graph is a separate document with its own query cache, so a write in
 * the main window is invisible to it until this channel says so. Two properties are
 * asserted: the channel carries a signal and never data — the server stays the single
 * source of truth — and a browser without BroadcastChannel (or one that refuses to
 * construct it) degrades to a no-op instead of breaking every write in the app.
 */

type Instance = {
  name: string;
  posted: unknown[];
  closed: boolean;
  listeners: Set<(event: MessageEvent) => void>;
};

const instances: Instance[] = [];
let constructorThrows = false;

class FakeBroadcastChannel {
  private readonly self: Instance;

  constructor(name: string) {
    if (constructorThrows) throw new Error("SecurityError");
    this.self = { name, posted: [], closed: false, listeners: new Set() };
    instances.push(this.self);
  }

  postMessage(message: unknown): void {
    this.self.posted.push(message);
  }

  addEventListener(_type: string, handler: (event: MessageEvent) => void): void {
    this.self.listeners.add(handler);
  }

  removeEventListener(_type: string, handler: (event: MessageEvent) => void): void {
    this.self.listeners.delete(handler);
  }

  close(): void {
    this.self.closed = true;
  }
}

/** Delivers a message to the subscriber, the way the browser would. */
function deliver(instance: Instance, data: unknown): void {
  for (const handler of instance.listeners) handler({ data } as MessageEvent);
}

beforeEach(() => {
  instances.length = 0;
  constructorThrows = false;
  vi.stubGlobal("window", {});
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("publishBrainChange", () => {
  it("announces the brain and the time, and nothing else", () => {
    // No memory content crosses the channel — the other window refetches from the API,
    // which authorizes the brain again.
    publishBrainChange("brain-1");

    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe("brain-data-changed");
    expect(instances[0].posted).toHaveLength(1);
    expect(Object.keys(instances[0].posted[0] as object).sort()).toEqual(["at", "brainId"]);
    expect((instances[0].posted[0] as { brainId: string }).brainId).toBe("brain-1");
  });

  it("closes the channel it opened", () => {
    publishBrainChange("brain-1");
    expect(instances[0].closed).toBe(true);
  });

  it("does nothing without a brain id", () => {
    publishBrainChange(undefined);
    publishBrainChange("");
    expect(instances).toEqual([]);
  });

  it("is a no-op where BroadcastChannel does not exist", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => publishBrainChange("brain-1")).not.toThrow();
    expect(instances).toEqual([]);
  });

  it("is a no-op when the browser refuses to construct one", () => {
    constructorThrows = true;
    expect(() => publishBrainChange("brain-1")).not.toThrow();
  });

  it("is a no-op on the server", () => {
    vi.unstubAllGlobals();
    expect(() => publishBrainChange("brain-1")).not.toThrow();
    expect(instances).toEqual([]);
  });
});

describe("subscribeBrainChange", () => {
  it("hands the listener the brain that went stale", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrainChange(listener);

    deliver(instances[0], { brainId: "brain-1", at: 1234 });

    expect(listener).toHaveBeenCalledWith({ brainId: "brain-1", at: 1234 });
    unsubscribe();
  });

  it("supplies a timestamp when the message has none", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrainChange(listener);

    deliver(instances[0], { brainId: "brain-1" });

    expect(listener.mock.calls[0][0].brainId).toBe("brain-1");
    expect(typeof listener.mock.calls[0][0].at).toBe("number");
    unsubscribe();
  });

  it("ignores anything that is not a brain change", () => {
    // Another feature could share the document; a malformed payload must not become an
    // invalidation for an empty brain id.
    const listener = vi.fn();
    const unsubscribe = subscribeBrainChange(listener);

    for (const payload of [null, undefined, "brain-1", 42, {}, { brainId: 42 }, { at: 1 }]) {
      deliver(instances[0], payload);
    }

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops listening and closes the channel on unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrainChange(listener);

    unsubscribe();
    deliver(instances[0], { brainId: "brain-1", at: 1 });

    expect(listener).not.toHaveBeenCalled();
    expect(instances[0].listeners.size).toBe(0);
    expect(instances[0].closed).toBe(true);
  });

  it("returns a safe no-op unsubscribe where there is no channel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const unsubscribe = subscribeBrainChange(vi.fn());

    expect(instances).toEqual([]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("keeps the publisher and the subscriber on separate channel objects", () => {
    // A BroadcastChannel never echoes to the posting document, so the publisher opening
    // and closing its own object cannot disturb a live subscription.
    const unsubscribe = subscribeBrainChange(vi.fn());
    publishBrainChange("brain-1");

    expect(instances).toHaveLength(2);
    expect(instances[0].closed).toBe(false);
    expect(instances[1].closed).toBe(true);
    unsubscribe();
  });
});

