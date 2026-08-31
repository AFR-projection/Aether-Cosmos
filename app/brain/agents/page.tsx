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
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { BrainShell } from "@brain/presentation/components/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@brain/presentation/components/brain-states";
import {
  agentMonogram,
  bucketTimestamps,
  deriveAgentPresence,
  describeAge,
  formatAge,
  PresencePill,
  TickStrip,
  useNow,
} from "@brain/presentation/components/agent-presence";
import { useDialogs } from "@/ui/primitives/dialog-prompts";
import { notify } from "@/shared/lib/system/notify-store";
import { cn } from "@/shared/lib/utils";
import { useFormat, useT } from "@/shared/lib/i18n";
import {
  BRAIN_RISKY_SCOPES,
  brainOperationLabel,
  brainScopeDescription,
  brainScopeLabel,
} from "@brain/domain/ui-constants";
import {
  useActiveBrain,
  useAgents,
  useBrainAudit,
  useConnectInfo,
  useCreateAgent,
  useRevokeAgent,
  type BrainAgent,
} from "@brain/presentation/hooks/use-brain";

/**
 * The audit feed is the only signal there is for "which agents are talking to
 * this brain right now" (see @brain/presentation/components/agent-presence.tsx), so this page
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
  const t = useT();

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
          notify({ title: t("brain.agents.clipboardBlocked"), tone: "error" });
        }
      }}
    >
      {copied ? (
        <Check className="h-4 w-4 text-success-ink" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {copied ? t("common.copied") : label}
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
  const t = useT();
  const age = updatedAt > 0 ? formatAge(now - updatedAt, t) : null;
  return (
    <span
      className="brain-sync"
      data-state={state}
      title={t("brain.agents.syncTitle", { seconds: Math.round(AUDIT_POLL_MS / 1000) })}
    >
      <span className="brain-sync__dot" aria-hidden="true" />
      {state === "error"
        ? t("brain.agents.syncFailed")
        : state === "syncing"
          ? t("brain.agents.syncing")
          : t("brain.agents.syncLive")}
      {age && state !== "error" && (
        <>
          <span aria-hidden="true">·</span>
          <span className="brain-sync__time">{age}</span>
          <span className="sr-only">
            {t("brain.agents.lastUpdated", { age: describeAge(now - updatedAt, t) })}
          </span>
        </>
      )}
    </span>
  );
}

export default function BrainAgentsPage() {
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();
  const t = useT();
  const { formatDate, formatNumber } = useFormat();

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
          notify({ title: t("brain.agents.created"), tone: "success" });
        },
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.agents.createFailed"),
            tone: "error",
          }),
      }
    );
  }

  async function handleRevoke(agent: BrainAgent, everywhere: boolean) {
    const confirmed = await askConfirm({
      title: everywhere
        ? t("brain.agents.revokeEverywhereTitle", { name: agent.name })
        : t("brain.agents.removeAccessTitle", { name: agent.name }),
      message: everywhere
        ? t("brain.agents.revokeEverywhereBody")
        : t("brain.agents.removeAccessBody"),
      confirmText: everywhere
        ? t("brain.agents.revokeEverywhere")
        : t("brain.agents.removeAccess"),
      danger: everywhere,
    });
    if (!confirmed) return;

    revokeAgent.mutate(
      { agentId: agent.id, everywhere },
      {
        onSuccess: () => notify({ title: t("brain.agents.revoked"), tone: "success" }),
        onError: (error) =>
          notify({
            title: error instanceof Error ? error.message : t("brain.agents.revokeFailed"),
            tone: "error",
          }),
      }
    );
  }

  return (
    <BrainShell
      title={t("brain.agents.title")}
      description={t("brain.agents.description")}
      actions={
        <Button size="sm" onClick={() => setCreating((value) => !value)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("brain.agents.connectAction")}
        </Button>
      }
    >
      {dialogs}

      <div className="space-y-5">
        {/* ── Live fleet ── */}
        <section className="brain-surface p-5" aria-label={t("brain.agents.fleetStatus")}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Radio className="h-4 w-4 text-accent-ink" aria-hidden="true" />
                {t("brain.agents.liveFleet")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("brain.agents.fleetBody", { count: AUDIT_WINDOW })}
              </p>
            </div>
            <SyncPill state={syncState} updatedAt={audit.dataUpdatedAt} now={now} />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="brain-metric" data-presence="live">
              <span>
                <Zap aria-hidden="true" />
                {t("brain.agents.connected")}
              </span>
              <strong>{formatNumber(fleet.live)}</strong>
              <small>{t("brain.agents.connectedHint")}</small>
            </div>
            <div className="brain-metric">
              <span>
                <Activity aria-hidden="true" />
                {t("brain.agents.idle")}
              </span>
              <strong>{formatNumber(fleet.idle)}</strong>
              <small>{t("brain.agents.idleHint")}</small>
            </div>
            <div className="brain-metric">
              <span>
                <Users aria-hidden="true" />
                {t("brain.agents.roster")}
              </span>
              <strong>
                {formatNumber(fleet.active)}
                {agents.data && (
                  <span className="text-sm font-normal text-muted-foreground">
                    {" / "}
                    {formatNumber(agents.data.maxAgents)}
                  </span>
                )}
              </strong>
              <small>{t("brain.agents.rosterHint")}</small>
            </div>
            <div className="brain-metric">
              <span>
                <Terminal aria-hidden="true" />
                {t("brain.agents.calls")}
              </span>
              <strong>{formatNumber(fleet.calls)}</strong>
              <small>{t("brain.agents.callsHint")}</small>
            </div>
          </div>

          <div className="mt-4">
            <TickStrip
              buckets={fleet.buckets}
              label={t("brain.agents.fleetTicks", { count: fleet.calls })}
            />
            <div className="brain-ticks__axis">
              <span>{t("brain.agents.axisStart")}</span>
              <span>{t("brain.agents.axisEnd")}</span>
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
            title={t("brain.agents.keyFor", { name: issuedKey.agent })}
            className="brain-surface--warn"
          >
            <p className="text-sm text-muted-foreground">{t("brain.agents.keyOnce")}</p>
            <code
              className={cn("brain-code brain-code--secret mt-3 block", !keyRevealed && "brain-code--masked")}
            >
              {issuedKey.key}
            </code>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={issuedKey.key} label={t("brain.agents.copyKey")} />
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
                {keyRevealed ? t("brain.agents.hide") : t("brain.agents.reveal")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIssuedKey(null);
                  setKeyRevealed(false);
                }}
              >
                {t("brain.agents.keySaved")}
              </Button>
            </div>
          </BrainPanel>
        )}

        {creating && (
          <BrainPanel icon={Plus} title={t("brain.agents.connectTitle")}>
            <form onSubmit={handleCreate} className="space-y-4">
              <Input
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("brain.agents.namePlaceholder")}
                aria-label={t("brain.agents.nameLabel")}
                autoFocus
              />

              <fieldset>
                <legend className="mb-2 text-xs font-medium text-foreground">
                  {t("brain.agents.permissions")}
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {availableScopes.map((scope) => {
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
                          <span className="brain-scope__label">{brainScopeLabel(scope, t)}</span>
                          <span className="brain-scope__hint">
                            {brainScopeDescription(scope, t) ?? scope}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("brain.agents.riskyOff")}
                </p>
              </fieldset>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!name.trim() || effectiveScopes.length === 0 || createAgent.isPending}
                >
                  {createAgent.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  )}
                  {t("brain.agents.createAgent")}
                </Button>
              </div>
            </form>
          </BrainPanel>
        )}

        {agents.isLoading && <BrainLoading label={t("brain.agents.loading")} />}
        {agents.isError && (
          <BrainErrorState
            message={t("brain.agents.loadFailed")}
            onRetry={() => void agents.refetch()}
          />
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
                            ? t("brain.agents.lastActivity", {
                                operation: brainOperationLabel(state.lastOperation, t),
                                date: formatDate(state.lastSeenAt, "medium"),
                              })
                            : t("brain.agents.addedOn", {
                                date: formatDate(agent.createdAt, "medium"),
                              })}
                        </span>
                      </div>

                      {state && state.ops > 0 && (
                        <div className="hidden shrink-0 text-right sm:block">
                          <TickStrip
                            compact
                            buckets={state.buckets}
                            label={t("brain.agents.agentTicks", {
                              name: agent.name,
                              count: state.ops,
                            })}
                          />
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {t("brain.agents.callsWindow", { count: state.ops })}
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
                            {brainScopeLabel(scope, t)}
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
                          {t("brain.agents.removeFromBrain")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={revokeAgent.isPending || agent.status !== "active"}
                          onClick={() => void handleRevoke(agent, true)}
                        >
                          <ShieldOff className="h-4 w-4" aria-hidden="true" />
                          {t("brain.agents.revokeEverywhere")}
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
              <p className="brain-empty__title">{t("brain.agents.emptyTitle")}</p>
              <p className="brain-empty__body">{t("brain.agents.emptyBody")}</p>
              <Button size="sm" className="mt-1" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("brain.agents.connectTitle")}
              </Button>
            </div>
          ))}

        {connect.data && (
          <BrainPanel icon={Plug} title={t("brain.agents.mcpTitle")}>
            <p className="text-sm text-muted-foreground">{t("brain.agents.mcpBody")}</p>

            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t("brain.agents.endpoint")}
                </dt>
                <dd className="mt-1.5 flex flex-wrap items-center gap-2">
                  <code className="brain-code min-w-0 flex-1">{connect.data.mcp.url}</code>
                  <CopyButton value={connect.data.mcp.url} label={t("brain.agents.copyUrl")} />
                </dd>
              </div>

              <div>
                <dt className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t("brain.agents.snippet")}
                </dt>
                <dd className="mt-1.5">
                  {/* Two ways in, one at a time — a switch instead of two stacked
                      code blocks the user has to scroll past. */}
                  <div
                    className="brain-seg mb-2"
                    role="group"
                    aria-label={t("brain.agents.snippetFormat")}
                  >
                    <button
                      type="button"
                      className="brain-seg__btn"
                      aria-pressed={connectTab === "config"}
                      onClick={() => setConnectTab("config")}
                    >
                      {t("brain.agents.clientConfig")}
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
                            label={
                              connectTab === "config"
                                ? t("brain.agents.copyConfig")
                                : t("brain.agents.copyCommand")
                            }
                          />
                        </div>
                      </>
                    );
                  })()}
                </dd>
              </div>

              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t("brain.agents.authentication")}
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
