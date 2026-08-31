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
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { useConfirm } from "@admin/presentation/components/confirm-dialog";
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
} from "@admin/presentation/components/admin-ui";
import { apiFetch } from "@/shared/api/client";
import { APP_NAME } from "@/shared/lib/app-version";
import { cn } from "@/shared/lib/utils";
import { useFormat, useT } from "@/shared/lib/i18n";

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
  problemCodes?: Array<"none" | "unverified" | "unavailable">;
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
const SENDER_STATUS: Record<MailStatus, { labelKey: "statusVerified" | "statusFailed" | "statusUnverified"; tone: Tone; icon: typeof CircleCheck }> = {
  ok: { labelKey: "statusVerified", tone: "success", icon: CircleCheck },
  error: { labelKey: "statusFailed", tone: "danger", icon: CircleX },
  unverified: { labelKey: "statusUnverified", tone: "muted", icon: CircleDashed },
};

export default function EmailSettings() {
  const t = useT();
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
      if (!res.success) throw new Error(res.error ?? t("admin.email.addFailed"));
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["mail-senders"] });
      queryClient.invalidateQueries({ queryKey: ["mail-health"] });
      if (data && !data.verify.ok) {
        // Saved, but Gmail rejected the login — keep the modal open with the reason.
        setFormError(data.verify.error ?? t("admin.email.gmailRejected"));
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
      if (!res.success) throw new Error(res.error ?? t("admin.email.verifyFailed"));
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
        title: t("admin.email.removeTitle", { name: sender.displayName }),
        message:
          senders.filter((s) => s.isActive && s.status === "ok").length <= 1
            ? t("admin.email.removeLast")
            : t("admin.email.removeBody"),
        confirmLabel: t("admin.email.remove"),
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
        kicker={t("admin.email.kicker")}
        title={t("admin.email.title")}
        lede={t("admin.email.lede")}
        live
        liveLabel={t("admin.email.polling")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setShowAddModal(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("admin.email.addSender")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={ShieldCheck}
          label={t("admin.email.readyNow")}
          value={health ? health.eligibleSenders : "—"}
          tone={health && health.eligibleSenders > 0 ? "success" : "danger"}
          hint={health ? t("admin.email.configured", { count: health.totalSenders }) : t("admin.email.checking")}
        />
        <AdminMetric
          icon={CircleCheck}
          label={t("admin.email.verified")}
          value={health ? health.readySenders : "—"}
          tone="accent"
          hint={t("admin.email.accepted")}
        />
        <AdminMetric
          icon={AlertTriangle}
          label={t("admin.email.resting")}
          value={health ? health.coolingSenders : "—"}
          tone={health && health.coolingSenders > 0 ? "warning" : "muted"}
          hint={t("admin.email.cooldownHint")}
        />
        <AdminMetric
          icon={Gauge}
          label={t("admin.email.sentToday")}
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
              t("admin.email.noActive")
            )
          }
        />
      </div>

      <GatewayStatus data={health} loading={healthLoading} />

      <AdminPanel
        icon={Inbox}
        title={t("admin.email.senders", { count: senders.length })}
        sub={t("admin.email.senderOrder")}
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-20 w-full" rows={2} />
          </div>
        ) : senders.length === 0 ? (
          <AdminEmpty
            icon={Mail}
            title={t("admin.email.emptyTitle")}
            body={t("admin.email.emptyBody")}
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
                {t("admin.email.addSender")}
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
  const t = useT();
  const { formatTimestamp } = useFormat();
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
          {!sender.isActive && <Chip tone="muted">{t("admin.email.inactive")}</Chip>}
        </div>

        <p className="flex items-center gap-1.5 text-[0.78rem] font-medium" data-tone={status.tone}>
          <status.icon className="h-3.5 w-3.5" style={{ color: "var(--tone)" }} aria-hidden="true" />
          <span style={{ color: "var(--tone)" }}>{t(`admin.email.${status.labelKey}`)}</span>
          <span className="adm-sub">· {t("admin.email.sendsAs", { name: sender.fromName })}</span>
        </p>

        {sender.status === "error" && sender.lastError && (
          <Note icon={CircleX} tone="danger">
            {sender.lastError}
          </Note>
        )}

        <div className="max-w-sm space-y-1.5 pt-0.5">
          <div className="flex items-center justify-between text-[0.7rem]">
            <span className="adm-sub">{t("admin.email.dailyUsage")}</span>
            <span className="adm-num">
              {used} / {limit}
            </span>
          </div>
          <Meter value={ratio} tone={barTone} />
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {cooling && (
              <Chip tone="warning" icon={AlertTriangle}>
                {t("admin.email.cooling", { count: cooldownMins })}
              </Chip>
            )}
            {!cooling && ratio >= 1 && <Chip tone="danger">{t("admin.email.limitReached")}</Chip>}
            {sender.consecutiveFailures > 0 && !cooling && (
              <Chip tone="muted">
                {t("admin.email.recentFailures", { count: sender.consecutiveFailures })}
              </Chip>
            )}
            {sender.lastUsedAt && (
              <span className="adm-sub">
                {t("admin.email.lastUsed", { date: formatTimestamp(sender.lastUsedAt) })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onTest} disabled={testing} title={t("admin.email.retest")}>
          {testing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          {t("admin.email.test")}
        </Button>
        <IconButton
          icon={deleting ? Loader2 : Trash2}
          tone="danger"
          label={t("admin.email.removeNamed", { name: sender.displayName })}
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
  const t = useT();
  if (loading || !data) {
    return (
      <AdminPanel icon={ShieldCheck} title={t("admin.email.gatewayStatus")}>
        <Skeleton className="h-4 w-52" />
      </AdminPanel>
    );
  }

  const ok = data.healthy;

  return (
    <AdminPanel
      icon={ok ? ShieldCheck : ShieldAlert}
      tone={ok ? "success" : "warning"}
      title={ok ? t("admin.email.gatewayHealthy") : t("admin.email.gatewayAttention")}
      sub={
        ok
          ? t("admin.email.healthyBody")
          : t("admin.email.attentionBody")
      }
      variant={ok ? undefined : "warn"}
      tools={
        <Chip tone={ok ? "success" : "warning"} mono>
          {t("admin.email.eligible", { count: data.eligibleSenders })}
        </Chip>
      }
    >
      {data.problems.length > 0 ? (
        <ul className="space-y-2">
          {data.problems.map((problem, index) => (
            <li key={index}>
              <Note icon={AlertTriangle} tone="warning">
                {data.problemCodes?.[index]
                  ? t(`admin.email.problem${data.problemCodes[index] === "none" ? "None" : data.problemCodes[index] === "unverified" ? "Unverified" : "Unavailable"}`)
                  : problem}
              </Note>
            </li>
          ))}
        </ul>
      ) : (
        <p className="adm-sub">
          {t("admin.email.gatewaySummary", { active: data.activeSenders, verified: data.readySenders, limit: data.defaultDailyLimit })}
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
  const t = useT();
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
              {t("admin.email.addTitle")}
            </h2>
            <p className="adm-panel__sub">{t("admin.email.addSubtitle")}</p>
          </div>
          <IconButton icon={X} label={t("admin.email.close")} onClick={onClose} />
        </div>

        <div className="adm-sheet__body space-y-3.5">
          <Field label={t("admin.email.displayName")} hint={t("admin.email.displayHint")}>
            <Input
              placeholder={t("admin.email.displayPlaceholder")}
              value={values.displayName}
              onChange={(e) => onChange.setDisplayName(e.target.value)}
              autoFocus
            />
          </Field>

          <Field label={t("admin.email.gmailAddress")}>
            <Input
              type="email"
              placeholder={t("admin.email.gmailAddress")}
              value={values.email}
              onChange={(e) => onChange.setEmail(e.target.value)}
            />
          </Field>

          <Field label={t("admin.email.appPassword")} hint={t("admin.email.appPasswordHint")}>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                placeholder={t("admin.email.appPasswordPlaceholder")}
                value={values.appPassword}
                onChange={(e) => onChange.setAppPassword(e.target.value)}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={onTogglePw}
                aria-label={showPw ? t("admin.email.hidePassword") : t("admin.email.showPassword")}
                className="adm-iconbtn absolute right-1.5 top-1/2 -translate-y-1/2"
              >
                {showPw ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
          </Field>

          <Field label={t("admin.email.fromName")} hint={t("admin.email.fromHint")}>
            <Input
              placeholder={APP_NAME}
              value={values.fromName}
              onChange={(e) => onChange.setFromName(e.target.value)}
            />
          </Field>

          <Note icon={Info}>
            {t("admin.email.appPasswordHelp")}
          </Note>

          {error && (
            <Note icon={CircleX} tone="danger">
              {error}
            </Note>
          )}
        </div>

        <div className="adm-sheet__foot">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("admin.email.cancel")}
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={!ready || pending}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            {t("admin.email.verifySave")}
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
  const t = useT();
  const { formatTimeSeconds } = useFormat();
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
      title={t("admin.email.activityTitle")}
      sub={t("admin.email.activitySub")}
      tools={
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden="true" />
          {t("admin.email.refresh")}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-3 w-full" rows={5} />
      ) : !data || data.length === 0 ? (
        <p className="adm-sub py-4 text-center">
          {t("admin.email.noEvents")}
        </p>
      ) : (
        <div className="adm-log" role="log" aria-label={t("admin.email.activityLabel")}>
          {data.map((entry, index) => (
            <span key={index} className="adm-log__line" data-tone={LEVEL_TONE[entry.level]}>
              <span className="opacity-60">{formatTimeSeconds(new Date(entry.ts))}</span>{" "}
              <span className="font-semibold uppercase opacity-80">{entry.type}</span>{" "}
              {entry.message}
            </span>
          ))}
        </div>
      )}
    </AdminPanel>
  );
}
