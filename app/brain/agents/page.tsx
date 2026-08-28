"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  Radio,
  ShieldOff,
  Terminal,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import {
  agentMonogram,
  bucketTimestamps,
  deriveAgentPresence,
  describeAge,
  formatAge,
  PresencePill,
  TickStrip,
  useNow,
} from "@/components/brain/agent-presence";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { notify } from "@/lib/system/notify-store";
import { cn, formatDate } from "@/lib/utils";
import { BRAIN_RISKY_SCOPES, BRAIN_SCOPE_LABELS } from "@/lib/brain/ui-constants";
import {
  useActiveBrain,
  useAgents,
  useBrainAudit,
  useConnectInfo,
  useCreateAgent,
  useRevokeAgent,
  type BrainAgent,
} from "@/hooks/use-brain";

/**
 * The audit feed is the only signal there is for "which agents are talking to
 * this brain right now" (see components/brain/agent-presence.tsx), so this page
 * asks for the widest window the endpoint allows and re-polls it tightly.
 */
const AUDIT_WINDOW = 200;
const AUDIT_POLL_MS = 10_000;

/** Fleet sparkline: 24 hourly buckets. */
const FLEET_SPAN_MS = 24 * 60 * 60_000;
const FLEET_BUCKETS = 24;

/** Copy-to-clipboard that reports success inline rather than via a toast. */
function CopyButton({
  value,
  label,
  variant = "secondary",
}: {
  value: string;
  label: string;
  variant?: "secondary" | "ghost";
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        } catch {
          notify({ title: "Clipboard blocked by the browser", tone: "error" });
        }
      }}
    >
      {copied ? (
        <Check className="h-4 w-4 text-success-ink" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * States plainly how the roster stays current. Polling that is not announced
 * looks like a page that has frozen, so the cadence and the age of the data are
 * both on screen.
 */
function SyncPill({
  state,
  updatedAt,
  now,
}: {
  state: "syncing" | "live" | "error";
  updatedAt: number;
  now: number;
}) {
  const age = updatedAt > 0 ? formatAge(now - updatedAt) : null;
  return (
    <span
      className="brain-sync"
      data-state={state}
      title={`Refreshes every ${Math.round(AUDIT_POLL_MS / 1000)}s`}
    >
      <span className="brain-sync__dot" aria-hidden="true" />
      {state === "error" ? "Sync failed" : state === "syncing" ? "Syncing" : "Live"}
      {age && state !== "error" && (
        <>
          <span aria-hidden="true">·</span>
          <span className="brain-sync__time">{age}</span>
          <span className="sr-only">
            last updated {describeAge(now - updatedAt)}
          </span>
        </>
      )}
    </span>
  );
}

export default function BrainAgentsPage() {
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();

  const agents = useAgents(brain?.id);
  const audit = useBrainAudit(brain?.id, AUDIT_WINDOW, AUDIT_POLL_MS);
  const connect = useConnectInfo(brain?.id);
  const createAgent = useCreateAgent(brain?.id);
  const revokeAgent = useRevokeAgent(brain?.id);

  // One second is enough to make an age readout feel alive and costs nothing —
  // no network, no query invalidation, just a re-render of the derived strings.
  const now = useNow(1000);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [issuedKey, setIssuedKey] = useState<{ agent: string; key: string } | null>(null);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [connectTab, setConnectTab] = useState<"config" | "curl">("config");

  const availableScopes = agents.data?.availableScopes ?? [];
  const defaultScopes = agents.data?.defaultScopes ?? [];
  const effectiveScopes = scopes.length > 0 ? scopes : defaultScopes;

  // `?? []` would mint a fresh array every render and defeat every memo below.
  const roster = useMemo(() => agents.data?.agents ?? [], [agents.data]);
  const entries = useMemo(() => audit.data?.entries ?? [], [audit.data]);

  const presence = useMemo(
    () => deriveAgentPresence(roster, entries, now),
    // `now` ticks every second; the join is a single pass over ≤200 rows.
    [roster, entries, now]
  );

  const fleet = useMemo(() => {
    const agentCalls = entries.filter((entry) => entry.principalType === "agent");
    const tiers = [...presence.values()];
    return {
      live: tiers.filter((item) => item.tier === "live").length,
      idle: tiers.filter((item) => item.tier === "idle").length,
      active: roster.filter((agent) => agent.status === "active").length,
      calls: agentCalls.length,
      buckets: bucketTimestamps(
        agentCalls
          .map((entry) => Date.parse(entry.createdAt))
          .filter((at) => !Number.isNaN(at)),
        { now, spanMs: FLEET_SPAN_MS, count: FLEET_BUCKETS }
      ),
    };
  }, [entries, presence, roster, now]);

  // Sorted so whoever is talking to the brain right now sits at the top.
  const ordered = useMemo(() => {
    const rank = { live: 0, idle: 1, dormant: 2, never: 3, revoked: 4 };
    return [...roster].sort((a, b) => {
      const left = presence.get(a.id);
      const right = presence.get(b.id);
      const byTier = rank[left?.tier ?? "never"] - rank[right?.tier ?? "never"];
      if (byTier !== 0) return byTier;
      return (right?.lastSeenAt ?? "").localeCompare(left?.lastSeenAt ?? "");
    });
  }, [roster, presence]);

  const syncState =
    agents.isError || audit.isError
      ? "error"
      : agents.isFetching || audit.isFetching
        ? "syncing"
        : "live";

  function toggleScope(scope: string) {
    setScopes((current) => {
      const base = current.length > 0 ? current : defaultScopes;
      return base.includes(scope)
        ? base.filter((item) => item !== scope)
        : [...base, scope];
    });
  }

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || effectiveScopes.length === 0) return;

    createAgent.mutate(
      { name: name.trim(), scopes: effectiveScopes },
      {
        onSuccess: (data) => {
          setIssuedKey({ agent: data.agent.name, key: data.rawKey });
          setKeyRevealed(false);
          setName("");
          setScopes([]);
          setCreating(false);
          notify({ title: "Agent created — copy its key now", tone: "success" });
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not create agent",
            tone: "error",
          }),
      }
    );
  }

  async function handleRevoke(agent: BrainAgent, everywhere: boolean) {
    const confirmed = await askConfirm({
      title: everywhere ? `Revoke ${agent.name} everywhere?` : `Remove ${agent.name} from this brain?`,
      message: everywhere
        ? "Its API key is deleted and every brain grant it holds is dropped. This cannot be undone."
        : "It loses access to this brain. Its key keeps working for any other brain it was granted.",
      confirmText: everywhere ? "Revoke everywhere" : "Remove access",
      danger: everywhere,
    });
    if (!confirmed) return;

    revokeAgent.mutate(
      { agentId: agent.id, everywhere },
      {
        onSuccess: () => notify({ title: "Access revoked", tone: "success" }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : "Could not revoke access",
            tone: "error",
          }),
      }
    );
  }

  return (
    <BrainShell
      title="Agents"
      description="Give an external agent scoped access to this brain. The brain outlives the agent."
      actions={
        <Button size="sm" onClick={() => setCreating((value) => !value)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Connect agent
        </Button>
      }
    >
      {dialogs}

      <div className="space-y-5">
        {/* ── Live fleet ── */}
        <section className="brain-surface p-5" aria-label="Fleet status">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Radio className="h-4 w-4 text-accent-ink" aria-hidden="true" />
                Live fleet
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Presence is read from the audit trail — an agent counts as connected once it
                calls this brain. Last {AUDIT_WINDOW} events.
              </p>
            </div>
            <SyncPill state={syncState} updatedAt={audit.dataUpdatedAt} now={now} />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="brain-metric" data-presence="live">
              <span>
                <Zap aria-hidden="true" />
                Connected
              </span>
              <strong>{fleet.live}</strong>
              <small>called in the last 2 minutes</small>
            </div>            <div className="brain-metric">
              <span>
                <Activity aria-hidden="true" />
                Idle
              </span>
              <strong>{fleet.idle}</strong>
              <small>quiet for under 30 minutes</small>
            </div>
            <div className="brain-metric">
              <span>
                <Users aria-hidden="true" />
                Agents
              </span>
              <strong>
                {fleet.active}
                {agents.data && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {" / "}
                    {agents.data.maxAgents}
                  </span>
                )}
              </strong>
              <small>with access to this brain</small>
            </div>
            <div className="brain-metric">
              <span>
                <Terminal aria-hidden="true" />
                Agent calls
              </span>
              <strong>{fleet.calls}</strong>
              <small>in the window shown below</small>
            </div>
          </div>

          <div className="mt-4">
            <TickStrip
              buckets={fleet.buckets}
              label={`Agent calls per hour over the last 24 hours. ${fleet.calls} calls in total.`}
            />
            <div className="brain-ticks__axis">
              <span>24h ago</span>
              <span>now</span>
            </div>
          </div>
        </section>

        {/* ── Freshly issued key ──
            Shown once and never again, so it gets its own warning-tinted panel.
            Masked by default: the key is a bearer credential and this screen may
            be on a shared monitor. Copy works without ever revealing it. */}
        {issuedKey && (
          <BrainPanel
            icon={KeyRound}
            title={`Key for ${issuedKey.agent}`}
            className="brain-surface--warn"
          >
            <p className="text-sm text-muted-foreground">
              This is the only time the key is shown. Only its hash is stored — if you lose it,
              mint a new agent.
            </p>
            <code
              className={cn("brain-code brain-code--secret mt-3 block", !keyRevealed && "brain-code--masked")}
            >
              {issuedKey.key}
            </code>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={issuedKey.key} label="Copy key" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setKeyRevealed((value) => !value)}
                aria-pressed={keyRevealed}
              >
                {keyRevealed ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
                {keyRevealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIssuedKey(null);
                  setKeyRevealed(false);
                }}
              >
                I have saved it
              </Button>
            </div>
          </BrainPanel>
        )}

        {creating && (
          <BrainPanel icon={Plus} title="Connect an agent">
            <form onSubmit={handleCreate} className="space-y-4">
              <Input
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                placeholder="Agent name (OpenClaw, Hermes, …)"
                aria-label="Agent name"
                autoFocus
              />

              <fieldset>
                <legend className="mb-2 text-xs font-medium text-foreground">Permissions</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {availableScopes.map((scope) => {
                    const meta = BRAIN_SCOPE_LABELS[scope];
                    const checked = effectiveScopes.includes(scope);
                    return (
                      <label
                        key={scope}
                        className="brain-scope"
                        data-risk={BRAIN_RISKY_SCOPES.has(scope) ? "high" : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleScope(scope)}
                        />
                        <span className="brain-scope__box" aria-hidden="true">
                          <Check />
                        </span>
                        <span className="min-w-0">
                          <span className="brain-scope__label">{meta?.label ?? scope}</span>
                          <span className="brain-scope__hint">{meta?.description ?? scope}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Delete and Export are off by default on purpose.
                </p>
              </fieldset>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!name.trim() || effectiveScopes.length === 0 || createAgent.isPending}
                >
                  {createAgent.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  Create agent
                </Button>
              </div>
            </form>
          </BrainPanel>
        )}

        {agents.isLoading && <BrainLoading label="Loading agents" />}
        {agents.isError && (
          <BrainErrorState message="Could not load agents." onRetry={() => void agents.refetch()} />
        )}

        {agents.data &&
          (ordered.length > 0 ? (
            <ul className="space-y-3">
              {ordered.map((agent) => {
                const state = presence.get(agent.id);
                const tier = state?.tier ?? "never";
                return (
                  <li key={agent.id} className="brain-agent" data-presence={tier}>
                    <div className="flex items-start gap-3">
                      <span className="brain-agent__avatar" aria-hidden="true">
                        {agentMonogram(agent.name)}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="brain-agent__name">{agent.name}</span>
                          {state && <PresencePill presence={state} />}
                          {state?.viaMcp && (
                            <span className="brain-chip brain-chip--mono brain-chip--on">
                              <Plug aria-hidden="true" />
                              mcp
                            </span>
                          )}
                        </div>
                        <span className="brain-agent__op">
                          {state?.lastOperation && state.lastSeenAt
                            ? `${state.lastOperation} · ${formatDate(state.lastSeenAt, "medium")}`
                            : `Added ${formatDate(agent.createdAt, "medium")}`}
                        </span>
                      </div>

                      {state && state.ops > 0 && (
                        <div className="hidden shrink-0 text-right sm:block">
                          <TickStrip
                            compact
                            buckets={state.buckets}
                            label={`${agent.name}: ${state.ops} calls in the last two hours`}
                          />
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {state.ops} call{state.ops === 1 ? "" : "s"} · 2h
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="flex flex-wrap gap-1.5">
                        {agent.scopes.map((scope) => (
                          <span
                            key={scope}
                            className={cn(
                              "brain-chip",
                              BRAIN_RISKY_SCOPES.has(scope) && "brain-chip--on"
                            )}
                          >
                            {BRAIN_SCOPE_LABELS[scope]?.label ?? scope}
                          </span>
                        ))}
                      </span>

                      <span className="ml-auto flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={revokeAgent.isPending}
                          onClick={() => void handleRevoke(agent, false)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          Remove from brain
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={revokeAgent.isPending || agent.status !== "active"}
                          onClick={() => void handleRevoke(agent, true)}
                        >
                          <ShieldOff className="h-4 w-4" aria-hidden="true" />
                          Revoke everywhere
                        </Button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="brain-empty">
              <span className="brain-empty__icon">
                <Bot className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="brain-empty__title">No agents connected</p>
              <p className="brain-empty__body">
                Create an agent to give OpenClaw, Hermes, or any MCP client scoped access to this
                brain. Once it calls in, it appears here live.
              </p>
              <Button size="sm" className="mt-1" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Connect an agent
              </Button>
            </div>
          ))}

        {connect.data && (
          <BrainPanel icon={Plug} title="MCP connection">
            <p className="text-sm text-muted-foreground">
              Point any MCP client at this endpoint with the agent key as a Bearer token. Stateless
              — no session id to manage.
            </p>

            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Endpoint
                </dt>
                <dd className="mt-1.5 flex flex-wrap items-center gap-2">
                  <code className="brain-code min-w-0 flex-1">{connect.data.mcp.url}</code>
                  <CopyButton value={connect.data.mcp.url} label="Copy URL" />
                </dd>
              </div>

              <div>
                <dt className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Set-up snippet
                </dt>
                <dd className="mt-1.5">
                  {/* Two ways in, one at a time — a switch instead of two stacked
                      code blocks the user has to scroll past. */}
                  <div className="brain-seg mb-2" role="group" aria-label="Snippet format">
                    <button
                      type="button"
                      className="brain-seg__btn"
                      aria-pressed={connectTab === "config"}
                      onClick={() => setConnectTab("config")}
                    >
                      Client config
                    </button>
                    <button
                      type="button"
                      className="brain-seg__btn"
                      aria-pressed={connectTab === "curl"}
                      onClick={() => setConnectTab("curl")}
                    >
                      curl
                    </button>
                  </div>
                  {(() => {
                    const snippet =
                      connectTab === "config"
                        ? JSON.stringify(connect.data.mcp.exampleClientConfig, null, 2)
                        : connect.data.mcp.exampleCurl;
                    return (
                      <>
                        <pre className="brain-code max-h-56">{snippet}</pre>
                        <div className="mt-2">
                          <CopyButton
                            value={snippet}
                            label={connectTab === "config" ? "Copy config" : "Copy command"}
                          />
                        </div>
                      </>
                    );
                  })()}
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Authentication
                </dt>
                <dd className="mt-1.5 text-xs text-muted-foreground">
                  <span className="brain-chip brain-chip--mono">
                    {connect.data.mcp.authentication.format}
                  </span>
                  <span className="mt-1.5 block">{connect.data.mcp.authentication.note}</span>
                </dd>
              </div>
            </dl>
          </BrainPanel>
        )}
      </div>
    </BrainShell>
  );
}
