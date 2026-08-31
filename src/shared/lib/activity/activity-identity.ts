"use client";

export type ActivityIdentityMessage = {
  kind: "identity_changed";
  scopeId: string | null;
  previousScopeId: string | null;
};

const CHANNEL_NAME = "sbyafr_activity_identity_v1";
let channel: BroadcastChannel | null = null;
const listeners = new Set<(message: ActivityIdentityMessage) => void>();

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<ActivityIdentityMessage>) => {
    if (event.data?.kind !== "identity_changed") return;
    listeners.forEach((listener) => listener(event.data));
  };
  return channel;
}

export function publishActivityIdentity(scopeId: string | null, previousScopeId: string | null = null): void {
  try { getChannel()?.postMessage({ kind: "identity_changed", scopeId, previousScopeId }); } catch { /* closing popup */ }
}

export function subscribeActivityIdentity(listener: (message: ActivityIdentityMessage) => void): () => void {
  listeners.add(listener);
  getChannel();
  return () => listeners.delete(listener);
}
