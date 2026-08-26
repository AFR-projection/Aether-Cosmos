"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { apiFetch } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/admin/confirm-dialog";
import { UserSecurityPanel } from "@/components/admin/user-security-panel";
import { useAdminEvents } from "@/hooks/use-admin-events";
import { notify } from "@/lib/system/notify-store";
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
} from "@/components/admin/admin-ui";
import { formatBytes, formatDate } from "@/lib/utils";
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
 */
const VERIFICATION: Record<Verification, { label: string; tone: Tone; icon: LucideIcon }> = {
  active: { label: "Active", tone: "success", icon: CheckCircle2 },
  unverified: { label: "Unverified", tone: "warning", icon: MailWarning },
  suspended: { label: "Suspended", tone: "danger", icon: Ban },
};

const PRESENCE_LABEL: Record<Presence, string> = {
  live: "Online",
  idle: "Recently here",
  dormant: "Away",
  never: "Never signed in",
};

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "online", label: "Online first" },
  { value: "recent", label: "Newest" },
  { value: "storage", label: "Storage used" },
  { value: "name", label: "Name (A–Z)" },
];

/** Pure relative time — the page already ticks `now`, so nothing needs Date.now(). */
function relTime(dateStr: string, now: number): string {
  if (now === 0) return "—";
  const diffSec = Math.max(0, Math.floor((now - new Date(dateStr).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

export default function AdminUsersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const live = useAdminEvents(["admin-users"]);

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
        setFormError(res.error ?? "Failed to create user");
        return;
      }
      setShowCreate(false);
      setForm({ username: "", email: "", password: "", quotaGB: 10 });
      ok("User created successfully");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      setFormError("Connection failed");
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
          suspendReason: status === "suspended" ? reason || "Suspended by administrator" : null,
        }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to update status");
        return;
      }
      ok(`User ${status === "suspended" ? "suspended" : "activated"}`);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
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
        fail(res.error ?? "Failed to delete user");
        return;
      }
      ok("User deleted");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
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
        fail(res.error ?? "Failed to verify user");
        return;
      }
      ok(`${user.username} verified & activated`);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  /** Re-send the OTP email to a pending account (reuses the public resend flow). */
  async function resendCode(user: AdminUser) {
    if (!user.email) {
      fail("This user has no email on file");
      return;
    }
    setActionLoading(user.id);
    try {
      const res = await apiFetch("/api/auth/resend-otp", {
        method: "POST",
        body: JSON.stringify({ email: user.email }),
      });
      if (!res.success) {
        fail(res.error ?? "Failed to resend code");
        return;
      }
      ok(`Verification code resent to ${user.email}`);
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }
  function runBulk(kind: "activate" | "suspend" | "delete") {
    const ids = [...selected].filter((id) => selectableIds.includes(id));
    if (ids.length === 0) return;
    const verb = kind === "activate" ? "Activate" : kind === "suspend" ? "Suspend" : "Delete";
    confirm.open(
      {
        title: `${verb} ${ids.length} user${ids.length > 1 ? "s" : ""}?`,
        message:
          kind === "delete"
            ? "This permanently deletes the selected users and all their files. This cannot be undone."
            : kind === "suspend"
              ? "The selected users will be signed out and blocked from logging in until reactivated."
              : "The selected users will be activated (and any pending accounts verified).",
        confirmLabel: verb,
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
                        ? { suspendReason: "Bulk suspended by administrator" }
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
        if (failed === 0) ok(`${done} user${done > 1 ? "s" : ""} ${kind}d`);
        else fail(`${done} succeeded, ${failed} failed`);
        queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      }
    );
  }
  function toggleSuspend(user: AdminUser) {
    if (user.status === "active") {
      confirm.open(
        {
          title: `Suspend ${user.username}?`,
          message: "The user will be signed out and blocked from logging in until reactivated.",
          confirmLabel: "Suspend user",
          danger: true,
          reason: {
            label: "Reason (shown to the user on login)",
            placeholder: "Policy violation",
            defaultValue: "Policy violation",
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
        title: `Delete ${user.username}?`,
        message: "This permanently deletes the user and all their files. This cannot be undone.",
        confirmLabel: "Delete permanently",
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
        fail(res.error ?? "Failed to update user");
        return;
      }
      ok("User updated successfully");
      setEditingUser(null);
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch {
      fail("Connection failed");
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
        fail(res.error ?? "Failed to impersonate");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      fail("Connection failed");
    } finally {
      setActionLoading(null);
    }
  }

  const updatedAgo = dataUpdatedAt ? Math.max(0, Math.round((now - dataUpdatedAt) / 1000)) : 0;
  const linkState =
    live === "live"
      ? null
      : {
          label: live === "offline" ? "Realtime offline" : live === "connecting" ? "Connecting…" : "Reconnecting…",
          tone: (live === "offline" ? "muted" : "warning") as Tone,
        };
  return (
    <div className="space-y-5">
      <AdminHeader
        icon={Users}
        kicker="Accounts"
        title="Users"
        lede="Everyone with a login, online first. The tiles below are the filter — tap one to narrow the table, tap it again to clear it."
        live={live === "live"}
        liveLabel="Live"
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
              {showCreate ? "Close" : "Add user"}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetric
          icon={Users}
          label="Total"
          value={counts.total}
          tone="accent"
          hint={`${formatBytes(storage.used)} of ${formatBytes(storage.quota)} allocated`}
          pressed={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <AdminMetric
          icon={Radio}
          label="Online now"
          value={counts.online}
          tone="success"
          hint="Seen in the last 3 minutes"
          pressed={filter === "online"}
          onClick={() => setFilter(filter === "online" ? "all" : "online")}
        />
        <AdminMetric
          icon={MailWarning}
          label="Unverified"
          value={counts.unverified}
          tone="warning"
          hint="Waiting on an email code"
          pressed={filter === "unverified"}
          onClick={() => setFilter(filter === "unverified" ? "all" : "unverified")}
        />
        <AdminMetric
          icon={Ban}
          label="Suspended"
          value={counts.suspended}
          tone="danger"
          hint="Blocked from signing in"
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
            <AdminPanel icon={UserPlus} title="New account" sub="The user signs in immediately; no email is sent.">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="grid gap-1.5">
                  <span className="adm-field__label">Username</span>
                  <Input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder="jane.doe"
                    autoComplete="off"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="adm-field__label">Email</span>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="jane@example.com"
                    autoComplete="off"
                  />
                  <span className="adm-field__hint">Optional — needed for password resets.</span>
                </label>
                <label className="grid gap-1.5">
                  <span className="adm-field__label">Password</span>
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="••••••••"
                    autoComplete="new-password"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="adm-field__label">Storage quota</span>
                  <Input
                    type="number"
                    min={1}
                    value={form.quotaGB}
                    onChange={(e) => setForm({ ...form, quotaGB: parseInt(e.target.value) || 10 })}
                  />
                  <span className="adm-field__hint">Gigabytes.</span>
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
                  Create user
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
                  Cancel
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
              label="Clear selection"
            />
            <span className="text-[0.8rem] font-medium">
              <span className="adm-num">{selected.size}</span> selected
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => runBulk("activate")}>
                {bulkBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                )}
                Activate
              </Button>
              <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => runBulk("suspend")}>
                <Ban className="h-4 w-4" aria-hidden="true" />
                Suspend
              </Button>
              <Button variant="destructive" size="sm" disabled={bulkBusy} onClick={() => runBulk("delete")}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <SearchField
              icon={Search}
              value={searchTerm}
              onChange={setSearchTerm}
              label="Search users"
              placeholder="Username or email…"
            />
            <label className="ml-auto inline-flex items-center gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-[var(--adm-muted)]" aria-hidden="true" />
              <select
                className="adm-select adm-select--sm"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                aria-label="Sort users"
              >
                {SORT_OPTIONS.map((option) => (
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
        title={`${filtered.length} user${filtered.length !== 1 ? "s" : ""}`}
        sub={
          searchTerm.trim()
            ? `Matching “${searchTerm.trim()}”`
            : dataUpdatedAt
              ? `Updated ${updatedAgo}s ago`
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
            title={users.length === 0 ? "No accounts yet" : "Nothing matches that filter"}
            body={
              users.length === 0
                ? "Create the first account and it will appear here with its quota, presence and session count."
                : "Try a different name or email, or clear the tile filter above."
            }
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
                  Clear filters
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
                      label={allSelected ? "Deselect all users" : "Select all users"}
                      disabled={selectableIds.length === 0}
                    />
                  </th>
                  <th>User</th>
                  <th>Status</th>
                  <th>Presence</th>
                  <th>Storage</th>
                  <th style={{ width: "15rem" }} className="text-right">
                    Actions
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
                    Joined {formatDate(editingUser.createdAt, "short")} ·{" "}
                    {editingUser.email ?? "no email on file"}
                  </p>
                </div>
                <IconButton icon={X} label="Close editor" onClick={() => setEditingUser(null)} />
              </div>

              <div className="adm-sheet__body">
                <label className="adm-field">
                  <span className="adm-field__label">Username</span>
                  <Input
                    value={editForm.username}
                    onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                    placeholder="Username"
                  />
                </label>
                <label className="adm-field">
                  <span className="adm-field__label">Email</span>
                  <Input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    placeholder="Email (optional)"
                  />
                  <span className="adm-field__hint">
                    Clearing this removes the account&apos;s only password-reset route.
                  </span>
                </label>

                <label className="adm-field">
                  <span className="adm-field__label">New password</span>
                  <Input
                    type="password"
                    value={editForm.password}
                    onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                    placeholder="Leave blank to keep the current one"
                    autoComplete="new-password"
                  />
                </label>

                <div className="adm-field">
                  <span className="adm-field__label">Quotas</span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="adm-field__hint">Storage (GB)</span>
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
                      <span className="adm-field__hint">Bandwidth / month (0 = unlimited)</span>
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
                      <span className="adm-field__label block">Force password reset</span>
                      <span className="adm-field__hint">
                        The next sign-in stops at a change-password screen.
                      </span>
                    </span>
                    <Switch
                      checked={editForm.mustChangePassword}
                      onChange={(checked) =>
                        setEditForm({ ...editForm, mustChangePassword: checked })
                      }
                      label="Force password reset on next login"
                    />
                  </div>
                </div>

                <div className="adm-field">
                  <span className="adm-field__label">
                    <KeyRound className="mr-1 inline h-3.5 w-3.5 align-[-0.15em]" aria-hidden="true" />
                    Login security
                  </span>
                  <UserSecurityPanel userId={editingUser.id} />
                </div>
              </div>

              <div className="adm-sheet__foot">
                <Button variant="ghost" size="sm" onClick={() => setEditingUser(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveEditUser} disabled={actionLoading === editingUser.id}>
                  {actionLoading === editingUser.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Save className="h-4 w-4" aria-hidden="true" />
                  )}
                  Save changes
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
              label={`Select ${user.username}`}
            />
          ) : (
            <span className="adm-sub" title="Master accounts are excluded from bulk actions">
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
            {verification.label}
          </Chip>
          {user.verification === "suspended" && user.suspendReason && (
            <div className="adm-sub mt-1 max-w-[11rem] truncate" title={user.suspendReason}>
              {user.suspendReason}
            </div>
          )}
          {user.mustChangePassword && <div className="adm-sub mt-1">Must reset password</div>}
        </td>

        <td>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[0.78rem] font-medium">
            <StatusDot presence={presence} ring={online} />
            {PRESENCE_LABEL[presence]}
          </span>
          <div className="adm-sub">
            {online
              ? `${Math.max(1, user.activeSessions)} device${Math.max(1, user.activeSessions) > 1 ? "s" : ""}`
              : user.lastActiveAt
                ? relTime(user.lastActiveAt, clock)
                : `Joined ${formatDate(user.createdAt, "short")}`}
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
                  label={`Verify and activate ${user.username}`}
                  disabled={isBusy}
                  onClick={() => verifyNow(user)}
                  className={isBusy ? "[&>svg]:animate-spin" : undefined}
                />
                {user.email && (
                  <IconButton
                    icon={Send}
                    tone="info"
                    label={`Resend the verification code to ${user.username}`}
                    disabled={isBusy}
                    onClick={() => resendCode(user)}
                  />
                )}
              </>
            )}
            <IconButton
              icon={Eye}
              label={`Open ${user.username}'s detail page`}
              onClick={() => router.push(`/admin/users/${user.id}`)}
            />
            <IconButton
              icon={Pencil}
              tone="accent"
              label={`Edit ${user.username}`}
              onClick={() => startEdit(user)}
            />
            {selectable && (
              <>
                <IconButton
                  icon={LogIn}
                  tone="accent"
                  label={`Sign in as ${user.username}`}
                  disabled={isBusy}
                  onClick={() => impersonate(user.id)}
                />
                <IconButton
                  icon={Ban}
                  tone="warning"
                  label={user.status === "active" ? `Suspend ${user.username}` : `Reactivate ${user.username}`}
                  disabled={isBusy}
                  onClick={() => toggleSuspend(user)}
                />
                <IconButton
                  icon={Trash2}
                  tone="danger"
                  label={`Delete ${user.username}`}
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
