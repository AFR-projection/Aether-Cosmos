"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, LockKeyhole, Loader2, RotateCcw, Unlock } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { apiFetch } from "@/shared/api/client";
import { useFormat, useT } from "@/shared/lib/i18n";
import { cn } from "@/shared/lib/utils";

/**
 * Master view of one user's login layers.
 *
 * Deliberately read-plus-recover only: a master can unlock, clear, or flag a
 * code, but never see or choose one. That keeps an admin account from being a
 * silent bypass of the user's second factor.
 */

interface SecurityStatus {
  username: string;
  stepCode: {
    enabled: boolean;
    updatedAt: string | null;
    mustChange: boolean;
    failedAttempts: number;
    maxAttempts: number;
    locked: boolean;
    lockedUntil: string | null;
  };
  totp: { enabled: boolean };
  password: {
    mustChange: boolean;
    failedAttempts: number;
    locked: boolean;
    lockedUntil: string | null;
  };
}

type Action = "unlock" | "reset" | "require_change";

export function UserSecurityPanel({ userId }: { userId: string }) {
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(
    null
  );
  const [revokeSessions, setRevokeSessions] = useState(false);
  const t = useT();
  const { formatTime } = useFormat();

  const query = useQuery({
    queryKey: ["admin-user-security", userId],
    queryFn: async () => {
      const res = await apiFetch<SecurityStatus>(`/api/admin/users/${userId}/step-code`);
      if (!res.success) throw new Error(res.error ?? t("admin.security.loadFailed"));
      return res.data!;
    },
  });

  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      const res = await apiFetch<{ message: string }>(
        `/api/admin/users/${userId}/step-code`,
        {
          method: "POST",
          body: JSON.stringify({ action, revokeSessions }),
        }
      );
      if (!res.success) throw new Error(res.error ?? t("admin.security.actionFailed"));
      return res.data!;
    },
    onSuccess: (data) => {
      setMessage({ type: "success", text: data.message });
      query.refetch();
    },
    onError: (err: Error) => setMessage({ type: "error", text: err.message }),
  });

  if (query.isLoading) return <div className="h-32 skeleton rounded-xl" />;
  if (query.isError || !query.data) {
    return (
      <p className="text-sm text-danger-ink" role="alert">
        {t("admin.security.unavailable")}
      </p>
    );
  }

  const { stepCode, totp, password } = query.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <LayerCard
          label={t("admin.security.layerPassword")}
          active
          warning={password.locked}
          detail={
            password.locked
              ? t("admin.security.locked")
              : password.mustChange
                ? t("admin.security.mustChange")
                : t("admin.security.failedAttempts", { count: password.failedAttempts })
          }
        />
        <LayerCard
          // The product name for this factor, untranslated everywhere else too.
          label="2-Step Code"
          active={stepCode.enabled}
          warning={stepCode.locked}
          detail={
            stepCode.locked
              ? t("admin.security.locked")
              : !stepCode.enabled
                ? t("admin.security.notSet")
                : stepCode.mustChange
                  ? t("admin.security.mustChange")
                  : t("admin.security.failedOfMax", {
                      count: stepCode.failedAttempts,
                      max: stepCode.maxAttempts,
                    })
          }
        />
        <LayerCard
          label={t("admin.security.layerAuthenticator")}
          active={totp.enabled}
          detail={totp.enabled ? t("admin.security.enabled") : t("admin.security.notSet")}
        />
      </div>

      {stepCode.locked && stepCode.lockedUntil && (
        <p className="flex items-center gap-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
          {t("admin.security.lockedUntil", { time: formatTime(stepCode.lockedUntil) })}
        </p>
      )}

      {message && (
        <p
          role="alert"
          className={cn(
            "rounded-xl px-3 py-2 text-xs",
            message.type === "success"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-danger/10 text-danger-ink"
          )}
        >
          {message.text}
        </p>
      )}

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={revokeSessions}
          onChange={(e) => setRevokeSessions(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        {t("admin.security.alsoSignOut")}
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="gap-1.5"
          disabled={mutation.isPending || !stepCode.locked}
          onClick={() => mutation.mutate("unlock")}
        >
          <Unlock className="h-3.5 w-3.5" />
          {t("admin.security.unlock")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="gap-1.5"
          disabled={mutation.isPending || !stepCode.enabled || stepCode.mustChange}
          onClick={() => mutation.mutate("require_change")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("admin.security.requireChange")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="gap-1.5"
          disabled={mutation.isPending || !stepCode.enabled}
          onClick={() => mutation.mutate("reset")}
        >
          {mutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5" />
          )}
          {t("admin.security.clearCode")}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        {t("admin.security.footnote")}
      </p>
    </div>
  );
}

function LayerCard({
  label,
  active,
  warning,
  detail,
}: {
  label: string;
  active: boolean;
  warning?: boolean;
  detail: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2.5",
        warning
          ? "border-amber-500/30 bg-amber-500/[0.05]"
          : active
            ? "border-emerald-500/25 bg-emerald-500/[0.04]"
            : "border-border/50 bg-surface/40"
      )}
    >
      <div className="flex items-center gap-1.5">
        {warning ? (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : active ? (
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
        <p className="truncate text-xs font-medium">{label}</p>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}
