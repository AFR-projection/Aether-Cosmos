"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mail,
  Plus,
  Trash2,
  Loader2,
  X,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Send,
  RefreshCw,
  Eye,
  EyeOff,
  ScrollText,
  CircleCheck,
  CircleX,
  CircleDashed,
  Gauge,
  Inbox,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/admin/confirm-dialog";
import {
  AdminEmpty,
  AdminHeader,
  AdminMetric,
  AdminPanel,
  Chip,
  IconButton,
  Meter,
  Note,
  Skeleton,
  StatusDot,
  type Tone,
} from "@/components/admin/admin-ui";
import { apiFetch } from "@/lib/api/client";
import { APP_NAME } from "@/lib/app-version";
import { cn } from "@/lib/utils";

type MailStatus = "unverified" | "ok" | "error";
type MailSenderRow = {
  id: string;
  email: string;
  displayName: string;
  fromName: string;
  status: MailStatus;
  isActive: boolean;
  lastError: string | null;
  lastVerifiedAt: string | null;
  priority: number;
  dailyLimit: number;
  dailySentCount: number;
  sentCountResetAt: string | null;
  lastUsedAt: string | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
};

type VerifyResult = { ok: boolean; error?: string };

type MailHealth = {
  healthy: boolean;
  totalSenders: number;
  activeSenders: number;
  readySenders: number;
  eligibleSenders: number;
  coolingSenders: number;
  defaultDailyLimit: number;
  problems: string[];
};

/** A "now" timestamp that ticks on an interval, so time-based UI stays live
 *  without calling Date.now() during render (which must stay pure). */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Sender status in words, with an icon that carries the same meaning. The
 * previous version used 🟢/🔴/⚫ emoji, which render differently on every
 * platform, are announced as "large green circle" by screen readers, and are an
 * explicit anti-pattern in this project's design system.
 */
const SENDER_STATUS: Record<MailStatus, { label: string; tone: Tone; icon: typeof CircleCheck }> = {
  ok: { label: "Verified & ready", tone: "success", icon: CircleCheck },
  error: { label: "Login failed", tone: "danger", icon: CircleX },
  unverified: { label: "Not verified yet", tone: "muted", icon: CircleDashed },
};

export default function EmailSettings() {
  const now = useNow();
  const confirm = useConfirm();
  const [showAddModal, setShowAddModal] = useState(false);
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [fromName, setFromName] = useState(APP_NAME);
  const [showPw, setShowPw] = useState(false);
  const [formError, setFormError] = useState("");
  const queryClient = useQueryClient();

  const { data: senders = [], isLoading } = useQuery({
    queryKey: ["mail-senders"],
    queryFn: async () => {
      const res = await apiFetch<MailSenderRow[]>("/api/admin/email/senders");
      return res.data ?? [];
    },
    refetchInterval: 10000,
  });

  // One ["mail-health"] query for the whole page: the metric row, the gateway
  // panel, and the per-sender default limit all read from it.
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ["mail-health"],
    queryFn: async () => {
      const res = await apiFetch<MailHealth>("/api/admin/email/health");
      if (!res.success || !res.data) throw new Error(res.error ?? "unavailable");
      return res.data;
    },
    refetchInterval: 15000,
  });
  const defaultDailyLimit = health?.defaultDailyLimit ?? 400;

  // Today's headroom across every eligible sender, so the operator can see at a
  // glance whether the gateway can still deliver an OTP burst.
  const capacity = useMemo(() => {
    let used = 0;
    let total = 0;
    for (const sender of senders) {
      if (!sender.isActive) continue;
      const limit = sender.dailyLimit > 0 ? sender.dailyLimit : defaultDailyLimit;
      const windowActive =
        sender.sentCountResetAt &&
        now - new Date(sender.sentCountResetAt).getTime() < 24 * 60 * 60 * 1000;
      total += limit;
      used += windowActive ? sender.dailySentCount : 0;
    }
    return { used, total };
  }, [senders, defaultDailyLimit, now]);

  const resetForm = () => {
    setEmail("");
    setAppPassword("");
    setDisplayName("");
    setFromName(APP_NAME);
    setShowPw(false);
    setFormError("");
  };

  const addSender = useMutation({
    mutationFn: async () => {
      const res = await apiFetch<MailSenderRow & { verify: VerifyResult }>(
        "/api/admin/email/senders",
        {
          method: "POST",
          body: JSON.stringify({ email, appPassword, displayName, fromName }),
        }
      );
      if (!res.success) throw new Error(res.error ?? "Failed to add sender");
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["mail-senders"] });
      queryClient.invalidateQueries({ queryKey: ["mail-health"] });
      if (data && !data.verify.ok) {
        // Saved, but Gmail rejected the login — keep the modal open with the reason.
        setFormError(data.verify.error ?? "Gmail rejected the login");
        return;
      }
      setShowAddModal(false);
      resetForm();
    },
    onError: (err) => setFormError((err as Error).message),
  });

  const verifySender = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch<{ verify: VerifyResult }>("/api/admin/email/verify", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      if (!res.success) throw new Error(res.error ?? "Verify failed");
      return res.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["mail-senders"] }),
  });

  const deleteSender = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch("/api/admin/email/senders", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail-senders"] });
      queryClient.invalidateQueries({ queryKey: ["mail-health"] });
    },
  });

  /**
   * Removing a sender can silently stop OTP delivery, so it now asks first —
   * every other destructive action in the console already did, and this one being
   * a bare one-click button was an inconsistency waiting to bite.
   */
  function askDelete(sender: MailSenderRow) {
    confirm.open(
      {
        title: `Remove ${sender.displayName}?`,
        message:
          senders.filter((s) => s.isActive && s.status === "ok").length <= 1
            ? "This is the last verified sender. Removing it will stop OTP and security emails from going out until another one is added."
            : "Its stored app password is deleted with it. Mail already sent is unaffected.",
        confirmLabel: "Remove sender",
        danger: true,
      },
      async () => {
        await deleteSender.mutateAsync(sender.id);
      }
    );
  }

  return (
    <div className="space-y-5">
      <AdminHeader
        icon={Mail}
        kicker="Email gateway"
        title="Outbound mail"
        lede="Gmail senders that deliver one-time codes and security notices. The router picks whichever verified sender still has headroom today."
        live
        liveLabel="Polling every 10s"
        actions={
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setShowAddModal(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add sender
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={ShieldCheck}
          label="Ready now"
          value={health ? health.eligibleSenders : "—"}
          tone={health && health.eligibleSenders > 0 ? "success" : "danger"}
          hint={health ? `of ${health.totalSenders} configured` : "Checking…"}
        />
        <AdminMetric
          icon={CircleCheck}
          label="Verified"
          value={health ? health.readySenders : "—"}
          tone="accent"
          hint="Gmail accepted the login"
        />
        <AdminMetric
          icon={AlertTriangle}
          label="Resting"
          value={health ? health.coolingSenders : "—"}
          tone={health && health.coolingSenders > 0 ? "warning" : "muted"}
          hint="In cooldown after failures"
        />
        <AdminMetric
          icon={Gauge}
          label="Sent today"
          value={capacity.used}
          unit={capacity.total > 0 ? `/ ${capacity.total}` : undefined}
          tone={capacity.total > 0 && capacity.used / capacity.total >= 0.8 ? "warning" : "info"}
          hint={
            capacity.total > 0 ? (
              <Meter
                value={capacity.used / capacity.total}
                tone={capacity.used / capacity.total >= 0.8 ? "warning" : "accent"}
              />
            ) : (
              "No active sender"
            )
          }
        />
      </div>

      <GatewayStatus data={health} loading={healthLoading} />

      <AdminPanel
        icon={Inbox}
        title={`Senders (${senders.length})`}
        sub="Ordered by priority — the router walks this list top-down."
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-20 w-full" rows={2} />
          </div>
        ) : senders.length === 0 ? (
          <AdminEmpty
            icon={Mail}
            title="No sender configured"
            body="Without a verified Gmail sender the app cannot deliver one-time codes, so sign-in and 2FA will fail. Add one to bring the gateway up."
            action={
              <Button
                size="sm"
                className="mt-1"
                onClick={() => {
                  resetForm();
                  setShowAddModal(true);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add the first sender
              </Button>
            }
          />
        ) : (
          <ul>
            {senders.map((sender) => (
              <li key={sender.id} className="adm-row adm-row--flat p-4">
                <SenderCard
                  sender={sender}
                  defaultLimit={defaultDailyLimit}
                  now={now}
                  testing={verifySender.isPending && verifySender.variables === sender.id}
                  onTest={() => verifySender.mutate(sender.id)}
                  onDelete={() => askDelete(sender)}
                  deleting={deleteSender.isPending && deleteSender.variables === sender.id}
                />
              </li>
            ))}
          </ul>
        )}
      </AdminPanel>

      <EmailActivityLog />

      <AnimatePresence>
        {showAddModal && (
          <AddSenderSheet
            values={{ email, appPassword, displayName, fromName }}
            showPw={showPw}
            error={formError}
            pending={addSender.isPending}
            onChange={{ setEmail, setAppPassword, setDisplayName, setFromName }}
            onTogglePw={() => setShowPw((v) => !v)}
            onClose={() => setShowAddModal(false)}
            onSubmit={() => {
              setFormError("");
              addSender.mutate();
            }}
          />
        )}
      </AnimatePresence>

      {confirm.element}
    </div>
  );
}

/* ── Sender ──────────────────────────────────────────────────────────────── */

function SenderCard({
  sender,
  defaultLimit,
  now,
  testing,
  deleting,
  onTest,
  onDelete,
}: {
  sender: MailSenderRow;
  defaultLimit: number;
  now: number;
  testing: boolean;
  deleting: boolean;
  onTest: () => void;
  onDelete: () => void;
}) {
  const status = SENDER_STATUS[sender.status];
  const limit = sender.dailyLimit > 0 ? sender.dailyLimit : defaultLimit;

  // The stored count only counts within the current 24h window; treat an expired
  // window as zero so the bar matches what the router actually sees.
  const windowActive =
    sender.sentCountResetAt &&
    now - new Date(sender.sentCountResetAt).getTime() < 24 * 60 * 60 * 1000;
  const used = windowActive ? sender.dailySentCount : 0;
  const ratio = used / Math.max(1, limit);

  const cooling =
    sender.cooldownUntil && new Date(sender.cooldownUntil).getTime() > now
      ? sender.cooldownUntil
      : null;
  const cooldownMins = cooling
    ? Math.max(1, Math.ceil((new Date(cooling).getTime() - now) / 60000))
    : 0;

  const barTone: Tone = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "success";

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot tone={status.tone} ring={sender.status === "ok"} />
          <h3 className="text-sm font-semibold">{sender.displayName}</h3>
          <Chip mono>{sender.email}</Chip>
          {!sender.isActive && <Chip tone="muted">Inactive</Chip>}
        </div>

        <p className="flex items-center gap-1.5 text-[0.78rem] font-medium" data-tone={status.tone}>
          <status.icon className="h-3.5 w-3.5" style={{ color: "var(--tone)" }} aria-hidden="true" />
          <span style={{ color: "var(--tone)" }}>{status.label}</span>
          <span className="adm-sub">· sends as “{sender.fromName}”</span>
        </p>

        {sender.status === "error" && sender.lastError && (
          <Note icon={CircleX} tone="danger">
            {sender.lastError}
          </Note>
        )}

        <div className="max-w-sm space-y-1.5 pt-0.5">
          <div className="flex items-center justify-between text-[0.7rem]">
            <span className="adm-sub">Daily usage</span>
            <span className="adm-num">
              {used} / {limit}
            </span>
          </div>
          <Meter value={ratio} tone={barTone} />
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {cooling && (
              <Chip tone="warning" icon={AlertTriangle}>
                Resting ~{cooldownMins}m
              </Chip>
            )}
            {!cooling && ratio >= 1 && <Chip tone="danger">Daily limit reached</Chip>}
            {sender.consecutiveFailures > 0 && !cooling && (
              <Chip tone="muted">
                {sender.consecutiveFailures} recent failure
                {sender.consecutiveFailures > 1 ? "s" : ""}
              </Chip>
            )}
            {sender.lastUsedAt && (
              <span className="adm-sub">
                last used {new Date(sender.lastUsedAt).toLocaleString("en-GB")}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onTest} disabled={testing} title="Re-test this sender">
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Test
        </Button>
        <IconButton
          icon={deleting ? Loader2 : Trash2}
          tone="danger"
          label={`Remove ${sender.displayName}`}
          disabled={deleting}
          onClick={onDelete}
          className={deleting ? "[&_svg]:animate-spin" : undefined}
        />
      </div>
    </div>
  );
}

/* ── Gateway status ──────────────────────────────────────────────────────── */


/** The one-line answer to "can this app send mail right now", plus why not. */
function GatewayStatus({ data, loading }: { data?: MailHealth; loading: boolean }) {
  if (loading || !data) {
    return (
      <AdminPanel icon={ShieldCheck} title="Gateway status">
        <Skeleton className="h-4 w-52" />
      </AdminPanel>
    );
  }

  const ok = data.healthy;

  return (
    <AdminPanel
      icon={ok ? ShieldCheck : ShieldAlert}
      tone={ok ? "success" : "warning"}
      title={ok ? "Gateway healthy" : "Gateway needs attention"}
      sub={
        ok
          ? "At least one verified sender has headroom, so outbound mail is going out."
          : "Mail may be delayed or failing. The reasons are listed below."
      }
      variant={ok ? undefined : "warn"}
      tools={
        <Chip tone={ok ? "success" : "warning"} mono>
          {data.eligibleSenders} eligible
        </Chip>
      }
    >
      {data.problems.length > 0 ? (
        <ul className="space-y-2">
          {data.problems.map((problem, index) => (
            <li key={index}>
              <Note icon={AlertTriangle} tone="warning">
                {problem}
              </Note>
            </li>
          ))}
        </ul>
      ) : (
        <p className="adm-sub">
          <span className="adm-num">{data.activeSenders}</span> active ·{" "}
          <span className="adm-num">{data.readySenders}</span> verified · daily cap{" "}
          <span className="adm-num">{data.defaultDailyLimit}</span> per sender by default.
        </p>
      )}
    </AdminPanel>
  );
}

/* ── Add sender ──────────────────────────────────────────────────────────── */

/**
 * Uses the shared `.scrim` and `.adm-sheet` chrome rather than the ad-hoc
 * `bg-black/50` overlay it replaced, so every dialog in the app dims the page the
 * same way and picks up lite mode for free.
 */
function AddSenderSheet({
  values,
  showPw,
  error,
  pending,
  onChange,
  onTogglePw,
  onClose,
  onSubmit,
}: {
  values: { email: string; appPassword: string; displayName: string; fromName: string };
  showPw: boolean;
  error: string;
  pending: boolean;
  onChange: {
    setEmail: (v: string) => void;
    setAppPassword: (v: string) => void;
    setDisplayName: (v: string) => void;
    setFromName: (v: string) => void;
  };
  onTogglePw: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const ready = !!values.email && !!values.appPassword && !!values.displayName;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="scrim fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        className="adm-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-sender-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="adm-sheet__head">
          <span className="adm-panel__badge" aria-hidden="true">
            <Plus />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="add-sender-title" className="adm-panel__title">
              Add a Gmail sender
            </h2>
            <p className="adm-panel__sub">Saved only if Gmail accepts the login.</p>
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>

        <div className="adm-sheet__body space-y-3.5">
          <Field label="Display name" hint="How this sender is labelled in the console.">
            <Input
              placeholder="e.g. Main sender"
              value={values.displayName}
              onChange={(e) => onChange.setDisplayName(e.target.value)}
              autoFocus
            />
          </Field>

          <Field label="Gmail address">
            <Input
              type="email"
              placeholder="you@gmail.com"
              value={values.email}
              onChange={(e) => onChange.setEmail(e.target.value)}
            />
          </Field>

          <Field label="App password" hint="Stored encrypted. It is never shown again after saving.">
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                placeholder="16-character app password"
                value={values.appPassword}
                onChange={(e) => onChange.setAppPassword(e.target.value)}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={onTogglePw}
                aria-label={showPw ? "Hide app password" : "Show app password"}
                className="adm-iconbtn absolute right-1.5 top-1/2 -translate-y-1/2"
              >
                {showPw ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
          </Field>

          <Field label="From name" hint="What recipients see in their inbox.">
            <Input
              placeholder={APP_NAME}
              value={values.fromName}
              onChange={(e) => onChange.setFromName(e.target.value)}
            />
          </Field>

          <Note icon={Info}>
            <strong>Getting an app password:</strong> turn on 2-Step Verification for the Google
            account, then open Google Account → Security → App passwords, create one for
            “Mail”, and paste the 16-character code above.
          </Note>

          {error && (
            <Note icon={CircleX} tone="danger">
              {error}
            </Note>
          )}
        </div>

        <div className="adm-sheet__foot">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={!ready || pending}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            Verify &amp; save
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="adm-field__label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="adm-field__hint mt-1 block">{hint}</span>}
    </label>
  );
}

/* ── Activity tail ──────────────────────────────────────────────────────── */

type EmailLogEntry = {
  ts: number;
  level: "info" | "warn" | "error";
  type: "verify" | "send" | "deliver" | "otp";
  message: string;
  meta?: Record<string, unknown>;
};

const LEVEL_TONE: Record<EmailLogEntry["level"], Tone | undefined> = {
  error: "danger",
  warn: "warning",
  info: undefined,
};

function EmailActivityLog() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["mail-logs"],
    queryFn: async () => {
      const res = await apiFetch<{ entries: EmailLogEntry[] }>("/api/admin/email/logs?limit=100");
      if (!res.success || !res.data) throw new Error(res.error ?? "unavailable");
      return res.data.entries;
    },
    refetchInterval: 5000,
  });

  return (
    <AdminPanel
      icon={ScrollText}
      title="Recent email activity"
      sub="Live tail from this server process — last 100 events, cleared on restart."
      tools={
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden="true" />
          Refresh
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-3 w-full" rows={5} />
      ) : !data || data.length === 0 ? (
        <p className="adm-sub py-4 text-center">
          Nothing yet. Sends, verifications, and OTP events will appear here as they happen.
        </p>
      ) : (
        <div className="adm-log" role="log" aria-label="Recent email activity">
          {data.map((entry, index) => (
            <span key={index} className="adm-log__line" data-tone={LEVEL_TONE[entry.level]}>
              <span className="opacity-60">{new Date(entry.ts).toLocaleTimeString("en-GB")}</span>{" "}
              <span className="font-semibold uppercase opacity-80">{entry.type}</span>{" "}
              {entry.message}
            </span>
          ))}
        </div>
      )}
    </AdminPanel>
  );
}
