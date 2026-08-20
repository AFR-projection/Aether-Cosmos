"use client";

import { useState } from "react";
import { Bot, Check, Copy, KeyRound, Loader2, Plug, Plus, ShieldOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { BrainShell } from "@/components/brain/brain-shell";
import { BrainErrorState, BrainLoading, BrainPanel } from "@/components/brain/brain-states";
import { useDialogs } from "@/components/ui/dialog-prompts";
import { notify } from "@/lib/system/notify-store";
import { cn, formatDate } from "@/lib/utils";
import { BRAIN_SCOPE_LABELS } from "@/lib/brain/ui-constants";
import {
  useActiveBrain,
  useAgents,
  useConnectInfo,
  useCreateAgent,
  useRevokeAgent,
  type BrainAgent,
} from "@/hooks/use-brain";

/** Copy-to-clipboard that reports success inline rather than via a toast. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="secondary"
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
        <Check className="h-4 w-4 text-success" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}

export default function BrainAgentsPage() {
  const { brain } = useActiveBrain();
  const { dialogs, askConfirm } = useDialogs();

  const agents = useAgents(brain?.id);
  const connect = useConnectInfo(brain?.id);
  const createAgent = useCreateAgent(brain?.id);
  const revokeAgent = useRevokeAgent(brain?.id);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [issuedKey, setIssuedKey] = useState<{ agent: string; key: string } | null>(null);

  const availableScopes = agents.data?.availableScopes ?? [];
  const defaultScopes = agents.data?.defaultScopes ?? [];
  const effectiveScopes = scopes.length > 0 ? scopes : defaultScopes;

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
        {issuedKey && (
          <BrainPanel icon={KeyRound} title={`Key for ${issuedKey.agent}`}>
            <p className="text-sm text-muted-foreground">
              This is the only time the key is shown. Only its hash is stored — if you lose it, mint
              a new agent.
            </p>
            <code className="mt-3 block overflow-x-auto rounded-xl border border-border/50 bg-background-secondary/60 px-3 py-2 font-mono text-xs text-foreground">
              {issuedKey.key}
            </code>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={issuedKey.key} label="Copy key" />
              <Button variant="ghost" size="sm" onClick={() => setIssuedKey(null)}>
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
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-xl border p-3 transition-colors",
                          checked ? "border-accent/40 bg-accent/5" : "border-border/50"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleScope(scope)}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-border/60 accent-[var(--accent)]"
                        />
                        <span>
                          <span className="block text-xs font-medium text-foreground">
                            {meta?.label ?? scope}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {meta?.description ?? scope}
                          </span>
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
          (agents.data.agents.length > 0 ? (
            <div className="space-y-3">
              {agents.data.agents.map((agent) => (
                <article
                  key={agent.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border/50 bg-surface p-4"
                >
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
                      {agent.name}
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                          agent.status === "active"
                            ? "bg-success/10 text-success"
                            : "bg-muted/40 text-muted-foreground"
                        )}
                      >
                        {agent.status}
                      </span>
                    </h3>
                    <p className="mt-1 flex flex-wrap gap-1">
                      {agent.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {BRAIN_SCOPE_LABELS[scope]?.label ?? scope}
                        </span>
                      ))}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Added {formatDate(agent.createdAt, "medium")}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
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
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Bot}
              title="No agents connected"
              description="Create an agent to give OpenClaw, Hermes, or any MCP client scoped access to this brain."
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  Connect an agent
                </Button>
              }
            />
          ))}

        {connect.data && (
          <BrainPanel icon={Plug} title="MCP connection">
            <p className="text-sm text-muted-foreground">
              Point any MCP client at this endpoint with the agent key as a Bearer token. Stateless
              — no session id to manage.
            </p>

            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Endpoint</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="overflow-x-auto rounded-lg border border-border/50 bg-background-secondary/60 px-2 py-1 font-mono text-xs">
                    {connect.data.mcp.url}
                  </code>
                  <CopyButton value={connect.data.mcp.url} label="Copy URL" />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Client config
                </dt>
                <dd className="mt-1">
                  <pre className="max-h-56 overflow-auto rounded-xl border border-border/50 bg-background-secondary/60 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                    {JSON.stringify(connect.data.mcp.exampleClientConfig, null, 2)}
                  </pre>
                  <div className="mt-2">
                    <CopyButton
                      value={JSON.stringify(connect.data.mcp.exampleClientConfig, null, 2)}
                      label="Copy config"
                    />
                  </div>
                </dd>
              </div>
            </dl>
          </BrainPanel>
        )}
      </div>
    </BrainShell>
  );
}
