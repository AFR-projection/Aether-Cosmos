"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { BRAIN_OPERATION_COPY } from "@/lib/brain/ui-constants";
import type { BrainAgent, BrainAuditEntry } from "@/hooks/use-brain";

/**
 * Live presence for brain agents, derived on the client.
 *
 * There is no `last_seen_at` on brain_agents and no agent event on the SSE
 * stream, so "is this agent connected right now?" has to be answered from
 * something that already exists: the audit log. Every authenticated agent call
 * appends a row whose `principalId` is the agent id (see lib/brain/access.ts),
 * which makes the newest such row the agent's last heartbeat.
 *
 * That means presence is exactly as fresh as the audit poll — which is why the
 * page states its own refresh cadence instead of implying a socket.
 */

export type PresenceTier = "live" | "idle" | "dormant" | "never" | "revoked";

const LIVE_MS = 2 * 60_000;
const IDLE_MS = 30 * 60_000;

/** Word per tier. Colour is never the only carrier of this information. */
export const PRESENCE_LABEL: Record<PresenceTier, string> = {
  live: "Connected",
  idle: "Idle",
  dormant: "Dormant",
  never: "Never connected",
  revoked: "Revoked",
};

export type AgentPresence = {
  tier: PresenceTier;
  label: string;
  lastSeenAt: string | null;
  /** Compact relative age of the last call, e.g. "12s", "4m", "3d". */
  age: string | null;
  /** Calls seen inside the fetched audit window, not all time. */
  ops: number;
  lastOperation: string | null;
  viaMcp: boolean;
  /** Per-bucket activity, already normalised to 0–1 for the tick strip. */
  buckets: number[];
};

/** "just now" resolution near zero, then s → m → h → d. Never negative. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Spoken form for the same age, so a screen reader does not read "12s". */
export function describeAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Buckets timestamps into `count` slots ending at `now`, then scales the counts
 * against the busiest slot so the tallest tick is always full height.
 */
export function bucketTimestamps(
  timestamps: number[],
  { now, spanMs, count }: { now: number; spanMs: number; count: number }
): number[] {
  const slots = new Array<number>(count).fill(0);
  const width = spanMs / count;
  for (const at of timestamps) {
    const age = now - at;
    if (age < 0 || age >= spanMs) continue;
    const index = count - 1 - Math.floor(age / width);
    if (index >= 0 && index < count) slots[index] += 1;
  }
  const peak = Math.max(...slots, 0);
  return peak === 0 ? slots : slots.map((value) => value / peak);
}

/** Per-agent tick strip window: 12 slots of ten minutes = the last two hours. */
const AGENT_SPAN_MS = 2 * 60 * 60_000;
const AGENT_BUCKETS = 12;

/**
 * Joins the roster against the audit feed once, rather than scanning the feed
 * per agent, and returns a map keyed by agent id.
 */
export function deriveAgentPresence(
  agents: BrainAgent[],
  entries: BrainAuditEntry[],
  now: number
): Map<string, AgentPresence> {
  const byAgent = new Map<string, BrainAuditEntry[]>();
  for (const entry of entries) {
    if (entry.principalType !== "agent") continue;
    const bucket = byAgent.get(entry.principalId);
    if (bucket) bucket.push(entry);
    else byAgent.set(entry.principalId, [entry]);
  }

  const presence = new Map<string, AgentPresence>();
  for (const agent of agents) {
    // The endpoint returns newest-first, so index 0 is the latest call.
    const own = byAgent.get(agent.id) ?? [];
    const latest = own[0] ?? null;
    const lastSeenMs = latest ? Date.parse(latest.createdAt) : NaN;
    const age = Number.isNaN(lastSeenMs) ? null : now - lastSeenMs;

    // Revoked wins over any traffic: a dead key must never read as connected.
    const tier: PresenceTier =
      agent.status !== "active"
        ? "revoked"
        : age === null
          ? "never"
          : age <= LIVE_MS
            ? "live"
            : age <= IDLE_MS
              ? "idle"
              : "dormant";

    presence.set(agent.id, {
      tier,
      label: PRESENCE_LABEL[tier],
      lastSeenAt: latest?.createdAt ?? null,
      age: age === null ? null : formatAge(age),
      ops: own.length,
      lastOperation: latest
        ? BRAIN_OPERATION_COPY[latest.operation] ?? latest.operation
        : null,
      viaMcp:
        (latest?.metadata as { transport?: string } | null | undefined)?.transport === "mcp",
      buckets: bucketTimestamps(
        own.map((entry) => Date.parse(entry.createdAt)).filter((at) => !Number.isNaN(at)),
        { now, spanMs: AGENT_SPAN_MS, count: AGENT_BUCKETS }
      ),
    });
  }
  return presence;
}

/**
 * Local clock that advances on its own. Relative ages and tier transitions stay
 * honest between polls without costing a single extra request.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function PresencePill({ presence }: { presence: AgentPresence }) {
  return (
    <span className="brain-presence">
      <span className="brain-presence__dot" aria-hidden="true" />
      {presence.label}
      {presence.age && (
        <span className="brain-presence__age" aria-hidden="true">
          {presence.age}
        </span>
      )}
    </span>
  );
}

/**
 * Decorative bar strip. Every number it draws is also stated in text beside it,
 * and the wrapper carries a label, so nothing here is the only route to the
 * information.
 */
export function TickStrip({
  buckets,
  label,
  compact,
}: {
  buckets: number[];
  label: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn("brain-ticks", compact && "brain-ticks--compact")}
      role="img"
      aria-label={label}
    >
      {buckets.map((value, index) => (
        <i key={index} style={{ "--v": value } as React.CSSProperties} />
      ))}
    </span>
  );
}

/** First letters of the agent name — an avatar that needs no upload. */
export function agentMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2);
  return `${words[0][0]}${words[1][0]}`;
}
