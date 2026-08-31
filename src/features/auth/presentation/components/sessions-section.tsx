"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Laptop,
  Smartphone,
  Tablet,
  Monitor,
  MapPin,
  Shield,
  LogOut,
  Trash2,
  RefreshCw,
  Loader2,
  Clock,
  Globe,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { apiFetch } from "@/shared/api/client";
import { cn } from "@/shared/lib/utils";
import { useRouter } from "next/navigation";
import { rememberCurrentSessionId } from "@/ui/hooks/use-realtime-events";
import { notify } from "@/shared/lib/system/notify-store";
import { apiErrorMessage, useFormat, useT, type Translator } from "@/shared/lib/i18n";

export type DeviceSession = {
  id: string;
  idShort?: string;
  ip: string | null;
  userAgent: string | null;
  deviceLabel: string;
  deviceKind?: "desktop" | "mobile" | "tablet" | "unknown";
  locationLabel?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

function DeviceIcon({ kind }: { kind?: DeviceSession["deviceKind"] }) {
  const Icon =
    kind === "mobile" ? Smartphone : kind === "tablet" ? Tablet : kind === "desktop" ? Laptop : Monitor;
  return <Icon className="h-4 w-4" />;
}

/**
 * How long ago, in the compact form this metadata line has room for. Replaces
 * date-fns's `formatDistanceToNow`, which only ever spoke English here; past a
 * day the age stops being useful and a real date reads better, which `Intl`
 * orders per language — so the formatter is passed in rather than built here,
 * keeping this function free of hooks.
 */
function relativeTime(
  iso: string,
  t: Translator,
  formatMonthDay: (date: Date | string) => string
): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("common.relative.now");
  if (diff < 3_600_000) return t("common.relative.minutes", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("common.relative.hours", { count: Math.floor(diff / 3_600_000) });
  return formatMonthDay(new Date(ts));
}

export function SessionsSection() {
  const t = useT();
  const { formatMonthDay } = useFormat();
  const [busy, setBusy] = useState<"others" | "all" | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"others" | "all" | null>(null);
  const router = useRouter();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["auth-sessions"],
    queryFn: async () => {
      const res = await apiFetch<{
        sessions: DeviceSession[];
        currentSessionId?: string;
      }>("/api/auth/sessions");
      if (!res.success) throw new Error(apiErrorMessage(res, t, "settings.devices.loadFailed"));
      if (res.data?.currentSessionId) {
        rememberCurrentSessionId(res.data.currentSessionId);
      }
      return res.data!;
    },
    refetchInterval: 30_000,
  });

  const sessions = data?.sessions ?? [];
  const otherCount = useMemo(() => sessions.filter((s) => !s.isCurrent).length, [sessions]);

  async function handleRevoke(id: string, wasCurrent: boolean) {
    setRevokingId(id);
    try {
      const res = await apiFetch<{ wasCurrent?: boolean }>(`/api/auth/sessions/${id}`, {
        method: "DELETE",
      });
      if (!res.success) {
        notify({
          title: t("settings.devices.revokeFailed"),
          description: apiErrorMessage(res, t, "errors.unexpected"),
          tone: "warning",
        });
        return;
      }
      if (wasCurrent || res.data?.wasCurrent) {
        router.push("/login?alert=SESSION_REVOKED");
        router.refresh();
        return;
      }
      notify({ title: t("settings.devices.signedOutDevice"), tone: "success" });
      await refetch();
    } finally {
      setRevokingId(null);
    }
  }

  async function handleRevokeOthers() {
    setBusy("others");
    setConfirm(null);
    try {
      const res = await apiFetch("/api/auth/sessions", { method: "DELETE" });
      if (!res.success) {
        notify({
          title: t("settings.devices.signOutOthersFailed"),
          description: apiErrorMessage(res, t, "errors.unexpected"),
          tone: "warning",
        });
        return;
      }
      notify({
        title: t("settings.devices.othersSignedOutTitle"),
        description: t("settings.devices.othersSignedOutNote"),
        tone: "success",
      });
      await refetch();
    } finally {
      setBusy(null);
    }
  }

  async function handleLogoutAll() {
    setBusy("all");
    setConfirm(null);
    try {
      await apiFetch("/api/auth/sessions?all=1", { method: "DELETE" });
      router.push("/login?alert=SESSION_REVOKED");
      router.refresh();
    } catch {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Security posture strip */}
      <div className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.07] via-transparent to-sky-500/[0.06] p-4">
        <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-emerald-400/10 blur-2xl" />
        <div className="relative flex gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Shield className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">
              {t("settings.devices.protectionTitle")}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
              {t("settings.devices.protectionNote")}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t("settings.devices.activeDevices")}</p>
          <p className="text-[12px] text-muted-foreground">
            {t("settings.devices.sessionCount", { count: sessions.length })}
            {otherCount > 0
              ? ` · ${t("settings.devices.otherCount", { count: otherCount })}`
              : ""}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          {t("common.refresh")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ul className="space-y-2.5">
          <AnimatePresence initial={false}>
            {sessions.map((session, index) => (
              <motion.li
                key={session.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ delay: index * 0.04, duration: 0.25 }}
                className={cn(
                  "group relative overflow-hidden rounded-2xl border p-3.5 transition-colors",
                  session.isCurrent
                    ? "border-emerald-500/35 bg-emerald-500/[0.06]"
                    : "border-border/50 bg-muted/10 hover:border-border hover:bg-muted/20"
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                      session.isCurrent
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-muted/60 text-muted-foreground"
                    )}
                  >
                    <DeviceIcon kind={session.deviceKind} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold tracking-tight">
                        {session.deviceLabel}
                      </p>
                      {session.isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          {t("settings.devices.thisDevice")}
                        </span>
                      )}
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                      {session.locationLabel ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3 opacity-70" />
                          {session.locationLabel}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Globe className="h-3 w-3 opacity-70" />
                          {t("settings.devices.locationUnavailable")}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                        {/* An initialism, the same three characters in every locale. */}
                        IP {session.ip ?? "—"}
                      </span>
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/80">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {t("settings.devices.lastActive", {
                          when: relativeTime(session.lastActiveAt, t, formatMonthDay),
                        })}
                      </span>
                      <span>
                        {t("settings.devices.signedIn", {
                          when: relativeTime(session.createdAt, t, formatMonthDay),
                        })}
                      </span>
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8 shrink-0 text-muted-foreground transition-opacity",
                      "opacity-70 hover:text-rose-500 group-hover:opacity-100",
                      session.isCurrent && "opacity-100"
                    )}
                    disabled={revokingId === session.id || busy !== null}
                    onClick={() => handleRevoke(session.id, session.isCurrent)}
                    title={t(
                      session.isCurrent
                        ? "settings.devices.signOutThisDevice"
                        : "settings.devices.revokeSession"
                    )}
                  >
                    {revokingId === session.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>

          {sessions.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("settings.devices.noSessions")}
            </p>
          )}
        </ul>
      )}

      {/* Confirm panels */}
      <AnimatePresence>
        {confirm && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
          >
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {t(
                    confirm === "others"
                      ? "settings.devices.confirmOthersTitle"
                      : "settings.devices.confirmAllTitle"
                  )}
                </p>
                <p className="mt-1 text-[12.5px] text-muted-foreground">
                  {t(
                    confirm === "others"
                      ? "settings.devices.confirmOthersNote"
                      : "settings.devices.confirmAllNote"
                  )}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={confirm === "all" ? "destructive" : "secondary"}
                    disabled={busy !== null}
                    onClick={() =>
                      confirm === "others" ? handleRevokeOthers() : handleLogoutAll()
                    }
                  >
                    {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    {t("common.confirm")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setConfirm(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="secondary"
          onClick={() => setConfirm("others")}
          disabled={busy !== null || otherCount === 0 || !!confirm}
          className="flex-1"
        >
          {t("settings.devices.signOutOthers")}
          {otherCount > 0 ? ` (${otherCount})` : ""}
        </Button>
        <Button
          variant="destructive"
          onClick={() => setConfirm("all")}
          disabled={busy !== null || !!confirm}
          className="flex-1"
        >
          {busy === "all" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="mr-2 h-4 w-4" />
          )}
          {t("settings.devices.signOutAll")}
        </Button>
      </div>
    </div>
  );
}
