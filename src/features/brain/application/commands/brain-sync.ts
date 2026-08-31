"use client";

/**
 * Cross-document notification that one brain's data changed.
 *
 * The popped-out graph window is a separate document with its own React Query
 * cache, so an edit made in the main window is invisible to it. Every write in the
 * app already funnels through one invalidator (`useBrainInvalidator`); this channel
 * carries that same signal to the other windows, where it triggers the identical
 * `invalidateQueries` call. The server stays the single source of truth — nothing
 * ships data over the channel, only "brain X is stale".
 */

const CHANNEL = "brain-data-changed";

export type BrainChangeMessage = { brainId: string; at: number };

function channel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Announces a write. A BroadcastChannel never echoes to the posting document. */
export function publishBrainChange(brainId: string | undefined): void {
  if (!brainId) return;
  const bus = channel();
  if (!bus) return;
  try {
    bus.postMessage({ brainId, at: Date.now() } satisfies BrainChangeMessage);
  } finally {
    bus.close();
  }
}

export function subscribeBrainChange(
  listener: (message: BrainChangeMessage) => void
): () => void {
  const bus = channel();
  if (!bus) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data as Partial<BrainChangeMessage> | null;
    if (!data || typeof data.brainId !== "string") return;
    listener({ brainId: data.brainId, at: typeof data.at === "number" ? data.at : Date.now() });
  };
  bus.addEventListener("message", handler);
  return () => {
    bus.removeEventListener("message", handler);
    bus.close();
  };
}
