"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { apiFetch } from "@/shared/api/client";
import {
  StepCodeSection,
  TwoFactorSection,
} from "@auth/presentation/components/account-security-sections";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives/card";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { cn } from "@/shared/lib/utils";
import { relativeTime, useFormat, useT } from "@/shared/lib/i18n";
import { auditActionLabel } from "@admin/domain/services/audit-actions";
import { useState, useEffect, use } from "react";
import {
  ArrowLeft, FileText, Activity, Shield,
  HardDrive, Star, Trash2, Edit, Save, X, KeyRound, Hash,
  Upload, Download, LogIn, Loader2, Eye, EyeOff, AlertCircle, LogOut, Laptop, Smartphone,
} from "lucide-react";
import { notify } from "@/shared/lib/system/notify-store";

interface UserDetail {
  user: {
    id: string;
    username: string;
    email: string | null;
    role: string;
    status: string;
    quotaBytes: number;
    usedBytes: number;
    mustChangePassword?: boolean;
    bandwidthQuotaBytes?: number;
    createdAt: string;
    updatedAt: string;
  };
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    isFavorite: boolean;
    isNote: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  folders: Array<{
    id: string;
    name: string;
    createdAt: string;
  }>;
  activity: Array<{
    id: string;
    action: string;
    createdAt: string;
    metadata: unknown;
  }>;
  sessions: Array<{
    id: string;
    ip: string | null;
    userAgent: string | null;
    deviceLabel?: string | null;
    deviceKind?: string | null;
    locationLabel?: string | null;
    lastActiveAt?: string;
    createdAt: string;
    expiresAt: string;
  }>;
  storageByType: Array<{
    mimeType: string;
    count: number;
    totalSize: number;
  }>;
}

const actionIcons: Record<string, typeof Upload> = {
  upload: Upload,
  download: Download,
  delete: Trash2,
  login: Shield,
  create: FileText,
  restore: Upload,
};

export default function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const t = useT();
  const { formatBytes, formatDate } = useFormat();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    username: "",
    email: "",
    password: "",
    quotaGB: 10,
    bandwidthGB: 0,
    mustChangePassword: false,
  });
  const [saving, setSaving] = useState(false);
  const [showPwNew, setShowPwNew] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [revokingSession, setRevokingSession] = useState<string | null>(null);

  // "Active 4 minutes ago" has to keep moving, and it must not call Date.now()
  // during render. A 30s tick is as fine-grained as this page needs; 0 until the
  // effect runs, which is the signal to say nothing rather than something wrong.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-user-detail", id],
    queryFn: async () => {
      const res = await apiFetch<UserDetail>(`/api/admin/users/${id}`);
      return res.data;
    },
  });

  // Who is logged in — used to show self-only controls (2FA) when a master
  // views their own account.
  const { data: sessionUser } = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await apiFetch<{ id: string; role: string; totpEnabled?: boolean }>("/api/auth/login");
      return res.data;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-32 skeleton rounded-lg" />
        <div className="grid gap-4 md:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-40 skeleton rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { user, files, folders, activity, sessions, storageByType } = data;
  const storagePct = user.quotaBytes > 0 ? (user.usedBytes / user.quotaBytes) * 100 : 0;
  // True when a master is viewing their own account — unlocks 2FA management.
  const isOwnAccount = !!sessionUser && sessionUser.id === user.id;

  async function saveUser() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        username: form.username || undefined,
        // Send null (not undefined) so clearing the field actually removes the email.
        email: form.email.trim() || null,
        quotaBytes: form.quotaGB * 1073741824,
        bandwidthQuotaBytes: form.bandwidthGB * 1073741824,
        mustChangePassword: form.mustChangePassword,
      };
      if (form.password) body.password = form.password;
      const res = await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (res.success) {
        setEditing(false);
        queryClient.invalidateQueries({ queryKey: ["admin-user-detail"] });
      } else {
        setPwMsg({ type: "error", text: res.error ?? t("admin.userDetail.updateFailed") });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Back button + Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-4"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.back()}
          className="h-9 w-9"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{user.username}</h1>
          <p className="mt-1 text-sm text-muted-foreground/70">
            {user.email ?? t("admin.userDetail.noEmail")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
              user.status === "active"
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-red-500/10 text-red-600"
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", user.status === "active" ? "bg-emerald-500" : "bg-red-500")} />
            {user.status === "active"
              ? t("admin.userDetail.statusActive")
              : t("admin.userDetail.statusSuspended")}
          </span>
          {/* The role is an enum the API also accepts back; `master` reads the same
              in all three locales, so it is shown raw like the roster's chip. */}
          <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent-ink uppercase">
            {user.role}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg text-muted-foreground/60 hover:text-accent-ink hover:bg-accent/10"
            title={editing ? t("admin.userDetail.cancelEdit") : t("admin.userDetail.editUser")}
            onClick={() => {
              if (editing) {
                setEditing(false);
              } else {
                setForm({
                  username: user.username,
                  email: user.email ?? "",
                  password: "",
                  quotaGB: Math.round(user.quotaBytes / 1073741824),
                  bandwidthGB: Math.round((user.bandwidthQuotaBytes ?? 0) / 1073741824),
                  mustChangePassword: user.mustChangePassword ?? false,
                });
                setEditing(true);
              }
            }}
          >
            {editing ? <X className="h-4 w-4" /> : <Edit className="h-4 w-4" />}
          </Button>
        </div>
      </motion.div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card className="border-border/50">
            <CardContent className="flex items-center gap-4 p-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/10">
                <HardDrive className="h-6 w-6 text-violet-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{formatBytes(user.usedBytes)}</p>
                <p className="text-sm text-muted-foreground">
                  {t("admin.userDetail.ofQuotaUsed", { total: formatBytes(user.quotaBytes) })}
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <Card className="border-border/50">
            <CardContent className="flex items-center gap-4 p-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10">
                <FileText className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{files.length}</p>
                {/* Two leaves, joined here: the file count is the big number above,
                    and the folder count keeps its own number next to its own noun. */}
                <p className="text-sm text-muted-foreground">
                  {t("admin.userDetail.statFiles", { count: files.length })},{" "}
                  {t("admin.userDetail.statFolders", { count: folders.length })}
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Card className="border-border/50">
            <CardContent className="flex items-center gap-4 p-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
                <Activity className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{activity.length}</p>
                <p className="text-sm text-muted-foreground">
                  {t("admin.userDetail.statActivity", { count: activity.length })}
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Storage Progress */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              {t("admin.userDetail.storageTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex justify-between text-sm">
              <span className="font-semibold">{formatBytes(user.usedBytes)}</span>
              <span className="text-muted-foreground">{formatBytes(user.quotaBytes)}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-muted/50">
              <motion.div
                className="h-full rounded-full bg-accent-gradient"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(storagePct, 100)}%` }}
                transition={{ duration: 1, ease: "easeOut" }}
              />
            </div>

            {/* Storage by type */}
            {storageByType.length > 0 && (
              <div className="mt-6 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("admin.userDetail.byFileType")}
                </p>
                {storageByType.map((item, idx) => (
                  <div key={item.mimeType} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{item.mimeType}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground/60">
                        {t("admin.userDetail.typeFiles", { count: item.count })}
                      </span>
                      <span className="font-mono text-xs">{formatBytes(item.totalSize)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Files & Folders */}
      <div className="grid gap-6 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="h-full border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {t("admin.userDetail.filesTitle", { count: files.length })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-80 space-y-1 overflow-auto">
                {files.slice(0, 20).map((file) => (
                  <div key={file.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-accent/5">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 shrink-0 text-accent-ink" />
                      <span className="truncate text-sm">{file.name}</span>
                      {file.isFavorite && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                    </div>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </div>
                ))}
                {files.length > 20 && (
                  <p className="text-center text-xs text-muted-foreground/60 py-2">
                    {t("admin.userDetail.moreFiles", { count: files.length - 20 })}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.35 }}
        >
          <Card className="h-full border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                {t("admin.userDetail.activityTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-80 space-y-1 overflow-auto">
                {activity.slice(0, 15).map((log) => {
                  const Icon = actionIcons[log.action] ?? Activity;
                  return (
                    <div key={log.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                        <Icon className="h-3.5 w-3.5 text-accent-ink" />
                      </div>
                      <div className="flex-1 min-w-0">
                        {/* `auditActionLabel` translates the known audit codes; unrecognised
                            ones fall back to the raw key with underscores replaced. */}
                        <span className="text-sm">{auditActionLabel(log.action, t)}</span>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        {formatDate(log.createdAt, "short")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Sessions */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
      >
        <Card className="border-border/50">
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              {t("admin.userDetail.sessionsTitle", { count: sessions.length })}
            </CardTitle>
            {sessions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-rose-600 hover:text-rose-700"
                disabled={revokingSession !== null}
                onClick={async () => {
                  if (!confirm(t("admin.userDetail.revokeAllConfirm", { name: user.username })))
                    return;
                  setRevokingSession("all");
                  try {
                    const res = await apiFetch(
                      `/api/admin/users/${user.id}/sessions?all=1`,
                      { method: "DELETE" }
                    );
                    if (!res.success) {
                      notify({
                        title: t("admin.userDetail.revokeFailed"),
                        description: res.error,
                        tone: "warning",
                      });
                      return;
                    }
                    notify({ title: t("admin.userDetail.revokeAllDone"), tone: "success" });
                    queryClient.invalidateQueries({ queryKey: ["admin-user-detail", user.id] });
                  } finally {
                    setRevokingSession(null);
                  }
                }}
              >
                {revokingSession === "all" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="h-3.5 w-3.5" />
                )}
                {t("admin.userDetail.revokeAll")}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {sessions.map((session) => {
                const Icon = session.deviceKind === "mobile" ? Smartphone : Laptop;
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border/40 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                        <Icon className="h-4 w-4 text-accent-ink" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {session.deviceLabel || t("admin.userDetail.unknownDevice")}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {session.locationLabel ? `${session.locationLabel} · ` : ""}
                          <span className="font-mono">
                            {session.ip ?? t("admin.userDetail.unknownIp")}
                          </span>
                          {session.lastActiveAt && now > 0
                            ? ` · ${t("admin.userDetail.activeAgo", { ago: relativeTime(session.lastActiveAt, now, t) })}`
                            : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="hidden text-right sm:block">
                        <p className="text-xs text-muted-foreground">
                          {formatDate(session.createdAt, "short")}
                        </p>
                        <p className="text-[10px] text-muted-foreground/60">
                          {t("admin.userDetail.expires", {
                            date: formatDate(session.expiresAt, "short"),
                          })}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-rose-500"
                        disabled={revokingSession !== null}
                        title={t("admin.userDetail.revokeOne")}
                        onClick={async () => {
                          setRevokingSession(session.id);
                          try {
                            const res = await apiFetch(
                              `/api/admin/users/${user.id}/sessions?sessionId=${encodeURIComponent(session.id)}`,
                              { method: "DELETE" }
                            );
                            if (!res.success) {
                              notify({
                                title: t("admin.userDetail.revokeFailed"),
                                description: res.error,
                                tone: "warning",
                              });
                              return;
                            }
                            notify({ title: t("admin.userDetail.revokeOneDone"), tone: "success" });
                            queryClient.invalidateQueries({ queryKey: ["admin-user-detail", user.id] });
                          } finally {
                            setRevokingSession(null);
                          }
                        }}
                      >
                        {revokingSession === session.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
              {sessions.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t("admin.userDetail.noSessions")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Edit User */}
      {editing && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
        >
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Edit className="h-4 w-4 text-muted-foreground" />
                {isOwnAccount
                  ? t("admin.userDetail.editOwnTitle")
                  : t("admin.userDetail.editTitle", { name: user.username })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-5">
                {/* Identity */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                      {t("admin.userDetail.username")}
                    </label>
                    <Input
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      placeholder={t("admin.userDetail.username")}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                      {t("admin.userDetail.email")}
                    </label>
                    <Input
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder={t("admin.userDetail.emailOptional")}
                    />
                  </div>
                </div>

                {/* Limits */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                      {t("admin.userDetail.quotaGB")}
                    </label>
                    <Input
                      type="number"
                      min={1}
                      value={form.quotaGB}
                      onChange={(e) => setForm({ ...form, quotaGB: parseInt(e.target.value) || 10 })}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground/80">
                      {t("admin.userDetail.bandwidthGB")}
                    </label>
                    <Input
                      type="number"
                      min={0}
                      value={form.bandwidthGB}
                      onChange={(e) => setForm({ ...form, bandwidthGB: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                {/* Password — single source of truth */}
                <div className="rounded-xl border border-border/40 bg-muted/10 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{t("admin.userDetail.password")}</span>
                  </div>
                  <div className="relative">
                    <Input
                      type={showPwNew ? "text" : "password"}
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder={t("admin.userDetail.passwordKeep")}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPwNew(!showPwNew)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                    >
                      {showPwNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {form.password && form.password.length < 8 && (
                    <p className="text-xs text-orange-500">{t("admin.userDetail.passwordShort")}</p>
                  )}
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.mustChangePassword}
                    onChange={(e) => setForm({ ...form, mustChangePassword: e.target.checked })}
                    className="h-4 w-4 rounded border-border"
                  />
                  {t("admin.userDetail.forceReset")}
                </label>

                {pwMsg && pwMsg.type === "error" && (
                  <p className="flex items-center gap-2 text-sm text-danger-ink">
                    <AlertCircle className="h-4 w-4" /> {pwMsg.text}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setEditing(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button onClick={saveUser} disabled={saving || (!!form.password && form.password.length < 8)}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Save className="h-4 w-4 mr-1.5" />}
                    {t("common.save")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Two-factor authentication — only when viewing your own account. Admins
          cannot enable 2FA on someone else's account (it would let them lock the
          owner out), so this control is self-service only. */}
      {isOwnAccount && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                {t("admin.userDetail.twoFactorTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TwoFactorSection enabled={!!sessionUser?.totpEnabled} />
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* 2-Step Code, same self-service rule as 2FA above: the admin per-user endpoint
          can only unlock/reset/require a change, never set a code, because a code an
          admin chose is a code the owner did not. It has to live here rather than in
          /settings — the sidebar hides that page from a master, so this is the only
          account screen they can reach. */}
      {isOwnAccount && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55 }}
        >
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Hash className="h-4 w-4 text-muted-foreground" />
                {t("admin.userDetail.stepCodeTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StepCodeSection />
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}