"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api/client";
import { APP_NAME } from "@/lib/app-version";

const STORAGE_SCOPES = ["read", "upload", "download", "write", "delete", "full"] as const;
const MASTER_SCOPES = [
  "supreme",
  "admin",
  "admin:users",
  "admin:settings",
  "admin:stats",
  "admin:monitoring",
  "admin:shares",
  "admin:email",
] as const;

type AnyScope = (typeof STORAGE_SCOPES)[number] | (typeof MASTER_SCOPES)[number];

const SCOPE_LABELS: Record<AnyScope, { label: string; description: string; danger?: boolean }> = {
  read: { label: "Read", description: "List files, folders, search, and metadata" },
  upload: { label: "Upload", description: "Upload new files to your storage" },
  download: { label: "Download", description: "Download your files and archives" },
  write: { label: "Write", description: "Rename, move, favorite, and edit notes" },
  delete: { label: "Delete", description: "Move files to trash or delete permanently", danger: true },
  full: { label: "Full storage access", description: "All storage permissions (excludes admin)", danger: true },
  supreme: { label: "Supreme", description: "Unrestricted platform + admin control", danger: true },
  admin: { label: "Admin (all)", description: "Full admin panel API access", danger: true },
  "admin:users": { label: "Manage users", description: "Create, update, suspend, delete users", danger: true },
  "admin:settings": { label: "Platform settings", description: "Change platform configuration", danger: true },
  "admin:stats": { label: "Statistics", description: "Read dashboard statistics" },
  "admin:monitoring": { label: "Monitoring", description: "System health and monitoring" },
  "admin:shares": { label: "All shares", description: "Manage every shared link platform-wide", danger: true },
  "admin:email": { label: "Email", description: "Gmail sender management for OTP + notifications", danger: true },
};

const MASTER_SET = new Set<string>(MASTER_SCOPES);

function parseRequestedScopes(scope: string): AnyScope[] {
  const valid = new Set<string>([...STORAGE_SCOPES, ...MASTER_SCOPES]);
  const parts = scope.split(/\s+/).filter((s) => valid.has(s)) as AnyScope[];
  return parts.length ? (Array.from(new Set(["read", ...parts])) as AnyScope[]) : ["read"];
}

export default function OAuthConsentClient() {
  const router = useRouter();
  const params = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState<string | null>(null);

  const oauth = useMemo(
    () => ({
      client_id: params.get("client_id") ?? "",
      client_name: params.get("client_name") ?? "",
      redirect_uri: params.get("redirect_uri") ?? "",
      scope: params.get("scope") ?? "read",
      state: params.get("state") ?? "",
      code_challenge: params.get("code_challenge") ?? "",
      code_challenge_method: params.get("code_challenge_method") ?? "S256",
    }),
    [params]
  );

  useEffect(() => {
    let alive = true;
    apiFetch<{ role: string }>("/api/auth/login").then((res) => {
      if (alive && res.success && res.data) setRole(res.data.role);
    });
    return () => {
      alive = false;
    };
  }, []);

  const isMaster = role === "master";

  // Only show scopes the account can actually be granted. Master-only scopes are
  // hidden (and server-side clamped) for non-master users — requesting them is a no-op.
  const requestedScopes = useMemo(() => {
    const requested = parseRequestedScopes(oauth.scope);
    return requested.filter((s) => (MASTER_SET.has(s) ? isMaster : true));
  }, [oauth.scope, isMaster]);

  const droppedMasterScopes = useMemo(() => {
    if (isMaster) return [];
    return parseRequestedScopes(oauth.scope).filter((s) => MASTER_SET.has(s));
  }, [oauth.scope, isMaster]);

  const [granted, setGranted] = useState<Set<AnyScope>>(new Set());
  // Reset the checkbox selection when the requested set changes (e.g. once the
  // account role loads and admin scopes appear/disappear) — render-phase state
  // adjustment, the React-recommended alternative to a setState-in-effect.
  const scopeKey = requestedScopes.join(" ");
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);
  if (scopeKey !== lastScopeKey) {
    setLastScopeKey(scopeKey);
    setGranted(new Set(requestedScopes));
  }

  const appLabel = oauth.client_name?.trim() || "An external application";
  let redirectHost = oauth.redirect_uri;
  try {
    redirectHost = new URL(oauth.redirect_uri).host || oauth.redirect_uri;
  } catch {
    /* keep raw value */
  }

  function toggleScope(scope: AnyScope) {
    if (scope === "read") return; // baseline, always granted
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function handleApprove() {
    setError("");
    setLoading(true);
    try {
      const selectedScopes = requestedScopes.filter((s) => granted.has(s));
      const res = await apiFetch<{ redirect_to: string }>("/api/oauth/approve", {
        method: "POST",
        body: JSON.stringify({
          client_id: oauth.client_id,
          redirect_uri: oauth.redirect_uri,
          scope: selectedScopes.join(" ") || "read",
          state: oauth.state,
          code_challenge: oauth.code_challenge,
          code_challenge_method: oauth.code_challenge_method,
        }),
      });
      if (!res.success || !res.data?.redirect_to) {
        setError(res.error ?? "Authorization failed");
        return;
      }
      window.location.href = res.data.redirect_to;
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  if (!oauth.client_id || !oauth.redirect_uri || !oauth.code_challenge) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="max-w-md p-6 text-sm text-muted-foreground">
          Invalid OAuth request. Missing client_id, redirect_uri, or PKCE challenge.
        </Card>
      </div>
    );
  }

  const grantsDangerous = requestedScopes.some((s) => granted.has(s) && SCOPE_LABELS[s].danger);

  return (
    <div className="flex min-h-dvh items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md space-y-4 p-6">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-violet-400" />
          <h1 className="text-lg font-semibold">Authorize connection</h1>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">{appLabel}</span> wants to connect to your
          {APP_NAME} account. Choose what it can do, then allow access.
        </p>

        {/* Awareness: this grants an outside app direct access to your data */}
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-100/90">
            This gives an <span className="font-semibold">external app direct access to your data</span>{" "}
            with the permissions you check below. Only allow apps you trust — you can revoke this
            anytime from the Connection page. Never approve a request you didn&apos;t start yourself.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Permissions requested</p>
          <div className="space-y-1.5">
            {requestedScopes.map((scope) => {
              const meta = SCOPE_LABELS[scope];
              const checked = granted.has(scope);
              const locked = scope === "read";
              return (
                <label
                  key={scope}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                    checked
                      ? meta.danger
                        ? "border-amber-500/40 bg-amber-500/[0.06]"
                        : "border-violet-500/40 bg-violet-500/[0.06]"
                      : "border-border/60 bg-muted/10 hover:bg-muted/20"
                  } ${locked ? "cursor-default opacity-90" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-violet-500"
                    checked={checked}
                    disabled={locked}
                    onChange={() => toggleScope(scope)}
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {meta.label}
                      {meta.danger && (
                        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          sensitive
                        </span>
                      )}
                      {locked && (
                        <span className="rounded-full bg-muted/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                          always
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">{meta.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {droppedMasterScopes.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              This app also requested admin permissions, which were hidden because your account
              isn&apos;t a master account. They will not be granted.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs space-y-1">
          <p>
            <span className="text-muted-foreground">Redirects to:</span>{" "}
            <span className="break-all">{redirectHost}</span>
          </p>
        </div>

        {error && <p className="text-xs text-danger-ink">{error}</p>}
        <div className="flex gap-2">
          <Button
            className={grantsDangerous ? "flex-1 bg-amber-600 hover:bg-amber-500 text-white" : "flex-1"}
            onClick={handleApprove}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Allow access"}
          </Button>
          <Button
            variant="ghost"
            className="flex-1"
            onClick={() => router.push("/dashboard")}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          After allowing access, you&apos;ll be redirected back to the connector app. OAuth tokens are
          used for API access — your sk_ API keys are never shared with the app.
        </p>
      </Card>
    </div>
  );
}
