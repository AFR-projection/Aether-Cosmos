"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { apiFetch } from "@/shared/api/client";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { useConfirm } from "@admin/presentation/components/confirm-dialog";
import { UserSecurityPanel } from "@admin/presentation/components/user-security-panel";
import { useAdminEvents } from "@admin/presentation/hooks/use-admin-events";
import { notify } from "@/shared/lib/system/notify-store";
import {
  AdminEmpty,
  AdminHeader,
  AdminMetric,
  AdminPanel,
  Avatar,
  Check as CheckBox,
  Chip,
  IconButton,
  Meter,
  Note,
  SearchField,
  Skeleton,
  StatusDot,
  Switch,
  type Tone,
} from "@admin/presentation/components/admin-ui";
import { relativeTime, useFormat, useT, type TranslationKey } from "@/shared/lib/i18n";
import {
  UserPlus,
  Ban,
  Trash2,
  LogIn,
  Loader2,
  Search,
  Shield,
  Eye,
  Pencil,
  Save,
  X,
  Users,
  Radio,
  MailWarning,
  CheckCircle2,
  Send,
  ArrowUpDown,
  WifiOff,
  KeyRound,
  type LucideIcon,
} from "lucide-react";

/** A user counts as "online" if a live session was active within this window. */
const ONLINE_WINDOW_MS = 3 * 60 * 1000;
/** Past this, "recently here" stops being a useful thing to say. */
const IDLE_WINDOW_MS = 60 * 60 * 1000;

const GB = 1073741824;

type Verification = "active" | "unverified" | "suspended";
type Presence = "live" | "idle" | "dormant" | "never";

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  phone?: string | null;
  role: string;
  status: string;
  suspendReason?: string | null;
  mustChangePassword?: boolean;
  totpEnabled?: boolean;
  quotaBytes: number;
  usedBytes: number;
  bandwidthQuotaBytes?: number;
  bandwidthUsedBytes?: number;
  createdAt: string;
  updatedAt?: string;
  activeSessions: number;
  lastActiveAt: string | null;
  online: boolean;
  verification: Verification;
}

interface UsersStats {
  total: number;
  online: number;
  active: number;
  unverified: number;
  suspended: number;
}

type Filter = "all" | "online" | "unverified" | "suspended";
type SortBy = "online" | "recent" | "storage" | "name";

/**
 * Verification state, said once. The old page carried three different colour maps
 * for the same three states; this is the only one now, and its tones resolve
 * through the shared `[data-tone]` contract instead of raw emerald/amber/red.
 *
 * The wording is a key rather than text: the same state is read by an operator
 * working in English, Indonesian or Chinese.
 */
const VERIFICATION: Record<
  Verification,
  { labelKey: TranslationKey; tone: Tone; icon: LucideIcon }
> = {
  active: { labelKey: "admin.users.verifyActive", tone: "success", icon: CheckCircle2 },
  unverified: { labelKey: "admin.users.verifyUnverified", tone: "warning", icon: MailWarning },
  suspended: { labelKey: "admin.users.verifySuspended", tone: "danger", icon: Ban },
};

/**
 * Presence, from a live session down to one that never happened.
 */
const PRESENCE_KEYS: Record<Presence, TranslationKey> = {
  live: "admin.users.presenceLive",
  idle: "admin.users.presenceIdle",
  dormant: "admin.users.presenceDormant",
  never: "admin.users.presenceNever",
};

export default function AdminUsersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const live = useAdminEvents(["admin-users"]);
  const t = useT();
  const { formatBytes, formatDate } = useFormat();

  // Built here rather than at module scope: the labels are translated, and a
  // module-level array would have frozen whichever language loaded first.
  const sortOptions = useMemo(
    () => [
      { value: "online" as const, label: t("admin.users.sortOnline") },
      { value: "recent" as const, label: t("admin.users.sortRecent") },
      { value: "storage" as const, label: t("admin.users.sortStorage") },
      { value: "name" as const, label: t("admin.users.sortName") },
    ],
    [t]
  );

  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState({
    username: "",
    email: "",
    password: "",
    quotaGB: 10,
    mustChangePassword: false,
    bandwidthQuotaGB: 0,
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("online");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [form, setForm] = useState({ username: "", email: "", password: "", quotaGB: 10 });
  const [formError, setFormError] = useState("");
  const [formLoading, setFormLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Load default quota from admin settings
  useEffect(() => {
    apiFetch<{ defaultQuotaGB: number }>("/api/admin/settings").then((res) => {
      if (res.success && res.data?.defaultQuotaGB) {
        setForm((f) => ({ ...f, quotaGB: res.data!.defaultQuotaGB }));
      }
    });
  }, []);

  // 1s tick kept as `now` state so nothing calls Date.now() during render, while
  // presence dots + "last seen"/"updated" still stay live between fetches. Stays
  // 0 for the first second — isOnline falls back to the server's fresh snapshot.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await apiFetch<{ users: AdminUser[]; stats: UsersStats; serverTime: number }>(
        "/api/admin/users"
      );
      return {
        users: res.data?.users ?? [],
        serverTime: res.data?.serverTime ?? Date.now(),
        clientFetchedAt: Date.now(),
      };
    },
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const users = useMemo(() => data?.users ?? [], [data]);
  // Skew between server + this browser, captured at fetch — presence is judged
  // against the server clock so a wrong local clock can't fake online/offline.
  const offset = data ? data.serverTime - data.clientFetchedAt : 0;

  // Until the tick effect seeds `now`, fall back to the server's snapshot flag so
  // the first paint isn't wrong.
  const isOnline = (u: AdminUser) =>
    now === 0
      ? u.online
      : !!u.lastActiveAt && now + offset - new Date(u.lastActiveAt).getTime() < ONLINE_WINDOW_MS;

  /** Four buckets so the dot can say something more useful than on/off. */
  const presenceOf = (u: AdminUser): Presence => {
    if (isOnline(u)) return "live";
    if (!u.lastActiveAt) return "never";
    if (now === 0) return "idle";
    return now + offset - new Date(u.lastActiveAt).getTime() < IDLE_WINDOW_MS ? "idle" : "dormant";
  };

  let onlineCount = 0;
  let unverifiedCount = 0;
  let suspendedCount = 0;
  for (const u of users) {
    if (isOnline(u)) onlineCount++;
    if (u.verification === "unverified") unverifiedCount++;
    else if (u.verification === "suspended") suspendedCount++;
  }
  const counts = {
    total: users.length,
    online: onlineCount,
    unverified: unverifiedCount,
    suspended: suspendedCount,
  };
  const q = searchTerm.toLowerCase();
  const filtered = users
    .filter(
      (u) => u.username.toLowerCase().includes(q) || (u.email && u.email.toLowerCase().includes(q))
    )
    .filter((u) => {
      if (filter === "online") return isOnline(u);
      if (filter === "unverified") return u.verification === "unverified";
      if (filter === "suspended") return u.verification === "suspended";
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "recent") return +new Date(b.createdAt) - +new Date(a.createdAt);
      if (sortBy === "storage") return b.usedBytes - a.usedBytes;
      if (sortBy === "name") return a.username.localeCompare(b.username);
      // online-first (default)
      const ao = isOnline(a) ? 1 : 0;
      const bo = isOnline(b) ? 1 : 0;
      if (ao !== bo) return bo - ao;
      const al = a.lastActiveAt ? +new Date(a.lastActiveAt) : 0;
      const bl = b.lastActiveAt ? +new Date(b.lastActiveAt) : 0;
      if (al !== bl) return bl - al;
      return +new Date(b.createdAt) - +new Date(a.createdAt);
    });

  const selectableIds = filtered.filter((u) => u.role !== "master").map((u) => u.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const storage = useMemo(() => {
    let used = 0;
    let quota = 0;
    for (const u of users) {
      used += u.usedBytes;
      quota += u.quotaBytes;
    }
    return { used, quota };
  }, [users]);

  function ok(msg: string) {
    notify({ title: msg, tone: "success" });
  }
  function fail(msg: string) {
    notify({ title: msg, tone: "error" });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (selectableIds.every((id) => prev.has(id))) return new Set();
      return new Set(selectableIds);
    });
  }

  async function createUser() {
    setFormError("");
    setFormLoading(true);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.username,
          email: form.email || undefined,
          password: form.password,
          quotaBytes: form.quotaGB * GB,
        }),
      });
      if (!res.success) {
        setFormError(res.error ?? t("admin.users.createFailed"));
        return;
      }
      setShowCreate(false);
      setForm({ username: "", email: "", password: "", quotaGB: 10 });
      ok(t("admin.users.created"));
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      setFormError(t("errors.connectionFailed"));
    } finally {
      setFormLoading(false);
    }
  }

  async function suspendUser(id: string, status: "active" | "suspended", reason?: string) {
    setActionLoading(id);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({
          id,
          status,
          suspendReason:
            status === "suspended" ? reason || t("admin.users.defaultSuspendReason") : null,
        }),
      });
      if (!res.success) {
        fail(res.error ?? t("admin.users.statusFailed"));
        return;
      }
      ok(status === "suspended" ? t("admin.users.userSuspended") : t("admin.users.userActivated"));
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail(t("errors.connectionFailed"));
    } finally {
      setActionLoading(null);
    }
  }
  async function deleteUser(id: string) {
    setActionLoading(id);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "DELETE",
        body: JSON.stringify({ id, deleteData: true }),
      });
      if (!res.success) {
        fail(res.error ?? t("admin.users.deleteFailed"));
        return;
      }
      ok(t("admin.users.deleted"));
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail(t("errors.connectionFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  /** Force-activate a pending (unverified) account without waiting for the OTP. */
  async function verifyNow(user: AdminUser) {
    setActionLoading(user.id);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ id: user.id, status: "active" }),
      });
      if (!res.success) {
        fail(res.error ?? t("admin.users.verifyFailed"));
        return;
      }
      ok(t("admin.users.verified", { name: user.username }));
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail(t("errors.connectionFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  /** Re-send the OTP email to a pending account (reuses the public resend flow). */
  async function resendCode(user: AdminUser) {
    if (!user.email) {
      fail(t("admin.users.noEmail"));
      return;
    }
    setActionLoading(user.id);
    try {
      const res = await apiFetch("/api/auth/resend-otp", {
        method: "POST",
        body: JSON.stringify({ email: user.email }),
      });
      if (!res.success) {
        fail(res.error ?? t("admin.users.resendFailed"));
        return;
      }
      ok(t("admin.users.codeResent", { email: user.email }));
    } catch {
      fail(t("errors.connectionFailed"));
    } finally {
      setActionLoading(null);
    }
  }
  function runBulk(kind: "activate" | "suspend" | "delete") {
    const ids = [...selected].filter((id) => selectableIds.includes(id));
    if (ids.length === 0) return;
    // Each kind gets its own title, message and button word: a single interpolated
    // verb reads as English grammar and breaks anywhere the verb inflects.
    const copy = {
      activate: {
        title: t("admin.users.bulkActivateTitle", { count: ids.length }),
        message: t("admin.users.bulkActivateMessage"),
        confirmLabel: t("admin.users.activate"),
      },
      suspend: {
        title: t("admin.users.bulkSuspendTitle", { count: ids.length }),
        message: t("admin.users.bulkSuspendMessage"),
        confirmLabel: t("admin.users.suspend"),
      },
      delete: {
        title: t("admin.users.bulkDeleteTitle", { count: ids.length }),
        message: t("admin.users.bulkDeleteMessage"),
        confirmLabel: t("common.delete"),
      },
    }[kind];
    confirm.open(
      {
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        danger: kind !== "activate",
      },
      async () => {
        setBulkBusy(true);
        let done = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const res =
              kind === "delete"
                ? await apiFetch("/api/admin/users", {
                    method: "DELETE",
                    body: JSON.stringify({ id, deleteData: true }),
                  })
                : await apiFetch("/api/admin/users", {
                    method: "PATCH",
                    body: JSON.stringify({
                      id,
                      status: kind === "suspend" ? "suspended" : "active",
                      ...(kind === "suspend"
                        ? { suspendReason: t("admin.users.bulkSuspendReason") }
                        : {}),
                    }),
                  });
            if (res.success) done++;
            else failed++;
          } catch {
            failed++;
          }
        }
        setBulkBusy(false);
        setSelected(new Set());
        if (failed === 0) {
          ok(
            kind === "delete"
              ? t("admin.users.bulkDeleted", { count: done })
              : kind === "suspend"
                ? t("admin.users.bulkSuspended", { count: done })
                : t("admin.users.bulkActivated", { count: done })
          );
        } else {
          fail(t("admin.users.bulkPartial", { done, failed }));
        }
        queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      }
    );
  }
  function toggleSuspend(user: AdminUser) {
    if (user.status === "active") {
      confirm.open(
        {
          title: t("admin.users.suspendTitle", { name: user.username }),
          message: t("admin.users.suspendMessage"),
          confirmLabel: t("admin.users.suspendConfirm"),
          danger: true,
          reason: {
            label: t("admin.users.reasonLabel"),
            placeholder: t("admin.users.reasonPlaceholder"),
            defaultValue: t("admin.users.reasonPlaceholder"),
          },
        },
        (reason) => suspendUser(user.id, "suspended", reason)
      );
    } else {
      void suspendUser(user.id, "active");
    }
  }

  function confirmDelete(user: AdminUser) {
    confirm.open(
      {
        title: t("admin.users.deleteTitle", { name: user.username }),
        message: t("admin.users.deleteMessage"),
        confirmLabel: t("admin.users.deleteConfirm"),
        danger: true,
      },
      () => deleteUser(user.id)
    );
  }

  function startEdit(user: AdminUser) {
    setEditingUser(user);
    setEditForm({
      username: user.username,
      email: user.email ?? "",
      password: "",
      quotaGB: Math.round(user.quotaBytes / GB),
      mustChangePassword: !!user.mustChangePassword,
      bandwidthQuotaGB: Math.round((user.bandwidthQuotaBytes ?? 0) / GB),
    });
  }
  async function saveEditUser() {
    if (!editingUser) return;
    setActionLoading(editingUser.id);
    try {
      const body: Record<string, unknown> = {
        id: editingUser.id,
        username: editForm.username || undefined,
        email: editForm.email.trim() || null,
        quotaBytes: editForm.quotaGB * GB,
        mustChangePassword: editForm.mustChangePassword,
        bandwidthQuotaBytes: editForm.bandwidthQuotaGB * GB,
      };
      if (editForm.password) body.password = editForm.password;
      const res = await apiFetch("/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (!res.success) {
        fail(res.error ?? t("admin.users.updateFailed"));
        return;
      }
      ok(t("admin.users.updated"));
      setEditingUser(null);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail(t("errors.connectionFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  async function impersonate(id: string) {
    setActionLoading(id);
    try {
      const res = await apiFetch("/api/auth/impersonate", {
        method: "POST",
        body: JSON.stringify({ userId: id }),
      });
      if (!res.success) {
        fail(res.error ?? t("admin.users.impersonateFailed"));
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      fail(t("errors.connectionFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  const updatedAgo = dataUpdatedAt ? Math.max(0, Math.round((now - dataUpdatedAt) / 1000)) : 0;
  const linkState =
    live === "live"
      ? null
      : {
          label:
            live === "offline"
              ? t("admin.users.linkOffline")
              : live === "connecting"
                ? t("admin.users.linkConnecting")
                : t("admin.users.linkReconnecting"),
          tone: (live === "offline" ? "muted" : "warning") as Tone,
        };
  return (
    <div className="space-y-5">
      <AdminHeader
        icon={Users}
        kicker={t("admin.users.kicker")}
        title={t("admin.users.title")}
        lede={t("admin.users.lede")}
        live={live === "live"}
        actions={
          <>
            {linkState && (
              <Chip icon={WifiOff} tone={linkState.tone}>
                {linkState.label}
              </Chip>
            )}
            <Button
              size="sm"
              onClick={() => {
                setShowCreate((v) => !v);
                setFormError("");
              }}
              aria-expanded={showCreate}
            >
              {showCreate ? (
                <X className="h-4 w-4" aria-hidden="true" />
              ) : (
                <UserPlus className="h-4 w-4" aria-hidden="true" />
              )}
              {showCreate ? t("common.close") : t("admin.users.addUser")}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Users}
          label={t("admin.users.metricTotal")}
          value={counts.total}
          tone="accent"
          hint={t("admin.users.metricTotalHint", {
            used: formatBytes(storage.used),
            total: formatBytes(storage.quota),
          })}
          pressed={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <AdminMetric
          icon={Radio}
          label={t("admin.users.metricOnline")}
          value={counts.online}
          tone="success"
          hint={t("admin.users.metricOnlineHint")}
          pressed={filter === "online"}
          onClick={() => setFilter(filter === "online" ? "all" : "online")}
        />
        <AdminMetric
          icon={MailWarning}
          label={t("admin.users.verifyUnverified")}
          value={counts.unverified}
          tone="warning"
          hint={t("admin.users.metricUnverifiedHint")}
          pressed={filter === "unverified"}
          onClick={() => setFilter(filter === "unverified" ? "all" : "unverified")}
        />
        <AdminMetric
          icon={Ban}
          label={t("admin.users.verifySuspended")}
          value={counts.suspended}
          tone="danger"
          hint={t("admin.users.metricSuspendedHint")}
          pressed={filter === "suspended"}
          onClick={() => setFilter(filter === "suspended" ? "all" : "suspended")}
        />
      </div>
      <AnimatePresence initial={false}>
        {showCreate && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <AdminPanel
              icon={UserPlus}
              title={t("admin.users.newTitle")}
              sub={t("admin.users.newSub")}
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="grid gap-1.5">
                  <span className="adm-field__label">{t("admin.users.username")}</span>
                  <Input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder={t("admin.users.usernamePlaceholder")}
                    autoComplete="off"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="adm-field__label">{t("admin.users.email")}</span>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder={t("admin.users.emailPlaceholder")}
                    autoComplete="off"
                  />
                  <span className="adm-field__hint">{t("admin.users.emailHint")}</span>
                </label>
                <label className="grid gap-1.5">
                  <span className="adm-field__label">{t("admin.users.password")}</span>
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="adm-field__label">{t("admin.users.storageQuota")}</span>
                  <Input
                    type="number"
                    min={1}
                    value={form.quotaGB}
                    onChange={(e) => setForm({ ...form, quotaGB: parseInt(e.target.value) || 10 })}
                  />
                  <span className="adm-field__hint">{t("admin.users.gigabytes")}</span>
                </label>
              </div>
              {formError && (
                <Note icon={Ban} tone="danger" className="mt-3">
                  {formError}
                </Note>
              )}

              <div className="mt-4 flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={createUser}
                  disabled={formLoading || !form.username || !form.password}
                >
                  {formLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Shield className="h-4 w-4" aria-hidden="true" />
                  )}
                  {t("admin.users.createUser")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </AdminPanel>
          </motion.div>
        )}
      </AnimatePresence>

      {/* One bar doing two jobs: filtering when nothing is selected, bulk actions
          when something is. Same height either way, so the table never jumps. */}
      <div className="adm-toolbar" data-active={selected.size > 0}>
        {selected.size > 0 ? (
          <>
            <CheckBox
              checked
              indeterminate={!allSelected}
              onChange={() => setSelected(new Set())}
              label={t("admin.ui.clearSelection")}
            />
            <span className="text-[0.8rem] font-medium">
              {t("common.selectedCount", { count: selected.size })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => runBulk("activate")}>
                {bulkBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                )}
                {t("admin.users.activate")}
              </Button>
              <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => runBulk("suspend")}>
                <Ban className="h-4 w-4" aria-hidden="true" />
                {t("admin.users.suspend")}
              </Button>
              <Button variant="destructive" size="sm" disabled={bulkBusy} onClick={() => runBulk("delete")}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t("common.delete")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t("common.cancel")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <SearchField
              icon={Search}
              value={searchTerm}
              onChange={setSearchTerm}
              label={t("admin.users.searchLabel")}
              placeholder={t("admin.users.searchPlaceholder")}
            />
            <label className="ml-auto inline-flex items-center gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-[var(--adm-muted)]" aria-hidden="true" />
              <select
                className="adm-select adm-select--sm"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                aria-label={t("admin.users.sortLabel")}
              >
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <AdminPanel
        icon={Users}
        title={t("admin.users.panelTitle", { count: filtered.length })}
        sub={
          searchTerm.trim()
            ? t("admin.ui.matching", { query: searchTerm.trim() })
            : dataUpdatedAt
              ? t("admin.users.updatedAgo", { seconds: updatedAgo })
              : undefined
        }
        flush
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-12 w-full" rows={6} />
          </div>
        ) : filtered.length === 0 ? (
          <AdminEmpty
            icon={Users}
            title={
              users.length === 0 ? t("admin.users.emptyTitle") : t("admin.users.noMatchTitle")
            }
            body={users.length === 0 ? t("admin.users.emptyBody") : t("admin.users.noMatchBody")}
            action={
              users.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFilter("all");
                    setSearchTerm("");
                  }}
                >
                  {t("admin.ui.clearFilters")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }}>
                    <CheckBox
                      checked={allSelected}
                      indeterminate={selected.size > 0}
                      onChange={toggleSelectAll}
                      label={
                        allSelected ? t("admin.users.deselectAll") : t("admin.users.selectAll")
                      }
                      disabled={selectableIds.length === 0}
                    />
                  </th>
                  <th>{t("admin.users.colUser")}</th>
                  <th>{t("admin.users.colStatus")}</th>
                  <th>{t("admin.users.colPresence")}</th>
                  <th>{t("admin.users.colStorage")}</th>
                  <th style={{ width: "15rem" }} className="text-right">
                    {t("common.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>{filtered.map((user) => renderRow(user))}</tbody>
            </table>
          </div>
        )}
      </AdminPanel>
      <AnimatePresence>
        {editingUser && (
          <div
            className="scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center"
            role="presentation"
            onClick={() => setEditingUser(null)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="edit-user-title"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="adm-sheet my-auto max-w-lg"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="adm-sheet__head">
                <Avatar
                  name={editingUser.username}
                  presence={presenceOf(editingUser)}
                  master={editingUser.role === "master"}
                />
                <div className="min-w-0 flex-1">
                  <h2 id="edit-user-title" className="adm-panel__title">
                    {editingUser.username}
                  </h2>
                  <p className="adm-panel__sub">
                    {t("admin.users.joined", {
                      date: formatDate(editingUser.createdAt, "short"),
                    })}{" "}
                    · {editingUser.email ?? t("admin.users.noEmailOnFile")}
                  </p>
                </div>
                <IconButton
                  icon={X}
                  label={t("admin.users.closeEditor")}
                  onClick={() => setEditingUser(null)}
                />
              </div>

              <div className="adm-sheet__body">
                <label className="adm-field">
                  <span className="adm-field__label">{t("admin.users.username")}</span>
                  <Input
                    value={editForm.username}
                    onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                    placeholder={t("admin.users.username")}
                  />
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">{t("admin.users.email")}</span>
                  <Input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    placeholder={t("admin.users.emailOptional")}
                  />
                  <span className="adm-field__hint">{t("admin.users.emailClearHint")}</span>
                </label>

                <label className="adm-field">
                  <span className="adm-field__label">{t("admin.users.newPassword")}</span>
                  <Input
                    type="password"
                    value={editForm.password}
                    onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                    placeholder={t("admin.users.passwordKeep")}
                    autoComplete="new-password"
                  />
                </label>

                <div className="adm-field">
                  <span className="adm-field__label">{t("admin.users.quotas")}</span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="adm-field__hint">{t("admin.users.storageGB")}</span>
                      <Input
                        type="number"
                        min={1}
                        value={editForm.quotaGB}
                        onChange={(e) =>
                          setEditForm({ ...editForm, quotaGB: parseInt(e.target.value) || 10 })
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="adm-field__hint">{t("admin.users.bandwidthGB")}</span>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.bandwidthQuotaGB}
                        onChange={(e) =>
                          setEditForm({ ...editForm, bandwidthQuotaGB: parseInt(e.target.value) || 0 })
                        }
                      />
                    </label>
                  </div>
                </div>
                <div className="adm-field">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="adm-field__label block">{t("admin.users.forceReset")}</span>
                      <span className="adm-field__hint">{t("admin.users.forceResetHint")}</span>
                    </span>
                    <Switch
                      checked={editForm.mustChangePassword}
                      onChange={(checked) =>
                        setEditForm({ ...editForm, mustChangePassword: checked })
                      }
                      label={t("admin.users.forceResetSwitch")}
                    />
                  </div>
                </div>

                <div className="adm-field">
                  <span className="adm-field__label">
                    <KeyRound className="mr-1 inline h-3.5 w-3.5 align-[-0.15em]" aria-hidden="true" />
                    {t("admin.users.loginSecurity")}
                  </span>
                  <UserSecurityPanel userId={editingUser.id} />
                </div>
              </div>

              <div className="adm-sheet__foot">
                <Button variant="ghost" size="sm" onClick={() => setEditingUser(null)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={saveEditUser} disabled={actionLoading === editingUser.id}>
                  {actionLoading === editingUser.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Save className="h-4 w-4" aria-hidden="true" />
                  )}
                  {t("admin.users.saveChanges")}
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {confirm.element}
    </div>
  );
  function renderRow(user: AdminUser) {
    const isBusy = actionLoading === user.id;
    const presence = presenceOf(user);
    const online = presence === "live";
    const selectable = user.role !== "master";
    const verification = VERIFICATION[user.verification];
    const ratio = user.quotaBytes > 0 ? user.usedBytes / user.quotaBytes : 0;
    // Presence maths runs on the server clock; a wrong local clock must not
    // rewrite "last seen".
    const clock = now === 0 ? 0 : now + offset;

    return (
      <tr key={user.id} data-selected={selected.has(user.id)}>
        <td>
          {selectable ? (
            <CheckBox
              checked={selected.has(user.id)}
              onChange={() => toggleSelect(user.id)}
              label={t("admin.users.selectOne", { name: user.username })}
            />
          ) : (
            <span className="adm-sub" title={t("admin.users.masterExcluded")}>
              —
            </span>
          )}
        </td>

        <td>
          <div className="flex items-center gap-2.5">
            <Avatar name={user.username} presence={presence} master={user.role === "master"} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="max-w-[11rem] truncate font-medium">{user.username}</span>
                {user.role === "master" && <Chip tone="warning">master</Chip>}
                {user.totpEnabled && (
                  <Chip tone="info" mono>
                    2FA
                  </Chip>
                )}
              </div>
              <div className="adm-sub max-w-[14rem] truncate">{user.email ?? "—"}</div>
            </div>
          </div>
        </td>
        <td>
          <Chip icon={verification.icon} tone={verification.tone}>
            {t(verification.labelKey)}
          </Chip>
          {user.verification === "suspended" && user.suspendReason && (
            <div className="adm-sub mt-1 max-w-[11rem] truncate" title={user.suspendReason}>
              {user.suspendReason}
            </div>
          )}
          {user.mustChangePassword && (
            <div className="adm-sub mt-1">{t("admin.users.mustReset")}</div>
          )}
        </td>

        <td>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[0.78rem] font-medium">
            <StatusDot presence={presence} ring={online} />
            {t(PRESENCE_KEYS[presence])}
          </span>
          <div className="adm-sub">
            {online
              ? t("admin.users.deviceCount", { count: Math.max(1, user.activeSessions) })
              : user.lastActiveAt
                ? // Before the tick effect seeds the clock there is nothing true to say.
                  clock === 0
                  ? "—"
                  : relativeTime(user.lastActiveAt, clock, t)
                : t("admin.users.joined", { date: formatDate(user.createdAt, "short") })}
          </div>
        </td>

        <td>
          <div className="whitespace-nowrap">
            <span className="adm-num text-[0.78rem]">{formatBytes(user.usedBytes)}</span>
            <span className="adm-sub"> / {formatBytes(user.quotaBytes)}</span>
          </div>
          <Meter className="mt-1.5 w-20" value={ratio} tone={ratio >= 0.9 ? "danger" : "accent"} />
        </td>
        <td>
          <div className="flex items-center justify-end gap-1">
            {user.verification === "unverified" && (
              <>
                <IconButton
                  icon={isBusy ? Loader2 : CheckCircle2}
                  tone="success"
                  label={t("admin.users.verifyAction", { name: user.username })}
                  disabled={isBusy}
                  onClick={() => verifyNow(user)}
                  className={isBusy ? "[&>svg]:animate-spin" : undefined}
                />
                {user.email && (
                  <IconButton
                    icon={Send}
                    tone="info"
                    label={t("admin.users.resendAction", { name: user.username })}
                    disabled={isBusy}
                    onClick={() => resendCode(user)}
                  />
                )}
              </>
            )}
            <IconButton
              icon={Eye}
              label={t("admin.users.openDetail", { name: user.username })}
              onClick={() => router.push(`/admin/users/${user.id}`)}
            />
            <IconButton
              icon={Pencil}
              tone="accent"
              label={t("admin.users.editAction", { name: user.username })}
              onClick={() => startEdit(user)}
            />
            {selectable && (
              <>
                <IconButton
                  icon={LogIn}
                  tone="accent"
                  label={t("admin.users.impersonateAction", { name: user.username })}
                  disabled={isBusy}
                  onClick={() => impersonate(user.id)}
                />
                <IconButton
                  icon={Ban}
                  tone="warning"
                  label={
                    user.status === "active"
                      ? t("admin.users.suspendAction", { name: user.username })
                      : t("admin.users.reactivateAction", { name: user.username })
                  }
                  disabled={isBusy}
                  onClick={() => toggleSuspend(user)}
                />
                <IconButton
                  icon={Trash2}
                  tone="danger"
                  label={t("admin.users.deleteAction", { name: user.username })}
                  disabled={isBusy}
                  onClick={() => confirmDelete(user)}
                />
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }
}
